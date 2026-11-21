package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/backend/api"
)

// AuthReject.feature
func TestAuthReject(t *testing.T) {
	reset(t)
	unsigned := func(claims string) string { // what the emulator issues: alg none, no signature
		enc := base64.RawURLEncoding.EncodeToString
		return enc([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + enc([]byte(claims)) + "."
	}
	for name, token := range map[string]string{
		"Missing token is rejected":                            "",
		"Invalid token is rejected":                            "garbage",
		"A token for another Firebase project is rejected":     unsigned(`{"iss":"https://securetoken.google.com/other","aud":"other","sub":"u1","iat":1,"exp":9999999999}`),
		"An expired token is rejected":                         unsigned(`{"iss":"https://securetoken.google.com/demo-streamiq","aud":"demo-streamiq","sub":"u1","iat":1,"exp":2}`),
		"A token for a user the issuer never made is rejected": unsigned(`{"iss":"https://securetoken.google.com/demo-streamiq","aud":"demo-streamiq","sub":"never-made","iat":1,"exp":9999999999}`),
	} {
		t.Run(name, func(t *testing.T) {
			if rs := request(t, "GET", "/api/me", token, nil); rs.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rs.StatusCode)
			}
		})
	}
	if n := scalar[int](t, `SELECT count(*) FROM users`); n != 0 {
		t.Fatalf("%d users provisioned by rejected tokens", n)
	}
}

// Provisioning.feature, first scenario, plus the race of concurrent first sign-ins.
func TestFirstSignInProvisionsOneUserAndNoHousehold(t *testing.T) {
	reset(t)
	token := mint(t, "fresh@home.test")
	var wg sync.WaitGroup
	ids := make([]string, 20)
	for i := range ids {
		wg.Go(func() {
			rs := request(t, "GET", "/api/me", token, nil)
			if rs.StatusCode == http.StatusOK {
				me := decode[api.Me](t, rs)
				if me.TenantID == nil && len(me.Memberships) == 0 {
					ids[i] = me.UserID
				}
			}
		})
	}
	wg.Wait()
	for _, id := range ids {
		if id == "" || id != ids[0] {
			t.Fatalf("20 concurrent first requests gave user ids %v", ids)
		}
	}
	if users, tenants := scalar[int](t, `SELECT count(*) FROM users`), scalar[int](t, `SELECT count(*) FROM tenants`); users != 1 || tenants != 0 {
		t.Fatalf("%d users, %d tenants; want 1 and 0", users, tenants)
	}
}

func listGateways(t *testing.T, u *user, headers ...string) []api.Gateway {
	t.Helper()
	rs := request(t, "GET", "/api/gateways", u.token, nil, headers...)
	if rs.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/gateways: %s", rs.Status)
	}
	return decode[[]api.Gateway](t, rs)
}

func seedGateway(t *testing.T, u *user, name string) string {
	t.Helper()
	return scalar[string](t, `INSERT INTO gateways ("Id", "TenantId", "Name", "CredentialHash") VALUES (uuidv7(), $1, $2, $3) RETURNING "Id"`,
		u.household, name, "seeded-"+name)
}

// Gateways/TenantIsolation.feature
func TestTenantIsolation(t *testing.T) {
	t.Run("A tenant cannot see another tenant's gateway", func(t *testing.T) {
		reset(t)
		seedGateway(t, owning(t, "alice@home.test"), "alice-nas")
		if list := listGateways(t, owning(t, "bob@home.test")); len(list) != 0 {
			t.Fatalf("bob sees %v", list)
		}
	})
	t.Run("A tenant sees its own gateway", func(t *testing.T) {
		reset(t)
		carol := owning(t, "carol@home.test")
		seedGateway(t, carol, "carol-nas")
		if list := listGateways(t, carol); len(list) != 1 || *list[0].Name != "carol-nas" {
			t.Fatalf("carol sees %v", list)
		}
	})
	t.Run("Naming another household is a 404, the same as one that doesn't exist", func(t *testing.T) {
		reset(t)
		alice, bob := owning(t, "alice@home.test"), owning(t, "bob@home.test")
		seedGateway(t, alice, "alice-nas")
		for _, household := range []string{alice.household, "018f0000-0000-7000-8000-000000000000", "not-a-uuid"} {
			rs := request(t, "GET", "/api/gateways", bob.token, nil, householdHeader, household)
			if rs.StatusCode != http.StatusNotFound || rs.Header.Get(notMemberHeader) != "1" {
				t.Fatalf("household %s: %s", household, rs.Status)
			}
		}
	})
	t.Run("A user in no household gets the not-a-member 404", func(t *testing.T) {
		reset(t)
		if rs := request(t, "GET", "/api/gateways", signIn(t, "nobody@home.test").token, nil); rs.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %s", rs.Status)
		}
	})
}

// What row-level security itself guarantees, below any handler: every query here is
// raw SQL without a WHERE on the tenant, through the API's own role.
func TestRowLevelSecurity(t *testing.T) {
	reset(t)
	ctx := context.Background()
	alice, bob := owning(t, "alice@home.test"), owning(t, "bob@home.test")
	aliceNAS := seedGateway(t, alice, "alice-nas")
	seedGateway(t, bob, "bob-nas")
	db := srv.db
	names := func(q interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	}) []string {
		rows, _ := q.Query(ctx, `SELECT "Name" FROM gateways ORDER BY "Name"`)
		out, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	inTenant := func(tenant string, sql string, args ...any) (affected int64, err error) {
		err = db.InTenant(ctx, tenant, func(tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, sql, args...)
			affected = tag.RowsAffected()
			return err
		})
		return affected, err
	}

	t.Run("a query with no tenant set returns no rows (fail closed)", func(t *testing.T) {
		if got := names(db.NoTenant()); len(got) != 0 {
			t.Fatalf("saw %v", got)
		}
		for _, table := range []string{"memberships", "gateways", "enrollment_tokens", "invites", "tunnels", "gateway_health"} {
			var n int
			if err := db.NoTenant().QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil || n != 0 {
				t.Fatalf("%s: %d rows, %v", table, n, err)
			}
		}
	})
	t.Run("a raw query without WHERE tenant_id sees only its own household's rows", func(t *testing.T) {
		_ = db.InTenant(ctx, bob.household, func(tx pgx.Tx) error {
			if got := names(tx); len(got) != 1 || got[0] != "bob-nas" {
				t.Fatalf("bob's transaction saw %v", got)
			}
			return nil
		})
	})
	t.Run("a write can't reach another household's rows", func(t *testing.T) {
		if n, err := inTenant(bob.household, `UPDATE gateways SET "Name" = 'pwned'`); err != nil || n != 1 {
			t.Fatalf("unfiltered UPDATE changed %d rows, %v; want bob's 1", n, err)
		}
		if n, err := inTenant(bob.household, `DELETE FROM gateways WHERE "Id" = $1`, aliceNAS); err != nil || n != 0 {
			t.Fatalf("DELETE of alice's gateway: %d rows, %v", n, err)
		}
		if got := scalar[string](t, `SELECT "Name" FROM gateways WHERE "Id" = $1`, aliceNAS); got != "alice-nas" {
			t.Fatalf("alice's gateway is now %q", got)
		}
	})
	t.Run("a row can't be written into another household", func(t *testing.T) {
		_, err := inTenant(bob.household, `INSERT INTO gateways ("Id", "TenantId", "Name") VALUES (uuidv7(), $1, 'planted')`, alice.household)
		if err == nil || !strings.Contains(err.Error(), "row-level security") {
			t.Fatalf("INSERT into alice's household: %v", err)
		}
		_, err = inTenant(bob.household, `UPDATE gateways SET "TenantId" = $1`, alice.household)
		if err == nil || !strings.Contains(err.Error(), "row-level security") {
			t.Fatalf("moving a row into alice's household: %v", err)
		}
	})
	t.Run("the tenant doesn't survive on a pooled connection", func(t *testing.T) {
		one, err := pgxpool.New(ctx, appURL+"?pool_max_conns=1") // every query below shares one connection
		if err != nil {
			t.Fatal(err)
		}
		defer one.Close()
		d := &DB{one}
		_ = d.InTenant(ctx, alice.household, func(tx pgx.Tx) error {
			if got := names(tx); len(got) != 1 {
				t.Fatalf("alice's transaction saw %v", got)
			}
			return nil
		})
		if got := names(one); len(got) != 0 {
			t.Fatalf("after alice's transaction the same connection saw %v", got)
		}
		_ = d.InTenant(ctx, alice.household, func(tx pgx.Tx) error { return context.Canceled }) // a rolled-back one too
		if got := names(one); len(got) != 0 {
			t.Fatalf("after a rollback the same connection saw %v", got)
		}
	})
	t.Run("the API's role can't switch RLS off or become the owner", func(t *testing.T) {
		// Each in a transaction that is rolled back: nothing may stick to the pooled connection.
		for _, steps := range [][]string{
			{`ALTER TABLE gateways DISABLE ROW LEVEL SECURITY`},
			{`SET LOCAL row_security = off`, `SELECT * FROM gateways`},
			{`SET LOCAL ROLE postgres`},
			{`DROP POLICY tenant ON gateways`},
			{`SELECT * FROM schema_migrations`},
		} {
			tx, err := db.NoTenant().Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, sql := range steps {
				_, err = tx.Exec(ctx, sql)
			}
			_ = tx.Rollback(ctx)
			if err == nil {
				t.Fatalf("%v: allowed", steps)
			}
		}
	})
	t.Run("the lookups that establish the tenant return only what their secret or user entitles to", func(t *testing.T) {
		var n int
		_ = db.NoTenant().QueryRow(ctx, `SELECT count(*) FROM gateway_by_credential('no-such-hash')`).Scan(&n)
		if n != 0 {
			t.Fatal("an unknown credential found a gateway")
		}
		_ = db.NoTenant().QueryRow(ctx, `SELECT count(*) FROM memberships_of($1)`, bob.id).Scan(&n)
		if n != 1 {
			t.Fatalf("bob has %d memberships", n)
		}
	})
	t.Run("the tables' owner bypasses every policy (why the API is not the owner)", func(t *testing.T) {
		if n := scalar[int](t, `SELECT count(*) FROM gateways`); n != 2 {
			t.Fatalf("owner saw %d gateways", n)
		}
	})
}

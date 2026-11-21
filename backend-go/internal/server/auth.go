package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
	"github.com/jackc/pgx/v5"
	"google.golang.org/api/option"

	"streamiq/backend/api"
)

const (
	householdHeader = "X-StreamIQ-Household"
	notMemberHeader = "X-StreamIQ-Not-Member"
)

// NewVerifier builds the one ID-token verifier, for dev and prod alike: with
// FIREBASE_AUTH_EMULATOR_HOST set the SDK skips the signature, nothing here branches.
// The emulator accepts unsigned tokens, so it needs STREAMIQ_ENV=development.
func NewVerifier(ctx context.Context) (*fbauth.Client, error) {
	project := os.Getenv("FIREBASE_PROJECT_ID")
	emulator := os.Getenv("FIREBASE_AUTH_EMULATOR_HOST") != ""
	serviceAccount := strings.TrimSpace(os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON"))
	switch {
	case project == "":
		return nil, errors.New("FIREBASE_PROJECT_ID is not set")
	case emulator && os.Getenv("STREAMIQ_ENV") != "development":
		return nil, errors.New("FIREBASE_AUTH_EMULATOR_HOST is set outside STREAMIQ_ENV=development")
	case !emulator && strings.HasPrefix(project, "demo-"):
		return nil, fmt.Errorf("FIREBASE_PROJECT_ID is %q, a demo project, but no emulator host is set", project)
	case !emulator && serviceAccount == "":
		return nil, errors.New("FIREBASE_SERVICE_ACCOUNT_JSON is empty (and no emulator host set)")
	}
	var opts []option.ClientOption
	if !emulator {
		opts = append(opts, option.WithCredentialsJSON([]byte(serviceAccount)))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: project}, opts...)
	if err != nil {
		return nil, err
	}
	return app.Auth(ctx)
}

// provision resolves the users row of a Firebase UID, adding it on first sign-in.
// Concurrent first requests: ON CONFLICT lets one insert win and the others read it.
func (s *Server) provision(ctx context.Context, uid string) (string, error) {
	var id string
	err := s.db.NoTenant().QueryRow(ctx, `SELECT "Id" FROM users WHERE "FirebaseUid" = $1`, uid).Scan(&id)
	if !errors.Is(err, pgx.ErrNoRows) {
		return id, err
	}
	if _, err := s.db.NoTenant().Exec(ctx,
		`INSERT INTO users ("Id", "FirebaseUid") VALUES (uuidv7(), $1) ON CONFLICT ("FirebaseUid") DO NOTHING`, uid); err != nil {
		return "", err
	}
	return id, s.db.NoTenant().QueryRow(ctx, `SELECT "Id" FROM users WHERE "FirebaseUid" = $1`, uid).Scan(&id)
}

// signIn verifies an ID token and returns the user's id (users.id).
func (s *Server) signIn(ctx context.Context, idToken string) (string, error) {
	t, err := s.verifier.VerifyIDToken(ctx, idToken)
	if err != nil {
		return "", err
	}
	return s.provision(ctx, t.UID)
}

// households lists the user's households, oldest first: the one place that reads
// memberships across tenants (the tenant isn't known yet), always for one user.
func (s *Server) households(ctx context.Context, user string) ([]api.Household, error) {
	rows, _ := s.db.NoTenant().Query(ctx, `SELECT tenant_id, name, role FROM memberships_of($1)`, user)
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (h api.Household, err error) {
		return h, r.Scan(&h.ID, &h.Name, &h.Role)
	})
}

// pick is the user's membership in tenant ("" = their oldest); nil = not a member.
func pick(all []api.Household, tenant string) *api.Household {
	for i := range all {
		if tenant == "" || strings.EqualFold(all[i].ID, tenant) {
			return &all[i]
		}
	}
	return nil
}

// caller is who a request acts as. Tenant and Role are empty for a user in no
// household (only endpoints that pass optional get that far).
type caller struct {
	User, Tenant, Role string
	Households         []api.Household
}

// authed wraps a handler: Bearer ID token → user → the household the request names
// (else the oldest). The tenant only ever comes from one of the user's memberships.
// A household the user can't use is the same 404 as one that doesn't exist.
func (s *Server) authed(optional bool, h func(http.ResponseWriter, *http.Request, caller)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if !strings.EqualFold(scheme, "Bearer") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		user, err := s.signIn(r.Context(), strings.TrimSpace(token))
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		all, err := s.households(r.Context(), user)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		wanted := r.Header.Get(householdHeader)
		c := caller{User: user, Households: all}
		if m := pick(all, wanted); m != nil {
			c.Tenant, c.Role = m.ID, m.Role
		} else if wanted != "" || !optional {
			w.Header().Set(notMemberHeader, "1")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		h(w, r, c)
	}
}

// Package auth verifies a request's Firebase ID token, provisions its user and picks
// the household (tenant) it acts in, from the user's own memberships only.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/api/option"

	"streamiq/api/internal/db"
)

const (
	// HouseholdHeader names the household a request acts in; without it, the user's oldest.
	HouseholdHeader = "X-StreamIQ-Household"
	// NotMemberHeader marks the 404 for a household the user isn't in, whether it exists
	// or not: the web app drops its household choice on it, never on any other 404.
	NotMemberHeader = "X-StreamIQ-Not-Member"
)

// NewVerifier builds the one ID-token verifier for dev and prod: with
// FIREBASE_AUTH_EMULATOR_HOST set, the SDK accepts the emulator's unsigned tokens
// through the same VerifyIDToken call, so the emulator needs STREAMIQ_ENV=development.
func NewVerifier(ctx context.Context) (*fbauth.Client, error) {
	project := os.Getenv("FIREBASE_PROJECT_ID")
	emulator := os.Getenv("FIREBASE_AUTH_EMULATOR_HOST") != ""
	serviceAccount := strings.TrimSpace(os.Getenv("FIREBASE_SERVICE_ACCOUNT_JSON"))
	switch {
	case project == "":
		return nil, errors.New("FIREBASE_PROJECT_ID is not set")
	case emulator && os.Getenv("STREAMIQ_ENV") != "development":
		return nil, errors.New("FIREBASE_AUTH_EMULATOR_HOST is set without STREAMIQ_ENV=development")
	case !emulator && strings.HasPrefix(project, "demo-"):
		return nil, fmt.Errorf("FIREBASE_PROJECT_ID is %q, a demo project, but no emulator host is set", project)
	case !emulator && serviceAccount == "":
		return nil, errors.New("FIREBASE_SERVICE_ACCOUNT_JSON is empty and no emulator host is set")
	}
	var opts []option.ClientOption
	if !emulator {
		opts = append(opts, option.WithAuthCredentialsJSON(option.ServiceAccount, []byte(serviceAccount)))
	}
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: project}, opts...)
	if err != nil {
		return nil, err
	}
	return app.Auth(ctx)
}

// Household is one of the user's memberships.
type Household struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
	Role string  `json:"role"`
}

// Caller is who a request acts as. Tenant and Role are empty for a user in no
// household, which only optional handlers get.
type Caller struct {
	User, Tenant, Role string
	Households         []Household
}

type Auth struct {
	verifier *fbauth.Client
	db       *db.DB
}

func New(verifier *fbauth.Client, d *db.DB) *Auth { return &Auth{verifier, d} }

// Handler wraps h: no valid Bearer ID token is a 401; a household the request names
// that isn't one of the user's (missing, foreign or malformed) is the not-a-member
// 404, and so is having no household at all unless optional.
func (a *Auth) Handler(optional bool, h func(http.ResponseWriter, *http.Request, Caller)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		if !strings.EqualFold(scheme, "Bearer") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		t, err := a.verifier.VerifyIDToken(r.Context(), strings.TrimSpace(token))
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		c, err := a.caller(r.Context(), t.UID)
		if err != nil {
			http.Error(w, "", http.StatusInternalServerError)
			return
		}
		named := r.Header.Values(HouseholdHeader)
		m := pick(c.Households, named)
		if m == nil && (len(named) > 0 || !optional) {
			w.Header().Set(NotMemberHeader, "1")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if m != nil {
			c.Tenant, c.Role = m.ID, m.Role
		}
		h(w, r, c)
	}
}

func (a *Auth) caller(ctx context.Context, uid string) (Caller, error) {
	user, err := a.provision(ctx, uid)
	if err != nil {
		return Caller{}, err
	}
	rows, _ := a.db.NoTenant().Query(ctx, `SELECT tenant_id, name, role FROM memberships_of($1)`, user)
	all, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (h Household, err error) {
		return h, r.Scan(&h.ID, &h.Name, &h.Role)
	})
	return Caller{User: user, Households: all}, err
}

// provision returns the users row of a Firebase UID, adding it on first sign-in. No
// household comes with it. Concurrent first requests: the unique FirebaseUid lets
// one insert win and the others read its row.
func (a *Auth) provision(ctx context.Context, uid string) (string, error) {
	const find = `SELECT "Id" FROM users WHERE "FirebaseUid" = $1`
	var id string
	err := a.db.NoTenant().QueryRow(ctx, find, uid).Scan(&id)
	if !errors.Is(err, pgx.ErrNoRows) {
		return id, err
	}
	if _, err := a.db.NoTenant().Exec(ctx,
		`INSERT INTO users ("Id", "FirebaseUid") VALUES (uuidv7(), $1) ON CONFLICT ("FirebaseUid") DO NOTHING`, uid); err != nil {
		return "", err
	}
	return id, a.db.NoTenant().QueryRow(ctx, find, uid).Scan(&id)
}

// pick is the membership named (none named: the oldest); nil = not a member. A
// malformed id is no member's, like one that doesn't exist.
func pick(all []Household, named []string) *Household {
	if len(named) == 0 {
		if len(all) == 0 {
			return nil
		}
		return &all[0]
	}
	want, err := uuid.Parse(strings.Join(named, ","))
	if err != nil {
		return nil
	}
	for i := range all {
		if all[i].ID == want.String() {
			return &all[i]
		}
	}
	return nil
}

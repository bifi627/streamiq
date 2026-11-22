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
	client, err := newClient(ctx, project, opts)
	if err != nil && !emulator {
		// The SDK's error can quote the key it failed to parse, so it never reaches the log.
		return nil, ErrServiceAccount
	}
	return client, err
}

// ErrServiceAccount is the whole start error for a key the SDK rejects.
var ErrServiceAccount = errors.New(`FIREBASE_SERVICE_ACCOUNT_JSON is not a valid service account key: ` +
	`set it to the key file's JSON on one line, with each line break inside "private_key" written as \n`)

func newClient(ctx context.Context, project string, opts []option.ClientOption) (*fbauth.Client, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: project}, opts...)
	if err != nil {
		return nil, err
	}
	return app.Auth(ctx)
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

// Token is the Caller of an ID token that arrives in-band (the broker's first message),
// through the same verification as Handler's. Tenant and Role stay empty.
func (a *Auth) Token(ctx context.Context, token string) (Caller, error) {
	t, err := a.verifier.VerifyIDToken(ctx, token)
	if err != nil {
		return Caller{}, err
	}
	return a.caller(ctx, t.UID)
}

func (a *Auth) caller(ctx context.Context, uid string) (Caller, error) {
	user, err := a.provision(ctx, uid)
	if err != nil {
		return Caller{}, err
	}
	all, err := a.Households(ctx, user)
	return Caller{User: user, Households: all}, err
}

// Households is user's memberships as they are now, oldest first.
func (a *Auth) Households(ctx context.Context, user string) ([]Household, error) {
	rows, _ := a.db.NoTenant().Query(ctx, `SELECT tenant_id, name, role FROM memberships_of($1)`, user)
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (h Household, err error) {
		return h, r.Scan(&h.ID, &h.Name, &h.Role)
	})
}

// provision returns the users row of a Firebase UID, adding it on first sign-in
// (sign_in, api/migrations/0006_rls_tenants_users.sql). No household comes with it.
func (a *Auth) provision(ctx context.Context, uid string) (id string, err error) {
	return id, a.db.NoTenant().QueryRow(ctx, `SELECT sign_in($1)`, uid).Scan(&id)
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

// Profile is a Firebase user's alias and email, read at request time and never stored
// (no PII in our DB). Empty = not set.
type Profile struct{ Alias, Email string }

// Profiles is the Firebase profile of each uid it finds; Firebase unreachable = none,
// so a caller answers without names.
// ponytail: one GetUsers call, at most 100 uids; page it if a household ever gets that big.
func (a *Auth) Profiles(ctx context.Context, uids []string) map[string]Profile {
	ids := make([]fbauth.UserIdentifier, len(uids))
	for i, u := range uids {
		ids[i] = fbauth.UIDIdentifier{UID: u}
	}
	out := map[string]Profile{}
	res, err := a.verifier.GetUsers(ctx, ids)
	if err != nil {
		return out
	}
	for _, u := range res.Users {
		out[u.UID] = Profile{u.DisplayName, u.Email}
	}
	return out
}

// Name is the alias, else the email; nil when neither is known.
func (p Profile) Name() *string {
	for _, s := range []string{p.Alias, p.Email} {
		if s != "" {
			return &s
		}
	}
	return nil
}

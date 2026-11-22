package invites

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Accepted is POST /api/invites/accept's answer: the household the caller is in now.
type Accepted struct {
	HouseholdID string `json:"householdId"`
}

// accept makes the caller a member of the invite's household and of nothing else.
// Already a member (also when joined concurrently, by another invite or tab): 200, and
// the invite isn't spent.
func accept(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	t, ok := token(w, r)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f, ok, err := find(r, d, t)
	switch {
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
		return
	case !ok:
		w.WriteHeader(http.StatusNotFound)
		return
	case member(c, f.household):
		writeJSON(w, Accepted{f.household}, nil)
		return
	}
	// The claim and the membership commit together.
	var out Accepted
	err = d.InClaimedTenant(r.Context(), db.Invite, hash(t), func(tx pgx.Tx, tenant string) error {
		out.HouseholdID = tenant
		_, e := tx.Exec(r.Context(), `INSERT INTO memberships (tenant_id, user_id, role)
			VALUES ($1, $2, 'member')`, tenant, c.User)
		return e
	})
	var pg *pgconn.PgError
	switch {
	case errors.Is(err, pgx.ErrNoRows): // used or expired
		w.WriteHeader(http.StatusNotFound)
	case errors.As(err, &pg) && pg.Code == "23505": // joined concurrently: rolled back, unspent
		writeJSON(w, Accepted{f.household}, nil)
	default:
		writeJSON(w, out, err)
	}
}

// Package members is the request's household members: the list, removing one (or
// leaving) and setting a role. A household never loses its last admin.
package members

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB) {
	mux.HandleFunc("GET /api/members", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { list(w, r, c, d, a) }))
	mux.HandleFunc("DELETE /api/members/{userId}", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { remove(w, r, c, d) }))
	mux.HandleFunc("PUT /api/members/{userId}/role", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { setRole(w, r, c, d) }))
}

var errNotFound, errLastAdmin = errors.New("not a member"), errors.New("last admin")

// target is the {userId} in the path; not a UUID = no member's, a 404.
func target(r *http.Request) (string, bool) {
	id, err := uuid.Parse(r.PathValue("userId"))
	return id.String(), err == nil
}

// lock runs in the household's transaction: it locks the household's row (NO KEY: the
// foreign-key checks of inserts into the household's tables don't wait on it), so membership
// changes in one household run one at a time (two admins demoting each other can't both
// pass the check), then whether the member (errNotFound: not in this household) is
// its only admin.
func lock(ctx context.Context, tx pgx.Tx, tenant, user string) (lastAdmin bool, err error) {
	if _, err = tx.Exec(ctx, `SELECT FROM tenants WHERE id = $1 FOR NO KEY UPDATE`, tenant); err != nil {
		return false, err
	}
	err = tx.QueryRow(ctx, `SELECT role = 'admin' AND
		(SELECT count(*) FROM memberships WHERE role = 'admin') = 1
		FROM memberships WHERE user_id = $1`, user).Scan(&lastAdmin)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, errNotFound
	}
	return lastAdmin, err
}

// answer is the response to a change: 204, or the status the change stopped at.
func answer(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errNotFound):
		w.WriteHeader(http.StatusNotFound)
	case errors.Is(err, errLastAdmin): // no body: the web app has the text
		w.WriteHeader(http.StatusConflict)
	default:
		http.Error(w, "", http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

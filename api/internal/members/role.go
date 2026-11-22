package members

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// setRole: an admin promotes a member or demotes an admin (themselves too); it applies
// on the target's next request. Demoting the only admin is refused.
func setRole(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	user, ok := target(r)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var rq struct{ Role string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rq) != nil ||
		(rq.Role != "admin" && rq.Role != "member") {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	answer(w, d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		lastAdmin, err := lock(r.Context(), tx, c.Tenant, user)
		switch {
		case err != nil:
			return err
		case lastAdmin && rq.Role == "member":
			return errLastAdmin
		}
		_, err = tx.Exec(r.Context(), `UPDATE memberships SET "Role" = $2 WHERE "UserId" = $1`, user, rq.Role)
		return err
	}))
}

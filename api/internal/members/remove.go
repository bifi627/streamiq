package members

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// remove: an admin removes a member, anyone removes themselves (= leave). Access ends
// with the membership: every request and broker offer looks it up afresh. The removed
// user's pending invites go in the same transaction, so a link they kept can't bring
// them back; a demoted admin's stay (setRole).
func remove(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	user, ok := target(r)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if user != c.User && c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	answer(w, d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		lastAdmin, err := lock(r.Context(), tx, c.Tenant, user)
		switch {
		case err != nil:
			return err
		case lastAdmin:
			return errLastAdmin
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM memberships WHERE "UserId" = $1`, user); err != nil {
			return err
		}
		// One statement on the invites slice's table: it must commit with the removal.
		_, err = tx.Exec(r.Context(), `DELETE FROM invites WHERE "CreatedBy" = $1 AND "UsedAt" IS NULL`, user)
		return err
	}))
}

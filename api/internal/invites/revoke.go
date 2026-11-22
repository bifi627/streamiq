package invites

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// revoke deletes a pending invite: its link then answers like an unknown one. A used
// one stays (the person already joined): 404, like an unknown one or another household's.
func revoke(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var n int64
	err = d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `DELETE FROM invites WHERE "Id" = $1 AND "UsedAt" IS NULL`, id)
		n = tag.RowsAffected()
		return err
	})
	switch {
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
	case n == 0:
		w.WriteHeader(http.StatusNotFound)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

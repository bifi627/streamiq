package tunnels

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// throughput stores the gateway → client throughput the browser measured on its own
// tunnel; missing, zero or negative stores null. Another user's or another household's
// tunnel is no row here: 404, like an unknown id.
func throughput(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var rq struct {
		ThroughputKbps *int32 `json:"throughputKbps"`
	}
	if json.NewDecoder(r.Body).Decode(&rq) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if rq.ThroughputKbps != nil && *rq.ThroughputKbps <= 0 {
		rq.ThroughputKbps = nil
	}
	var n int64
	err = d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		tag, e := tx.Exec(r.Context(), `UPDATE tunnels SET "ThroughputKbps" = $1 WHERE "Id" = $2 AND "UserId" = $3`,
			rq.ThroughputKbps, id, c.User)
		n = tag.RowsAffected()
		return e
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

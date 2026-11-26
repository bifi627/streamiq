package household

import (
	"net/http"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// remove: an admin deletes the request's household with its members, gateways and
// invites. Its gateways' sockets and tunnels close as on a revoke.
func remove(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB, closeSockets func(gatewayID string)) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var gateways []string
	err := d.NoTenant().QueryRow(r.Context(), `SELECT delete_household($1, $2)::text[]`, c.Tenant, c.User).
		Scan(&gateways)
	switch {
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
	case gateways == nil: // demoted since the request's membership was read
		w.WriteHeader(http.StatusForbidden)
	default:
		for _, g := range gateways {
			closeSockets(g)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

package household

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Named is PUT /api/households/current/name's answer: the name as stored.
type Named struct {
	Name string `json:"name"`
}

// rename: an admin names the request's household; until then the web app shows the end
// of its id.
func rename(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var rq struct{ Name *string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rq) != nil || rq.Name == nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	name, ok := valid(*rq.Name)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `UPDATE tenants SET name = $2 WHERE id = $1`, c.Tenant, name)
		return err
	})
	writeJSON(w, Named{name}, err)
}

// valid is name trimmed: 1 to 100 UTF-16 units (an emoji counts 2, as in a gateway
// name), no control characters.
func valid(name string) (string, bool) {
	name = strings.TrimSpace(name)
	n := len(utf16.Encode([]rune(name)))
	return name, n > 0 && n <= 100 && strings.IndexFunc(name, unicode.IsControl) < 0
}

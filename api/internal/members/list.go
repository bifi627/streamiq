package members

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Member is a row of GET /api/members.
type Member struct {
	UserID string `json:"userId"`
	// Name is the alias, else the email; null: Firebase unreachable.
	Name *string `json:"name"`
	// Email is on the caller's own row only.
	Email    string    `json:"email,omitempty" tstype:"string | undefined"`
	Role     string    `json:"role"            tstype:"'admin' | 'member'"`
	JoinedAt time.Time `json:"joinedAt"`
}

// list: any member sees the household's members, oldest first. Names come from
// Firebase at request time and are never stored; admins don't get others' emails either.
func list(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB, a *auth.Auth) {
	out := []Member{}
	var uids []string
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT m.user_id::text, u.firebase_uid, m.role, m.created_at
			FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY m.created_at, m.user_id`)
		var err error
		out, err = pgx.AppendRows(out, rows, func(row pgx.CollectableRow) (m Member, err error) {
			var uid string
			err = row.Scan(&m.UserID, &uid, &m.Role, &m.JoinedAt)
			uids = append(uids, uid)
			return m, err
		})
		return err
	})
	if err != nil {
		writeJSON(w, nil, err)
		return
	}
	profiles := a.Profiles(r.Context(), uids)
	for i := range out {
		p := profiles[uids[i]]
		out[i].Name = p.Name()
		if out[i].UserID == c.User {
			out[i].Email = p.Email
		}
	}
	writeJSON(w, out, nil)
}

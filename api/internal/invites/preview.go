package invites

import (
	"net/http"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Preview is POST /api/invites/preview's answer: which household the invite is for.
type Preview struct {
	HouseholdID string `json:"householdId"`
	// Name is the household's, else "<inviter>'s household"; null when neither is known.
	Name   *string `json:"name"`
	Member bool    `json:"member"`
}

// preview: an unknown, revoked, used or expired invite is a 404, all alike, unless the
// caller is already a member of its household.
func preview(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB, a *auth.Auth) {
	t, ok := token(w, r)
	if !ok {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f, ok, err := find(r, d, t)
	out := Preview{HouseholdID: f.household, Name: f.name, Member: member(c, f.household)}
	switch {
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
		return
	case !ok || (!out.Member && !f.usable):
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if out.Name == nil && f.inviterUID != nil {
		if who := a.Profiles(r.Context(), []string{*f.inviterUID})[*f.inviterUID].Name(); who != nil {
			name := *who + "'s household"
			out.Name = &name
		}
	}
	writeJSON(w, out, nil)
}

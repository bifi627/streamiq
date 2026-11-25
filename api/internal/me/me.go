// Package me is GET /api/me: the signed-in user, the household this request acts in,
// and every household the user belongs to (oldest first). The first call for a new
// Firebase UID adds the user (auth); with no household yet, tenantId is null and
// memberships empty.
package me

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

type Me struct {
	UserID      string       `json:"userId"`
	TenantID    *string      `json:"tenantId"`
	Memberships []Membership `json:"memberships"`
}

type Membership struct {
	auth.Household `tstype:",extends"`
	// Members counts everyone in the household, the user included.
	Members int `json:"members"`
}

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB) {
	mux.HandleFunc("GET /api/me", a.Handler(true, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
		get(w, r, c, d)
	}))
}

func get(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	counts := map[string]int{}
	rows, _ := d.NoTenant().Query(r.Context(), `SELECT tenant_id::text, members FROM member_counts($1)`, c.User)
	var id string
	var n int
	if _, err := pgx.ForEachRow(rows, []any{&id, &n}, func() error { counts[id] = n; return nil }); err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	me := Me{UserID: c.User, Memberships: []Membership{}}
	for _, h := range c.Households {
		me.Memberships = append(me.Memberships, Membership{h, counts[h.ID]})
	}
	if c.Tenant != "" {
		me.TenantID = &c.Tenant
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(me)
}

// Package me is GET /api/me: the signed-in user, the household this request acts in,
// and every household the user belongs to (oldest first). The first call for a new
// Firebase UID adds the user (auth); with no household yet, tenantId is null and
// memberships empty.
package me

import (
	"encoding/json"
	"net/http"

	"streamiq/api/internal/auth"
)

type Me struct {
	UserID      string           `json:"userId"`
	TenantID    *string          `json:"tenantId"`
	Memberships []auth.Household `json:"memberships"`
}

func Routes(mux *http.ServeMux, a *auth.Auth) {
	mux.HandleFunc("GET /api/me", a.Handler(true, get))
}

func get(w http.ResponseWriter, _ *http.Request, c auth.Caller) {
	me := Me{UserID: c.User, Memberships: c.Households}
	if me.Memberships == nil {
		me.Memberships = []auth.Household{}
	}
	if c.Tenant != "" {
		me.TenantID = &c.Tenant
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(me)
}

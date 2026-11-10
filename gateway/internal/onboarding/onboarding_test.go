package onboarding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Enrolls once against a fake control plane, then a second start with the
// same state dir must not spend a token again (the token is in shell history).
func TestEnrollOnceThenReuseState(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req map[string]string
		json.NewDecoder(r.Body).Decode(&req)
		if r.URL.Path != "/api/gateways/enroll" || req["token"] != "tok" || req["fingerprint"] != "fp" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"gatewayId": "dev-1", "credential": "cred-1"})
	}))
	defer srv.Close()
	dir := t.TempDir()

	st, err := LoadOrEnroll(context.Background(), dir, srv.URL, "tok", "fp")
	if err != nil || st.GatewayID != "dev-1" || st.Credential != "cred-1" {
		t.Fatalf("enroll = %+v, %v", st, err)
	}
	st, err = LoadOrEnroll(context.Background(), dir, srv.URL, "spent-token", "fp")
	if err != nil || st.Credential != "cred-1" {
		t.Fatalf("reload = %+v, %v", st, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("enroll endpoint hit %d times, want 1", calls.Load())
	}
}

func TestEnrollRejectedTokenFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	if _, err := LoadOrEnroll(context.Background(), t.TempDir(), srv.URL, "used", "fp"); err == nil {
		t.Fatal("want an error for a rejected token")
	}
}

// A revoked credential (401 on the control socket) says how to re-enroll.
func TestRunControlRevokedCredential(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	err := RunControl(context.Background(), srv.URL, &State{Credential: "old"}, "", "dev", new(atomic.Int64), nil, nil)
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("want a revoked-credential error, got %v", err)
	}
}

// The control socket authenticates with the credential and heartbeats the LAN URL.
func TestRunControlHeartbeats(t *testing.T) {
	got := make(chan map[string]any, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cred-1" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_, b, _ := c.Read(r.Context())
		var hb map[string]any
		json.Unmarshal(b, &hb)
		got <- hb
		c.Close(websocket.StatusNormalClosure, "")
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var lastBeat atomic.Int64
	go RunControl(ctx, srv.URL, &State{Credential: "cred-1"}, "http://192.168.1.20:8097", "1.4.0", &lastBeat,
		func() Status {
			return Status{OS: "windows", Arch: "amd64", PairedClients: 2, Jellyfin: JellyfinStatus{Reachable: true, Version: "10.11.2", Token: "ok"}}
		}, func([]byte, func(any)) {})
	select {
	case hb := <-got:
		if hb["type"] != "heartbeat" || hb["lanUrl"] != "http://192.168.1.20:8097" || hb["version"] != "1.4.0" {
			t.Fatalf("heartbeat = %v", hb)
		}
		// The status snapshot is flattened into the heartbeat (docs/protocol.md).
		jf, _ := hb["jellyfin"].(map[string]any)
		if hb["os"] != "windows" || hb["pairedClients"] != 2.0 || jf["token"] != "ok" || jf["version"] != "10.11.2" {
			t.Fatalf("heartbeat status = %v", hb)
		}
		if _, ok := hb["update"]; ok {
			t.Fatalf("up to date: want no update field, got %v", hb["update"])
		}
	case <-ctx.Done():
		t.Fatal("no heartbeat received")
	}
}

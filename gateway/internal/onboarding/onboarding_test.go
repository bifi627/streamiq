package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"streamiq/gateway/internal/tunnel"
)

// Enrolls once against a fake control plane, then a second start with the
// same state dir must not spend a token again (the token is in shell history).
func TestEnrollOnceThenReuseState(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req map[string]string
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if r.URL.Path != "/api/gateways/enroll" || req["token"] != "tok" || req["fingerprint"] != "fp" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"gatewayId": "dev-1", "credential": "cred-1"})
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
	err := RunControl(
		context.Background(),
		srv.URL,
		&State{Credential: "old"},
		"",
		"dev",
		new(atomic.Int64),
		nil,
		nil,
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("want a revoked-credential error, got %v", err)
	}
}

// A handshake the API never answers ends in an error (#475), so forever retries
// instead of hanging the gateway offline; a socket that did open outlives the
// dial timeout.
func TestRunControlDialTimeout(t *testing.T) {
	defer func(d time.Duration) { dialTimeout = d }(dialTimeout)
	dialTimeout = 100 * time.Millisecond
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer hang" {
			<-release // accepts TCP, never answers the upgrade
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_, _, _ = c.Read(r.Context())       // the first heartbeat
		time.Sleep(1500 * time.Millisecond) // past the second dial's 1 s timeout
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"type":"ping"}`))
		c.Close(websocket.StatusNormalClosure, "")
	}))
	defer srv.Close()
	defer close(release) // before srv.Close, which waits for the handler

	done := make(chan error, 1)
	go func() {
		done <- RunControl(context.Background(), srv.URL, &State{Credential: "hang"}, "", "dev", new(atomic.Int64), nil, nil, nil)
	}()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "dial control") {
			t.Fatalf("want a dial control error, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunControl still dialing after the timeout")
	}

	dialTimeout = time.Second // room for a loaded machine; the socket must outlive it
	got := make(chan []byte, 1)
	err := RunControl(
		context.Background(),
		srv.URL,
		&State{Credential: "ok", beat: make(chan struct{}, 1)},
		"",
		"dev",
		new(atomic.Int64),
		func() string { return "" },
		func() (string, any) { return "off", nil },
		func(raw []byte, _ func(any)) {
			if raw != nil {
				got <- raw
			}
		},
	)
	if !strings.Contains(fmt.Sprint(err), "control closed") || len(got) != 1 {
		t.Fatalf("want a message after the dial timeout, then a close; got %d messages, %v", len(got), err)
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
		if err := json.Unmarshal(b, &hb); err != nil {
			t.Error(err)
		}
		got <- hb
		c.Close(websocket.StatusNormalClosure, "")
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var lastBeat atomic.Int64
	// what it returns doesn't matter: the test checks what the fake server sees
	go func() {
		_ = RunControl(
			ctx,
			srv.URL,
			&State{Credential: "cred-1", Name: "nas"},
			"http://192.168.1.20:8097",
			"1.4.0",
			&lastBeat,
			func() string { return "" },
			func() (string, any) { return "off", nil },
			func([]byte, func(any)) {},
		)
	}()
	select {
	case hb := <-got:
		if hb["type"] != "heartbeat" || hb["lanUrl"] != "http://192.168.1.20:8097" || hb["version"] != "1.4.0" ||
			hb["protocol"] != float64(Protocol) ||
			hb["name"] != "nas" || hb["telemetry"] != "off" {
			t.Fatalf("heartbeat = %v", hb)
		}
		if len(hb) != 6 { // liveness, name and the level; health only at full
			t.Fatalf("heartbeat has extra fields: %v", hb)
		}
		if _, ok := hb["update"]; ok {
			t.Fatalf("up to date: want no update field, got %v", hb["update"])
		}
	case <-ctx.Done():
		t.Fatal("no heartbeat received")
	}
}

// SetName (#310) trims, refuses out-of-bounds names, stores the name in
// gateway.json and sends a heartbeat with it right away, not at the next tick.
func TestSetNameStoresAndBeatsEarly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gateway.json")
	if err := os.WriteFile(path, []byte(`{"gatewayId":"g1","credential":"cred-1","name":"nas"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := LoadOrEnroll(context.Background(), dir, "", "", "fp")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", 101), "a\x00b", "a\nb", strings.Repeat("😀", 51)} {
		if _, err := st.SetName(bad); !errors.Is(err, ErrBadName) {
			t.Fatalf("SetName(%q) = %v, want ErrBadName", bad, err)
		}
	}
	for _, ok := range []string{strings.Repeat("é", 100), strings.Repeat("😀", 50)} { // 100 UTF-16 units
		if n, err := st.SetName(ok); err != nil || n != ok {
			t.Fatalf("100 units: %q, %v", n, err)
		}
	}

	beats := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var hb map[string]any
			if err := json.Unmarshal(b, &hb); err != nil {
				t.Error(err)
			}
			beats <- hb["name"].(string)
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	<-st.beat // drop the signal from the setup rename above
	// what it returns doesn't matter: the test checks what the fake server sees
	go func() {
		_ = RunControl(
			ctx,
			srv.URL,
			st,
			"",
			"dev",
			new(atomic.Int64),
			func() string { return "" },
			func() (string, any) { return "off", nil },
			func([]byte, func(any)) {},
		)
	}()
	next := func() string {
		select {
		case n := <-beats:
			return n
		case <-ctx.Done():
			t.Fatal("no heartbeat (the early one must not wait 30 s)")
			return ""
		}
	}
	next() // the connect beat
	if n, err := st.SetName("  Living room NAS  "); err != nil || n != "Living room NAS" {
		t.Fatalf("SetName = %q, %v", n, err)
	}
	if n := next(); n != "Living room NAS" {
		t.Fatalf("early heartbeat name = %q", n)
	}
	b, _ := os.ReadFile(path)
	var saved State
	if err := json.Unmarshal(
		b,
		&saved,
	); err != nil || saved.Name != "Living room NAS" || saved.Credential != "cred-1" ||
		saved.GatewayID != "g1" {
		t.Fatalf("gateway.json = %s", b)
	}
	if st.CurrentName() != "Living room NAS" {
		t.Fatalf("CurrentName = %q", st.CurrentName())
	}
}

// The API refusing this gateway's protocol (#176) surfaces as ErrUpgradeRequired.
func TestRunControlUpgradeRequired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_, _, _ = c.Read(r.Context())
		c.Close(websocket.StatusPolicyViolation, "upgrade required")
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := RunControl(ctx, srv.URL, &State{Credential: "c"}, "", "1.0.0", new(atomic.Int64),
		func() string { return "" }, func() (string, any) { return "off", nil }, func([]byte, func(any)) {})
	if !errors.Is(err, ErrUpgradeRequired) {
		t.Fatalf("want ErrUpgradeRequired, got %v", err)
	}
}

// POST /streamiq/name (#310): admin-only, answers the stored name, a bad name
// (or body) is 400, a failed save 500, never 502 (#327).
func TestNameAPI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(dir, "gateway.json"),
		[]byte(`{"gatewayId":"g1","credential":"cred-1","name":"nas"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	st, err := LoadOrEnroll(context.Background(), dir, "", "", "fp")
	if err != nil {
		t.Fatal(err)
	}
	api := tunnel.NewRouter()
	api.Handle("POST "+NamePath, http.HandlerFunc(st.ServeName), tunnel.AdminOnly)
	for _, c := range []struct {
		role, body string
		want       int
		reply      string
	}{
		{tunnel.Admin, `{"name":"  Living room  "}`, 200, `{"name":"Living room"}`},
		{tunnel.Member, `{"name":"hijack"}`, http.StatusForbidden, ""},
		{"", `{"name":"hijack"}`, http.StatusForbidden, ""},
		{tunnel.Admin, `{"name":"   "}`, http.StatusBadRequest, ""},
		{tunnel.Admin, `not json`, http.StatusBadRequest, ""},
	} {
		if s, _, reply, _ := tunnel.Do(
			api,
			tunnel.Session{Role: c.role},
			"POST",
			NamePath,
			c.body,
		); s != c.want ||
			reply != c.reply {
			t.Errorf("%q %s: %d %s, want %d %s", c.role, c.body, s, reply, c.want, c.reply)
		}
	}
	if st.CurrentName() != "Living room" {
		t.Fatalf("stored %q", st.CurrentName())
	}
	st.path = filepath.Join(dir, "missing", "gateway.json") // the state dir unwritable
	if s, _, _, _ := tunnel.Do(
		api,
		tunnel.Session{Role: tunnel.Admin},
		"POST",
		NamePath,
		`{"name":"x"}`,
	); s != http.StatusInternalServerError {
		t.Fatalf("failed save: %d, want 500", s)
	}
}

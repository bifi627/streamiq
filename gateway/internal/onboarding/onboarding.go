// Package onboarding spends a one-time enrollment token for a long-lived
// credential, then holds the authenticated control socket and heartbeat.
package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/tunnel"
	"streamiq/protocol"
)

const heartbeatEvery = 30 * time.Second

// dialTimeout bounds the control socket's handshake: an API (or network)
// that never answers the upgrade must fail the dial so forever retries, not hang
// the gateway offline until restarted. A var so tests can shorten it.
var dialTimeout = 20 * time.Second

// dialContext is the handshake's context; a var so tests can see it end.
var dialContext = func(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, dialTimeout)
}

// Protocol is the gateway ↔ API protocol version (docs/protocol.md). Bump it on a
// breaking change; the API refuses a gateway below its minimum ("upgrade required").
const Protocol = 3

// ErrUpgradeRequired: the API no longer speaks this gateway's protocol.
var ErrUpgradeRequired = errors.New("the StreamIQ service no longer supports this gateway version: " +
	"update it by rerunning the install command (docs/install.md)")

// State is gateway.json in the state dir. Delete the dir = brand-new gateway.
// Name and RelayOff are shared mutable state: read them with CurrentName / Relay,
// change them with SetName / SetRelay. Its JSON format changed? Update oldState in cmd/gateway/update_windows_test.go
// in the same PR: the update test starts from it.
type State struct {
	GatewayID  string `json:"gatewayId"`
	Credential string `json:"credential"`
	Name       string `json:"name"`
	// RelayOff: tunnels go direct only, never through TURN (docs/architecture.md).
	RelayOff bool `json:"relayOff,omitempty"`

	path string
	mu   sync.Mutex
	beat chan struct{} // one pending signal: send a heartbeat now
}

// Beat asks RunControl for an early heartbeat (a rename, the relay setting),
// so the API sees the change now, not at the next tick.
func (s *State) Beat() {
	select {
	case s.beat <- struct{}{}:
	default: // a beat is already pending
	}
}

// ErrBadName: pairing.ErrBadName's rule (no control characters: Postgres text
// refuses NUL).
var ErrBadName = pairing.ErrBadName

// CurrentName is the gateway's name now.
func (s *State) CurrentName() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Name
}

// SetName trims name, stores it in gateway.json (atomically) and asks
// RunControl for an early heartbeat, so the API mirrors it at once.
func (s *State) SetName(name string) (string, error) {
	name, err := pairing.CleanName(name)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeAtomic(s.path, s.GatewayID, s.Credential, name, s.RelayOff); err != nil {
		return "", err
	}
	s.Name = name
	log.Printf("gateway: renamed to %q", name)
	s.Beat()
	return name, nil
}

// Relay: false = tunnels go direct only (RelayOff).
func (s *State) Relay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.RelayOff
}

// SetRelay stores the relay setting in gateway.json (atomically) and asks RunControl
// for an early heartbeat, so the broker stops minting TURN credentials at once.
func (s *State) SetRelay(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeAtomic(s.path, s.GatewayID, s.Credential, s.Name, !on); err != nil {
		return err
	}
	s.RelayOff = !on
	log.Printf("gateway: relay %s", map[bool]string{true: "on", false: "off (direct only)"}[on])
	s.Beat()
	return nil
}

// writeAtomic: a crash mid-write leaves the old file, never half a credential.
func writeAtomic(path, id, credential, name string, relayOff bool) error {
	b, _ := json.Marshal(map[string]any{
		"gatewayId": id, "credential": credential, "name": name, "relayOff": relayOff,
	})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadOrEnroll returns the stored credential, or spends the enrollment token to
// get one. An existing credential wins: a token left in shell history or
// `docker inspect` is already used and harmless.
func LoadOrEnroll(ctx context.Context, dir, api, token string) (*State, error) {
	path := filepath.Join(dir, "gateway.json")
	if b, err := os.ReadFile(path); err == nil {
		st := State{path: path, beat: make(chan struct{}, 1)}
		return &st, json.Unmarshal(b, &st)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("not enrolled: set STREAMIQ_ENROLL_TOKEN (web app → Add gateway)")
	}

	name := os.Getenv("STREAMIQ_NAME") // install command may set it
	if name == "" {
		name, _ = os.Hostname()
	}
	// Before the token is spent: a credential that can't be saved is lost for good.
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]string{"token": token, "name": name})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, api+"/api/gateways/enroll", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("enroll: %s (token expired or already used? create a new one)", res.Status)
	}
	st := State{Name: name, path: path, beat: make(chan struct{}, 1)}
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	if err := writeAtomic(path, st.GatewayID, st.Credential, st.Name, false); err != nil {
		return nil, err
	}
	log.Printf("gateway: enrolled as gateway %s", st.GatewayID)
	return &st, nil
}

// RunControl holds the authenticated control socket until it drops: heartbeats
// (liveness + update()) out, broker messages (signaling for browser sessions) in,
// handed to handle with a send func that writes JSON back on this socket.
// lastBeat holds the last heartbeat's unix time, 0 while disconnected (status page).
func RunControl(
	ctx context.Context,
	api string,
	st *State,
	lanURL, version string,
	lastBeat *atomic.Int64,
	update func() string,
	handle func(raw []byte, send func(any)),
) error {
	// Dial's context bounds only the handshake: cancelling it once Dial returned
	// leaves the socket open (coder/websocket does the same for HTTPClient.Timeout).
	dialCtx, cancelDial := dialContext(ctx)
	conn, res, err := websocket.Dial(dialCtx, api+"/api/gateways/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + st.Credential}},
	})
	cancelDial()
	if res != nil && res.StatusCode == http.StatusUnauthorized {
		// Removed in the web app (or enrolled against another API). Keeps retrying,
		// harmlessly, until someone re-enrolls; the state dir's cert (pins) survives.
		return fmt.Errorf("credential revoked or unknown: this gateway was removed in the web app. " +
			"To add it again: delete gateway.json in the state dir, then run a new install command (web app → Add gateway)")
	}
	if err != nil {
		return fmt.Errorf("dial control: %w", err)
	}
	defer func() { _ = conn.CloseNow() }() // it only fails on a connection already closed
	defer lastBeat.Store(0)
	conn.SetReadLimit(1 << 20) // SDP exceeds the 32KB default
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	send := func(v any) {
		b, _ := json.Marshal(v)
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			log.Printf("gateway: control write: %v", err)
		}
	}
	go func() { // heartbeat (also keeps Railway's edge from reaping an idle socket)
		t := time.NewTicker(heartbeatEvery)
		defer t.Stop()
		for {
			send(protocol.Heartbeat{
				Type: "heartbeat", LanURL: lanURL, Version: version, Update: update(), Protocol: Protocol,
				Name: st.CurrentName(), RelayOff: !st.Relay(),
			})
			lastBeat.Store(time.Now().Unix())
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			case <-st.beat:
			}
		}
	}()
	for {
		_, raw, err := conn.Read(ctx)
		var ce websocket.CloseError
		if errors.As(err, &ce) && ce.Code == websocket.StatusPolicyViolation && ce.Reason == "upgrade required" {
			return ErrUpgradeRequired
		}
		if err != nil {
			return fmt.Errorf("control closed: %w", err)
		}
		handle(raw, send)
	}
}

// LANURL is the page's address on the home LAN: STREAMIQ_LAN_URL if set (needed in
// Docker, where the container IP is useless), else the first private IPv4.
func LANURL(port string) string {
	if u := os.Getenv("STREAMIQ_LAN_URL"); u != "" {
		return u
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
			return "http://" + net.JoinHostPort(n.IP.String(), port)
		}
	}
	return "http://" + net.JoinHostPort("localhost", port)
}

// NamePath renames the gateway (gateway API, admin-only): POST
// {"name": "…"} → 200 {"name": stored}, a bad name (or body) 400. The gateway
// owns its name; the heartbeat tells the API.
const NamePath = "/streamiq/name"

// ServeName is POST NamePath.
func (s *State) ServeName(w http.ResponseWriter, r *http.Request) {
	var in Name
	if b, _ := io.ReadAll(r.Body); json.Unmarshal(b, &in) != nil {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("gateway API: rename: bad body"))
		return
	}
	name, err := s.SetName(in.Name)
	switch {
	case errors.Is(err, ErrBadName):
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: rename: %w", err))
	case err != nil:
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: rename: %w", err))
	default:
		tunnel.JSON(w, http.StatusOK, Name{name})
	}
}

// RelayPath switches the relay (gateway API, admin-only): POST {"relay": bool} →
// 200 {"relay": stored}, a bad body 400. The gateway owns the setting; the heartbeat
// tells the API.
const RelayPath = "/streamiq/relay"

// ServeRelay is POST RelayPath.
func (s *State) ServeRelay(w http.ResponseWriter, r *http.Request) {
	var in Relay
	if b, _ := io.ReadAll(r.Body); json.Unmarshal(b, &in) != nil || in.Relay == nil {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("gateway API: relay: bad body"))
		return
	}
	if err := s.SetRelay(*in.Relay); err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: relay: %w", err))
		return
	}
	on := s.Relay()
	tunnel.JSON(w, http.StatusOK, Relay{&on})
}

// SetRelayFile is the CLI's switch: gateway.json in dir, with the gateway stopped
// (a running one holds its state in memory).
func SetRelayFile(dir string, on bool) error {
	path := filepath.Join(dir, "gateway.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("not enrolled yet (%w)", err)
	}
	st := State{path: path, beat: make(chan struct{}, 1)}
	if err := json.Unmarshal(b, &st); err != nil {
		return err
	}
	return st.SetRelay(on)
}

// Package onboarding is flow 1 of the pairing design: spend a one-time
// enrollment token for a long-lived credential, then hold the authenticated
// control socket and heartbeat (design: specs/2026-11-01-streamiq-agent-pairing-design.md).
package onboarding

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const heartbeatEvery = 30 * time.Second

// Protocol is the gateway ↔ API protocol version (docs/protocol.md). Bump it on a
// breaking change; the API refuses a gateway below its minimum ("upgrade required").
const Protocol = 1

// ErrUpgradeRequired: the API no longer speaks this gateway's protocol.
var ErrUpgradeRequired = errors.New("the StreamIQ service no longer supports this gateway version: " +
	"update it by rerunning the install command (docs/install.md)")

// State is gateway.json in the state dir. Delete the dir = brand-new gateway.
type State struct {
	GatewayID  string `json:"gatewayId"`
	Credential string `json:"credential"`
	Name       string `json:"name"`
}

// LoadOrEnroll returns the stored credential, or spends the enrollment token to
// get one. An existing credential wins: a token left in shell history or
// `docker inspect` is already used and harmless.
func LoadOrEnroll(ctx context.Context, dir, api, token, fp string) (*State, error) {
	path := filepath.Join(dir, "gateway.json")
	if b, err := os.ReadFile(path); err == nil {
		var st State
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
	body, _ := json.Marshal(map[string]string{"token": token, "fingerprint": fp, "name": name})
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
	st := State{Name: name}
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	b, _ := json.Marshal(st)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, err
	}
	log.Printf("gateway: enrolled as gateway %s", st.GatewayID)
	return &st, nil
}

type heartbeat struct {
	Type     string `json:"type"`
	LanURL   string `json:"lanUrl"`
	Version  string `json:"version"`
	Update   string `json:"update,omitempty"` // newer release version, "" = up to date
	Protocol int    `json:"protocol"`
}

// RunControl holds the authenticated control socket until it drops: heartbeats
// (liveness + update(), #140) out, broker messages (signaling for browser sessions) in,
// handed to handle with a send func that writes JSON back on this socket.
// lastBeat holds the last heartbeat's unix time, 0 while disconnected (status page).
func RunControl(ctx context.Context, api string, st *State, lanURL, version string, lastBeat *atomic.Int64,
	update func() string, handle func(raw []byte, send func(any))) error {
	conn, res, err := websocket.Dial(ctx, api+"/api/gateways/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + st.Credential}},
	})
	if res != nil && res.StatusCode == http.StatusUnauthorized {
		// Removed in the web app (or enrolled against another API). Keeps retrying,
		// harmlessly, until someone re-enrolls; the state dir's cert (pins) survives.
		return fmt.Errorf("credential revoked or unknown: this gateway was removed in the web app. " +
			"To add it again: delete gateway.json in the state dir, then run a new install command (web app → Add gateway)")
	}
	if err != nil {
		return fmt.Errorf("dial control: %w", err)
	}
	defer conn.CloseNow()
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
			send(heartbeat{Type: "heartbeat", LanURL: lanURL, Version: version, Update: update(), Protocol: Protocol})
			lastBeat.Store(time.Now().Unix())
			select {
			case <-ctx.Done():
				return
			case <-t.C:
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

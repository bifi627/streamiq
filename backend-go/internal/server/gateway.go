package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"

	"streamiq/gateway/proto"
)

// Oldest gateway protocol (docs/protocol.md) the API still speaks. Raising it is a
// deliberate step: every gateway below it is refused until its owner updates.
const minGatewayProtocol = 1

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// gatewaySocket is the gateway's control socket, authenticated by its credential
// (Bearer): heartbeats, the gateway's half of brokered sessions (answer/ice back to the
// session's browser), and its report of each tunnel when it ends.
func (s *Server) gatewaySocket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	scheme, credential, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	credential = strings.TrimSpace(credential)
	hash := hashSecret(credential)
	me := &link{}
	// Before any tenant is known: the credential establishes it.
	err := errors.New("no bearer credential")
	if strings.EqualFold(scheme, "Bearer") && credential != "" {
		err = s.db.NoTenant().QueryRow(ctx, `SELECT id, tenant_id FROM gateway_by_credential($1)`, hash).Scan(&me.gateway, &me.tenant)
	}
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if me.conn, err = websocket.Accept(w, r, nil); err != nil {
		return
	}
	defer func() { _ = me.conn.CloseNow() }()
	me.conn.SetReadLimit(-1)
	defer func() {
		// Its sessions are dead (a restart takes the pcs with it): close their clients'
		// sockets now instead of letting ICE notice in ~30 s.
		for _, session := range s.broker.unregister(me) {
			session.kill("gateway gone")
		}
	}()
	s.serveGateway(ctx, me, hash)
}

// serveGateway handles the socket's messages until it closes. The gateway is registered
// with the broker only after a heartbeat of a supported protocol.
func (s *Server) serveGateway(ctx context.Context, me *link, hash string) {
	accepted := false
	limiter := newBucket(200, 50)
	for {
		msg, ok := read(ctx, me.conn, maxMessage, limiter, false)
		if !ok {
			return
		}
		switch t := typeOf(msg); {
		case t == "heartbeat":
			beat := parseHeartbeat(msg)
			if !accepted {
				if beat.Protocol < minGatewayProtocol {
					// Recorded, so the Gateways list says "update required", not just offline.
					_ = s.db.InTenant(ctx, me.tenant, func(tx pgx.Tx) error {
						_, err := tx.Exec(ctx, `UPDATE gateways SET "Protocol" = $1 WHERE "Id" = $2`, beat.Protocol, me.gateway)
						return err
					})
					_ = me.conn.Close(websocket.StatusPolicyViolation, "upgrade required")
					return
				}
				accepted = true
				s.broker.register(me)
			}
			if !s.storeHeartbeat(ctx, me, hash, beat) {
				_ = me.conn.Close(websocket.StatusPolicyViolation, "revoked")
				return
			}
		case (t == "answer" || t == "ice") && accepted:
			// Only into sessions opened for this gateway: a gateway can't inject signaling
			// into another gateway's (or tenant's) session.
			var m proto.Msg[raw, raw]
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			browser := s.broker.session(strings.ToLower(m.Session))
			if browser == nil || browser.gateway != me.gateway {
				continue
			}
			if t == "answer" {
				browser.send(proto.Answer[raw]{Type: "answer", SDP: m.SDP, Tunnel: strings.ToLower(m.Session)})
			} else {
				browser.send(proto.Ice[raw]{Type: "ice", Candidate: m.Candidate})
			}
		case t == "tunnel" && accepted:
			var report proto.Report
			if json.Unmarshal(msg, &report) == nil {
				s.storeReport(ctx, me, report)
			}
		}
	}
}

// parseHeartbeat never fails: a heartbeat whose fields have the wrong types still
// yields its protocol (0 = too old to send one), so it is refused as "upgrade
// required" instead of dropped.
func parseHeartbeat(msg []byte) proto.Heartbeat {
	var beat proto.Heartbeat
	if json.Unmarshal(msg, &beat) != nil {
		var p struct {
			Protocol int `json:"protocol"`
		}
		_ = json.Unmarshal(msg, &p)
		return proto.Heartbeat{Protocol: p.Protocol}
	}
	return beat
}

// storeHeartbeat is false when the credential was revoked. It matches the hash, not
// just the id: a socket that authenticated just before a revoke is closed at its next heartbeat.
func (s *Server) storeHeartbeat(ctx context.Context, me *link, hash string, beat proto.Heartbeat) bool {
	var level *string // missing = a gateway too old to send it; anything but full = off
	if beat.Telemetry != "" {
		l := proto.Off
		if beat.Telemetry == proto.Full {
			l = proto.Full
		}
		level = &l
	}
	live := false
	err := s.db.InTenant(ctx, me.tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE gateways SET "LastSeenAt" = now(), "LanUrl" = $1, "Version" = $2, "Protocol" = $3,
			       "Update" = $4, "Telemetry" = $5, "Name" = coalesce($6, "Name")
			WHERE "Id" = $7 AND "CredentialHash" = $8`,
			safeLanURL(beat.LanURL), bounded(beat.Version, 40), beat.Protocol, bounded(beat.Update, 40), level,
			safeName(beat.Name), me.gateway, hash)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		live = true
		if beat.Telemetry == proto.Full {
			return storeHealth(ctx, tx, me, beat.Health)
		}
		return nil
	})
	return live || err != nil // a database hiccup is not a revocation
}

// A health row at least this often while nothing changes, and never two closer than
// minGap (the heartbeat comes every 30 s, so a gateway can't add rows faster than that).
const (
	snapshotEvery = 5 * time.Minute
	minGap        = 25 * time.Second
)

// storeHealth adds a row when the slow-moving fields differ from the gateway's latest
// row or that row is snapshotEvery old. Each field is cleaned at the boundary: out of
// bounds = null.
func storeHealth(ctx context.Context, tx pgx.Tx, me *link, h *proto.Health) error {
	if h == nil {
		h = &proto.Health{}
	}
	slow := []any{h.Jellyfin.Reachable, bounded(h.Jellyfin.Version, 40), bounded(h.OS, 20), bounded(h.Arch, 20), bounded(h.Transcoding, 20), bounded(h.Offline, 20)}
	var fresh bool
	err := tx.QueryRow(ctx, `
		SELECT now() - "At" < $7 OR (now() - "At" < $8 AND
		       ("JellyfinReachable", "JellyfinVersion", "Os", "Arch", "Transcoding", "Offline") IS NOT DISTINCT FROM ($1::bool, $2::text, $3::text, $4::text, $5::text, $6::text))
		FROM gateway_health WHERE "GatewayId" = $9 ORDER BY "At" DESC LIMIT 1`,
		append(slow, minGap, snapshotEvery, me.gateway)...).Scan(&fresh)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) || fresh {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO gateway_health ("Id", "TenantId", "GatewayId", "At", "Level", "JellyfinReachable", "JellyfinVersion",
		       "Os", "Arch", "Transcoding", "Offline", "Tunnels", "Transcodes", "Cpu", "Memory")
		VALUES (uuidv7(), $7, $8, now(), 'full', $1, $2, $3, $4, $5, $6, $9, $10, $11, $12)`,
		append(slow, me.tenant, me.gateway, count(&h.Tunnels), count(h.Transcodes), percent(h.CPU), percent(h.Memory))...)
	return err
}

// storeReport fills only this gateway's own row (another gateway's session id changes
// nothing), only with the first report (BytesSent null = none yet), and also after the
// browser's socket closed: the broker's row outlives the session.
func (s *Server) storeReport(ctx context.Context, me *link, r proto.Report) {
	var failure, use *string
	if r.Failure != nil {
		failure = clip(*r.Failure, 64)
	}
	if u := clip(r.Use, 16); u != nil && *u != "" {
		use = u
	}
	if r.ActiveMs != nil && *r.ActiveMs < 0 {
		r.ActiveMs = nil
	}
	_ = s.db.InTenant(ctx, me.tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
			UPDATE tunnels SET "Relay" = $1, "Ipv6" = $2, "LocalCandidateType" = $3, "RemoteCandidateType" = $4,
			       "Protocol" = $5, "BytesSent" = $6, "BytesReceived" = $7, "Failure" = $8, "Use" = $9, "ActiveMs" = $10
			WHERE "Id"::text = $11 AND "GatewayId" = $12 AND "BytesSent" IS NULL`,
			r.Relay, r.Ipv6, clip(r.LocalCandidateType, 16), clip(r.RemoteCandidateType, 16), clip(r.Protocol, 16),
			int64(r.BytesSent), int64(r.BytesReceived), failure, use, r.ActiveMs, strings.ToLower(r.Session), me.gateway)
		return err
	})
}

func hasControl(s string) bool { return strings.ContainsFunc(s, unicode.IsControl) }

// Gateway-supplied strings: keep them short, and only text Postgres takes (it refuses NUL).
func clip(s string, maxRunes int) *string {
	if hasControl(s) {
		return nil
	}
	if r := []rune(s); len(r) > maxRunes {
		s = string(r[:maxRunes])
	}
	return &s
}

// Empty, too long or with a control character = null, never cut.
func bounded(s string, maxRunes int) *string {
	if s == "" || len([]rune(s)) > maxRunes || hasControl(s) {
		return nil
	}
	return &s
}

// The gateway owns its name. Blank or with a control character = null: keep the stored name.
func safeName(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return clip(s, 100)
}

// The web app renders this as a link: only plain http(s) URLs, never javascript: etc.
func safeLanURL(s string) *string {
	u, err := url.Parse(s)
	if err != nil || len(s) > 200 || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil
	}
	return &s
}

// ponytail: 10 000 is far above any household's tunnels or transcodes.
func count(n *int) *int {
	if n == nil || *n < 0 || *n > 10_000 {
		return nil
	}
	return n
}

func percent(p *float64) *float64 {
	if p == nil || *p < 0 || *p > 100 {
		return nil
	}
	return p
}

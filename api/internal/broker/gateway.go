package broker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"golang.org/x/time/rate"

	"streamiq/protocol"
)

// MinGatewayProtocol is the oldest gateway protocol (docs/protocol.md) the API still
// speaks. Raising it is a deliberate step: every gateway below it is refused until its
// owner updates.
const MinGatewayProtocol = 1

// Hash is how a gateway credential is stored: SHA-256 hex, never the plaintext.
func Hash(credential string) string {
	h := sha256.Sum256([]byte(credential))
	return hex.EncodeToString(h[:])
}

// gateway is a gateway's control socket, authenticated by its credential (Bearer):
// heartbeats, its half of the brokered sessions and its report of each tunnel.
func (b *Broker) gateway(w http.ResponseWriter, r *http.Request) {
	scheme, credential, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	credential = strings.TrimSpace(credential)
	var me link
	err := pgx.ErrNoRows
	if strings.EqualFold(scheme, "Bearer") && credential != "" {
		// The credential establishes the tenant: a SECURITY DEFINER lookup.
		err = b.DB.NoTenant().QueryRow(r.Context(), `SELECT id, tenant_id FROM gateway_by_credential($1)`,
			Hash(credential)).Scan(&me.gateID, &me.tenant)
	}
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		w.WriteHeader(http.StatusUnauthorized)
		return
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	if me.conn, err = accept(w, r); err != nil {
		return // accept answered the request
	}
	defer func() { _ = me.conn.CloseNow() }()
	b.serveGateway(r.Context(), &me, Hash(credential))

	b.mu.Lock()
	if b.gateways[me.gateID] == &me {
		delete(b.gateways, me.gateID)
	}
	var dead []*websocket.Conn
	for _, s := range b.sessions {
		if s.via == &me {
			dead = append(dead, s.conn)
		}
	}
	b.mu.Unlock()
	// Its sessions are dead (a restart takes the pcs with it): close their browsers'
	// sockets now instead of letting ICE notice in ~30 s.
	for _, c := range dead {
		go kill(c, "gateway gone") // a dead peer's close can take ~10 s each
	}
}

// serveGateway reads the socket's messages until it closes. The gateway is registered
// with the broker only after a heartbeat of a supported protocol.
func (b *Broker) serveGateway(ctx context.Context, me *link, hash string) {
	accepted := false
	lim := rate.NewLimiter(50, 200) // a gateway carries every session of its own
	for m := read(ctx, me.conn, 64<<10, lim, false); m != nil; m = read(ctx, me.conn, 64<<10, lim, false) {
		switch t := str(m, "type"); {
		case t == "heartbeat":
			if !accepted {
				// The protocol before anything else, so whatever else an old gateway sends
				// can't keep it from being listed as "update required".
				if p := protocolOf(m); p < MinGatewayProtocol {
					b.tenant(ctx, me.tenant, `UPDATE gateways SET protocol = $2 WHERE id = $1`, me.gateID, p)
					kill(me.conn, "upgrade required")
					return
				}
				accepted = true
				b.mu.Lock()
				b.gateways[me.gateID] = me // a reconnect replaces the stale link
				b.mu.Unlock()
			}
			if !b.beat(ctx, me, hash, m) {
				kill(me.conn, "revoked")
				return
			}
		case (t == "answer" || t == "ice" || t == "error") && accepted:
			b.relayToBrowser(me, t, m)
		case t == "tunnel" && accepted:
			if rp := parseReport(m); rp != nil {
				b.storeReport(ctx, me, rp)
			}
		}
	}
}

// relayToBrowser forwards only into sessions opened for this gateway: a gateway can't
// inject signaling into another gateway's (or household's) session. Only the fields the
// protocol defines; the answer tells the browser its tunnel id, for its throughput PATCH.
// An error is the gateway refusing the offer (busy): the browser shows it, ICE never starts.
func (b *Broker) relayToBrowser(me *link, t string, m Fields) {
	sid := id(m, "session")
	b.mu.Lock()
	s := b.sessions[sid]
	b.mu.Unlock()
	if s == nil || s.via.gateID != me.gateID {
		return
	}
	switch t {
	case "answer":
		send(s.conn, protocol.Answer[json.RawMessage]{Type: t, SDP: ptr[json.RawMessage](m, "sdp"), Tunnel: sid})
	case "ice":
		send(s.conn, protocol.Ice[json.RawMessage]{Type: t, Candidate: ptr[json.RawMessage](m, "candidate")})
	case "error":
		e := str(m, "error")
		send(s.conn, protocol.ErrorMsg{Type: t, Error: e[:min(len(e), 200)]})
	}
}

// beat stores a heartbeat; false = the credential was revoked. Matching the hash, not
// just the id: a socket that authenticated just before a revoke is closed at its next
// heartbeat.
func (b *Broker) beat(ctx context.Context, me *link, hash string, m Fields) bool {
	h := parseHeartbeat(m)
	live := true
	err := b.DB.InTenant(ctx, me.tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE gateways SET last_seen_at = now(), lan_url = $3, version = $4,
			protocol = $5, update = $6, telemetry = $7, name = coalesce($8, name)
			WHERE id = $1 AND credential_hash = $2`,
			me.gateID, hash, h.LanURL, h.Version, h.Protocol, h.Update, h.Tel, h.Name)
		live = err != nil || tag.RowsAffected() > 0 // a failed write isn't a revoke
		return err
	})
	if err == nil && live && h.Tel != nil && *h.Tel == levelFull {
		hl := parseHealth(m)
		hl.GatewayV = h.Version
		err = b.DB.InTenant(ctx, me.tenant, func(tx pgx.Tx) error { return storeHealth(ctx, tx, me.gateID, hl) })
	}
	if err != nil {
		log.Printf("broker: gateway %s: heartbeat not stored: %v", me.gateID, err)
	}
	return live
}

// storeHealth adds a row when the slow-moving fields differ from the gateway's latest
// row, or that row is 5 minutes old, never within 25 s of it: the heartbeat comes every
// 30 s, so a gateway can't add rows faster than its schedule. Live counts and load
// alone don't make one. Only this household's rows are read (the tenant transaction).
func storeHealth(ctx context.Context, tx pgx.Tx, gatewayID string, h health) error {
	_, err := tx.Exec(ctx, `INSERT INTO gateway_health (id, tenant_id, gateway_id, at, level,
			jellyfin_reachable, jellyfin_version, gateway_version, os, arch, transcoding, offline,
			tunnels, transcodes, cpu, memory)
		SELECT uuidv7(), app_tenant(), $1, now(), 'full', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
		WHERE NOT EXISTS (
			SELECT FROM (SELECT * FROM gateway_health WHERE gateway_id = $1 ORDER BY at DESC LIMIT 1) l
			WHERE now() - l.at < interval '25 seconds'
				OR now() - l.at < interval '5 minutes'
				AND (l.jellyfin_reachable, l.jellyfin_version, l.gateway_version, l.os, l.arch,
					l.transcoding, l.offline)
				IS NOT DISTINCT FROM ($2::boolean, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text))`,
		gatewayID, h.JellyfinReachable, h.JellyfinVersion, h.GatewayV, h.Os, h.Arch, h.Transcoding, h.Offline,
		h.Tunnels, h.Transcodes, h.CPU, h.Memory)
	return err
}

// storeReport fills only this gateway's own row (another gateway's session id changes
// nothing), only the first report (no bytes yet), also after the browser's socket
// closed: the row outlives the session.
func (b *Broker) storeReport(ctx context.Context, me *link, r *report) {
	b.tenant(
		ctx,
		me.tenant,
		`UPDATE tunnels SET relay = $3, ipv6 = $4, local_candidate_type = $5,
		remote_candidate_type = $6, protocol = $7, bytes_sent = $8, bytes_received = $9, failure = $10,
		use = $11, active_ms = $12
		WHERE id = $1 AND gateway_id = $2 AND bytes_sent IS NULL`,
		r.Session,
		me.gateID,
		r.Relay,
		r.Ipv6,
		r.Local,
		r.Remote,
		r.Protocol,
		r.Sent,
		r.Received,
		r.Failed,
		r.Use,
		r.ActiveMs,
	)
}

// tenant runs one statement in tenant's transaction; a failure is logged, never fatal
// to the socket.
func (b *Broker) tenant(ctx context.Context, tenant, sql string, args ...any) {
	err := b.DB.InTenant(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, sql, args...)
		return err
	})
	if err != nil {
		log.Printf("broker: %v", err)
	}
}

package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"

	"streamiq/gateway/proto"
)

type raw = json.RawMessage

// browserSocket is a browser's signaling socket: one WebSocket = one session to one
// gateway. The Firebase ID token arrives as the first message (not a query param: keeps
// it out of logs). The offer may only target an online gateway of a household the caller
// is a member of (checked for the gateway's tenant, never a household the client names);
// the broker stamps the caller's users.id and their role there on it. `ready` carries
// this session's ICE servers. A routed offer inserts its tunnels row (id = session) and
// the socket closing stamps its end.
func (s *Server) browserSocket(w http.ResponseWriter, r *http.Request) {
	// Any origin: the socket carries no cookie, it authenticates in-band.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	conn.SetReadLimit(-1)
	ctx := r.Context()

	user, ok := s.authenticate(ctx, conn)
	if !ok {
		return
	}
	me := &link{conn: conn}
	servers, revoke, err := s.cfg.Turn.iceServers(ctx, user)
	if err != nil {
		log.Printf("TURN credential issue failed; session gets STUN only: %v", err)
		servers = []proto.ICEServer{stun}
	}
	if revoke != "" {
		defer func() {
			if err := s.cfg.Turn.revoke(context.Background(), revoke); err != nil {
				log.Printf("TURN credential revoke failed; it expires after %s: %v", turnTTL, err)
			}
		}()
	}
	me.send(proto.Ready{Type: "ready", ICEServers: servers})

	var session string
	var gateway *link
	defer func() {
		if session != "" && s.broker.end(session) {
			gateway.send(proto.Msg[raw, raw]{Type: "bye", Session: session})
			s.endTunnel(gateway.tenant, session)
		}
	}()
	limiter := newBucket(50, 10)
	for {
		msg, ok := read(ctx, conn, maxMessage, limiter, false)
		if !ok {
			return
		}
		switch typeOf(msg) {
		case "offer":
			var o proto.Offer[raw]
			if gateway != nil || json.Unmarshal(msg, &o) != nil {
				continue
			}
			var forward *proto.Msg[raw, raw]
			if session, gateway, forward = s.offer(ctx, user, me, o); gateway != nil {
				gateway.send(forward)
			}
		case "ice":
			var i proto.Ice[raw]
			if gateway == nil || json.Unmarshal(msg, &i) != nil {
				continue
			}
			gateway.send(proto.Msg[raw, raw]{Type: "ice", Session: session, Candidate: i.Candidate})
		}
	}
}

// authenticate is the same verify path as the HTTP API. An unauthenticated socket gets
// AuthTimeout to speak. false = the socket was closed with the reason. The timeout
// races the read instead of cancelling it: a cancelled read drops the connection, with
// no close frame to carry the reason.
func (s *Server) authenticate(ctx context.Context, conn *websocket.Conn) (string, bool) {
	refuse := func(reason string) (string, bool) {
		_ = conn.Close(websocket.StatusPolicyViolation, reason)
		return "", false
	}
	first := make(chan []byte, 1)
	go func() {
		msg, _ := read(ctx, conn, 8*1024, nil, true)
		first <- msg
	}()
	var auth proto.Auth
	select {
	case <-time.After(s.cfg.AuthTimeout):
		return refuse("auth timeout")
	case msg := <-first:
		if msg == nil || typeOf(msg) != "auth" || json.Unmarshal(msg, &auth) != nil {
			return refuse("auth first")
		}
	}
	user, err := s.signIn(ctx, auth.Token)
	if err != nil {
		return refuse("unauthorized")
	}
	// In no household at all: nothing to offer to, and no TURN credential for it.
	if all, err := s.households(ctx, user); err != nil || len(all) == 0 {
		return refuse("no household")
	}
	return user, true
}

// offer routes an offer. The household is the gateway's tenant, and only if the user
// is a member of it. Not a member = the same answer as unknown/offline (no existence
// oracle). Returns the new session, its gateway and the offer to send it, or no
// gateway after sending the error.
func (s *Server) offer(ctx context.Context, user string, me *link, o proto.Offer[raw]) (string, *link, *proto.Msg[raw, raw]) {
	gateway := s.broker.gateway(strings.ToLower(o.GatewayID))
	var membership *struct{ Role string }
	if gateway != nil {
		if all, err := s.households(ctx, user); err == nil {
			if m := pick(all, gateway.tenant); m != nil {
				membership = &struct{ Role string }{m.Role}
			}
		}
	}
	live := false
	if membership != nil {
		// A socket that authenticated just before its gateway was revoked is still registered.
		_ = s.db.InTenant(ctx, gateway.tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM gateways WHERE "Id" = $1 AND "CredentialHash" IS NOT NULL)`, gateway.gateway).Scan(&live)
		})
	}
	if !live {
		me.send(proto.Error{Type: "error", Error: "gateway offline or unknown"})
		return "", nil, nil
	}
	session := newUUID()
	// The row exists before the gateway hears of the session, so its report finds it.
	// Best-effort: a failed write costs this tunnel its telemetry, never the tunnel.
	err := s.db.InTenant(ctx, gateway.tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "UserId", "Relay", "Ipv6") VALUES ($1, $2, $3, $4, false, false)`,
			session, gateway.tenant, gateway.gateway, user)
		return err
	})
	if err != nil {
		log.Printf("tunnel %s: row not recorded: %v", session, err)
	}
	s.broker.open(session, &link{conn: me.conn, tenant: gateway.tenant, gateway: gateway.gateway, via: gateway})
	return session, gateway, &proto.Msg[raw, raw]{Type: "offer", Session: session, User: user, Role: membership.Role, SDP: o.SDP}
}

func (s *Server) endTunnel(tenant, session string) {
	err := s.db.InTenant(context.Background(), tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `UPDATE tunnels SET "EndedAt" = now() WHERE "Id" = $1`, session)
		return err
	})
	if err != nil {
		log.Printf("tunnel %s: end not recorded: %v", session, err)
	}
}

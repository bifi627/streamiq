package broker

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/time/rate"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/turn"
	"streamiq/protocol"
)

type rawMsg = protocol.Msg[json.RawMessage, json.RawMessage]

// browser is a browser's signaling socket: one socket = one session to one gateway. The
// ID token and the gateway arrive as the first message (never a query parameter: it
// stays out of logs). `ready` carries this session's ICE servers: TURN only for a
// gateway of the user's households that isn't revoked, online or not (one that comes
// online seconds later still gets a relay), tagged as that gateway's (relay usage),
// unless its relay is off (direct only: `ready` says so); else STUN only, the same for
// an unknown or foreign gateway. A revocable TURN
// credential is revoked when the socket closes, which also ends the session (`bye`).
func (b *Broker) browser(w http.ResponseWriter, r *http.Request) {
	conn, err := accept(w, r)
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()
	ctx := r.Context()
	user, named, ok := b.authenticate(ctx, conn)
	if !ok {
		return
	}
	servers, revoke, relayOff, err := b.iceServers(ctx, user, named)
	if err != nil {
		log.Printf("broker: TURN credential not issued, session gets STUN only: %v", err)
		servers = turn.StunOnly()
	}
	if revoke != "" {
		defer func() {
			// Not the request's context: it ends with the socket.
			rctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := b.TURN.Revoke(rctx, revoke); err != nil {
				log.Printf("broker: TURN credential not revoked, it expires after %s: %v", turn.TTL, err)
			}
		}()
	}
	send(conn, protocol.Ready{Type: "ready", ICEServers: servers, RelayOff: relayOff})

	var sid string
	var gw *link
	defer func() { b.endSession(sid, gw) }()
	lim := rate.NewLimiter(10, 50) // one offer plus a few dozen ICE candidates
	for m := read(ctx, conn, 64<<10, lim, false); m != nil; m = read(ctx, conn, 64<<10, lim, false) {
		switch str(m, "type") {
		case "offer":
			// A browser from before auth.gatewayId names none: it got STUN only.
			if named != "" && id(m, "gatewayId") != named {
				send(conn, protocol.ErrorMsg{Type: "error", Error: protocol.GatewayOffline})
			} else if gw == nil {
				sid, gw = b.offer(ctx, conn, user, m)
			}
		case "ice":
			if gw != nil {
				send(gw.conn, rawMsg{Type: "ice", Session: sid, Candidate: ptr[json.RawMessage](m, "candidate")})
			}
		}
	}
}

// iceServers mints a TURN credential tagged as gateway's when it is one of user's
// households', isn't revoked and has its relay on; relayOff = it is such a gateway
// with its relay off.
func (b *Broker) iceServers(ctx context.Context, user, gateway string) (
	servers []json.RawMessage, revoke string, relayOff bool, err error,
) {
	tag := ""
	all, err := b.Auth.Households(ctx, user)
	for _, h := range all {
		if err == nil && tag == "" && gateway != "" {
			err = b.DB.InTenant(ctx, h.ID, func(tx pgx.Tx) error {
				return tx.QueryRow(ctx, `SELECT coalesce(max(relay_tag), ''), coalesce(bool_or(relay_off), false)
					FROM gateways WHERE id = $1 AND credential_hash IS NOT NULL`, gateway).Scan(&tag, &relayOff)
			})
		}
	}
	if err != nil || tag == "" || relayOff {
		return turn.StunOnly(), "", relayOff, err
	}
	servers, revoke, err = b.TURN.Issue(ctx, user, tag)
	return servers, revoke, false, err
}

// authenticate reads the auth message within AuthTimeout: the same token verification
// as the REST API, no bypass. It returns the gateway the message names ("" = none).
// false = the socket was closed with the reason.
func (b *Broker) authenticate(ctx context.Context, conn *websocket.Conn) (user, gateway string, ok bool) {
	// The timer closes the socket instead of cancelling the read: a cancelled read
	// closes it without a reason.
	timeout := time.AfterFunc(b.AuthTimeout, func() { kill(conn, protocol.CloseAuthTimeout) })
	m := read(ctx, conn, 8<<10, nil, true)
	if !timeout.Stop() {
		return "", "", false
	}
	if m == nil || str(m, "type") != "auth" {
		kill(conn, protocol.CloseAuthFirst)
		return "", "", false
	}
	c, err := b.Auth.Token(ctx, str(m, "token")) // missing = "", which fails verification
	if errors.Is(err, auth.ErrBadToken) {
		kill(conn, protocol.CloseUnauthorized)
		return "", "", false
	}
	if err != nil {
		kill(conn, protocol.CloseServerError)
		return "", "", false
	}
	// In no household at all: nothing to offer to, and no TURN credential for it.
	if len(c.Households) == 0 {
		kill(conn, protocol.CloseNoHousehold)
		return "", "", false
	}
	return c.User, id(m, "gatewayId"), true
}

// offer routes an offer: only to an online gateway of a household the user is a member
// of now (checked for the gateway's household, never one the browser names), stamped
// with the user's users.id and their role there. A gateway that isn't one gets the same
// answer as an unknown or offline one (no existence oracle). It returns the new session
// and its gateway, or "" and nil after sending the error.
func (b *Broker) offer(ctx context.Context, conn *websocket.Conn, user string, m Fields) (string, *link) {
	b.mu.Lock()
	gw := b.gateways[id(m, "gatewayId")]
	b.mu.Unlock()
	role := ""
	if gw != nil {
		role = b.role(ctx, user, gw)
	}
	if role == "" {
		send(conn, protocol.ErrorMsg{Type: "error", Error: protocol.GatewayOffline})
		return "", nil
	}
	sid := uuid.NewString()
	b.mu.Lock()
	b.sessions[sid] = &session{conn: conn, via: gw}
	b.mu.Unlock()
	send(gw.conn, rawMsg{Type: "offer", Session: sid, User: user, Role: role, SDP: ptr[json.RawMessage](m, "sdp")})
	return sid, gw
}

// role is the user's role in gw's household, "" when they aren't a member or gw's
// credential is revoked (its socket may still be open).
func (b *Broker) role(ctx context.Context, user string, gw *link) string {
	all, err := b.Auth.Households(ctx, user)
	role := ""
	for _, h := range all {
		if h.ID == gw.tenant {
			role = h.Role
		}
	}
	live := false
	if err == nil && role != "" {
		err = b.DB.InTenant(ctx, gw.tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM gateways WHERE id = $1 AND credential_hash IS NOT NULL)`,
				gw.gateID).
				Scan(&live)
		})
	}
	if err != nil {
		log.Printf("broker: offer to %s refused: %v", gw.gateID, err)
	}
	if !live {
		return ""
	}
	return role
}

// endSession tells the gateway, once.
func (b *Broker) endSession(sid string, gw *link) {
	if gw == nil {
		return
	}
	b.mu.Lock()
	_, held := b.sessions[sid]
	delete(b.sessions, sid)
	b.mu.Unlock()
	if !held {
		return
	}
	send(gw.conn, rawMsg{Type: "bye", Session: sid})
}

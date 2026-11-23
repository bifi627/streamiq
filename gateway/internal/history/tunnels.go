package history

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"time"

	"streamiq/gateway/internal/tunnel"
	"streamiq/protocol"
)

// TunnelLimit caps GET /streamiq/tunnels.
const TunnelLimit = 200

// Tunnels is the gateway's tunnel history: one line per ended tunnel.
type Tunnels struct{ Store *Store }

// Record appends the line of a tunnel that ended at end.
func (t *Tunnels) Record(r protocol.Report, user string, start, end time.Time, kbps int) error {
	l := Tunnel{
		ID: r.Session, CreatedAt: start.UTC(), EndedAt: end.UTC(), UserID: user,
		Relay: r.Relay, IPv6: r.Ipv6, BytesSent: r.BytesSent, BytesReceived: r.BytesReceived,
		Failure: r.Failure, ActiveMs: r.ActiveMs,
	}
	if kbps > 0 {
		l.ThroughputKbps = &kbps
	}
	if r.Use != "" {
		l.Use = &r.Use
	}
	return t.Store.Append(end, l)
}

// Ended records a tunnel that ends now (sessions.Sessions.Ended); a failed write is logged.
func (t *Tunnels) Ended(r protocol.Report, user string, start time.Time, kbps int) {
	if err := t.Record(r, user, start, time.Now(), kbps); err != nil {
		log.Printf("gateway: tunnel history: %v", err)
	}
}

// recent is the lines of the last TunnelDays, newest first.
func (t *Tunnels) recent(now time.Time) ([]Tunnel, error) {
	rows, err := Read[Tunnel](t.Store)
	start := now.AddDate(0, 0, -TunnelDays)
	rows = slices.DeleteFunc(rows, func(l Tunnel) bool { return !l.CreatedAt.After(start) })
	slices.SortStableFunc(rows, func(a, b Tunnel) int { return b.CreatedAt.Compare(a.CreatedAt) })
	return rows, err
}

// ServeList is GET /streamiq/tunnels: the session's user's own tunnels, or with
// ?scope=household (admin only) every member's with their userId; newest first, at
// most TunnelLimit. Who asks comes from the session, never the request.
func (t *Tunnels) ServeList(w http.ResponseWriter, r *http.Request) {
	who := tunnel.SessionOf(r)
	scope := r.URL.Query()["scope"]
	household := len(scope) > 0 && scope[0] == "household"
	switch {
	case len(scope) > 0 && !household:
		tunnel.Fail(w, http.StatusBadRequest, errors.New("tunnels: unknown scope"))
		return
	case household && who.Role != tunnel.Admin:
		tunnel.Fail(w, http.StatusForbidden, errors.New("tunnels: the household scope is admin-only"))
		return
	}
	rows, err := t.recent(time.Now())
	if err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	out := []Tunnel{}
	for _, l := range rows {
		if len(out) == TunnelLimit {
			break
		}
		switch {
		case household:
			out = append(out, l)
		case l.UserID == who.User:
			l.UserID = ""
			out = append(out, l)
		}
	}
	tunnel.JSON(w, http.StatusOK, out)
}

// ServeSummary is GET /streamiq/tunnels/summary (admin only): per user over every
// line of the last TunnelDays, most tunnels first.
func (t *Tunnels) ServeSummary(w http.ResponseWriter, _ *http.Request) {
	rows, err := t.recent(time.Now())
	if err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	tunnel.JSON(w, http.StatusOK, summarize(rows))
}

func summarize(rows []Tunnel) []Summary {
	out := []Summary{}
	at := map[string]int{}
	for _, l := range rows {
		i, ok := at[l.UserID]
		if !ok {
			i = len(out)
			at[l.UserID] = i
			out = append(out, Summary{UserID: l.UserID})
		}
		s := &out[i]
		s.Tunnels++
		switch {
		case l.Failure != nil:
			s.Failed++
		case l.Use != nil && (*l.Use == "management" || *l.Use == "diagnostics"):
			s.Hidden++
		}
		if l.Relay {
			s.RelayedBytes += l.BytesSent + l.BytesReceived
		}
	}
	slices.SortStableFunc(out, func(a, b Summary) int { return b.Tunnels - a.Tunnels })
	return out
}

// ServeThroughput is POST /streamiq/tunnels/throughput: the calling session's own
// tunnel keeps it for its history line; missing, zero or negative = none.
func ServeThroughput(w http.ResponseWriter, r *http.Request) {
	var b Throughput
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("tunnels: throughput: bad body"))
		return
	}
	tunnel.SessionOf(r).Use.SetThroughput(b.ThroughputKbps)
	w.WriteHeader(http.StatusNoContent)
}

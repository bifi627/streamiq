package pairing

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"streamiq/gateway/internal/tunnel"
)

// Gateway API (docs/protocol.md), both admin-only (tunnel.AdminOnly at
// registration): RequestsPath lists the pending pairing requests, GET →
// [PairingRequest]; DecidePath approves or rejects one like the local page,
// POST PairingDecision → 200 {}, an unknown or expired id 404.
const (
	RequestsPath = "/streamiq/pairing/requests"
	DecidePath   = "/streamiq/pairing/decide"
)

// ServeRequests is GET RequestsPath.
func (s *Store) ServeRequests(w http.ResponseWriter, _ *http.Request) {
	out := []PairingRequest{}
	for _, p := range s.Pending() {
		out = append(out, PairingRequest{p.ID, p.Name, p.Code, p.User, p.Expires})
	}
	tunnel.JSON(w, http.StatusOK, out)
}

// ServeDecide is POST DecidePath.
func (s *Store) ServeDecide(w http.ResponseWriter, r *http.Request) {
	var in PairingDecision
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<10))
	if json.Unmarshal(b, &in) != nil || in.ID == "" {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("gateway API: decide pairing: bad body"))
		return
	}
	switch err := s.Decide(in.ID, in.Approve); {
	case errors.Is(err, ErrNoRequest):
		tunnel.Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: decide pairing: %w", err))
	case err != nil:
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: decide pairing: %w", err))
	default:
		tunnel.JSON(w, http.StatusOK, struct{}{})
	}
}

package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // TURN REST (coturn --use-auth-secret) is HMAC-SHA1 by definition
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"streamiq/gateway/proto"
)

// TurnConfig picks where a session's ICE servers come from. Prod: Cloudflare mints a
// credential per session and the broker revokes it at the session's end. Dev: coturn's
// TURN REST scheme, expiry only. Neither: STUN only.
type TurnConfig struct {
	CloudflareKeyID, CloudflareToken string
	URLs                             []string // coturn
	Secret                           string
}

// Backstop for a credential whose revoke never happened; must outlast a relayed session.
const turnTTL = 4 * time.Hour

const cloudflareTurn = "https://rtc.live.cloudflare.com/v1/turn/keys"

var stun = proto.ICEServer{URLs: []string{"stun:stun.l.google.com:19302"}}

// A slow TURN provider must not stall the session: fail fast to STUN.
var turnHTTP = &http.Client{Timeout: 5 * time.Second}

// iceServers returns one session's servers, and the username to revoke at its end ("" = none).
func (c TurnConfig) iceServers(ctx context.Context, label string) ([]proto.ICEServer, string, error) {
	switch {
	case c.CloudflareKeyID != "":
		var out struct {
			ICEServers []proto.ICEServer `json:"iceServers"`
		}
		body, _ := json.Marshal(map[string]int{"ttl": int(turnTTL.Seconds())})
		if err := c.cloudflare(ctx, c.CloudflareKeyID+"/credentials/generate-ice-servers", body, &out); err != nil {
			return nil, "", err
		}
		for _, s := range out.ICEServers {
			if s.Username != "" {
				return out.ICEServers, s.Username, nil
			}
		}
		return out.ICEServers, "", nil
	case len(c.URLs) > 0:
		// username = "<unix expiry>:<label>", credential = base64(HMAC-SHA1(secret, username)).
		username := fmt.Sprintf("%d:%s", time.Now().Add(turnTTL).Unix(), label)
		mac := hmac.New(sha1.New, []byte(c.Secret))
		mac.Write([]byte(username))
		return []proto.ICEServer{stun, {URLs: c.URLs, Username: username, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil))}}, "", nil
	}
	return []proto.ICEServer{stun}, "", nil
}

func (c TurnConfig) revoke(ctx context.Context, username string) error {
	return c.cloudflare(ctx, c.CloudflareKeyID+"/credentials/"+url.PathEscape(username)+"/revoke", nil, nil)
}

func (c TurnConfig) cloudflare(ctx context.Context, path string, body []byte, out any) error {
	rq, err := http.NewRequestWithContext(ctx, http.MethodPost, cloudflareTurn+"/"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	rq.Header.Set("Authorization", "Bearer "+c.CloudflareToken)
	rq.Header.Set("Content-Type", "application/json")
	rs, err := turnHTTP.Do(rq)
	if err != nil {
		return err
	}
	defer rs.Body.Close()
	if rs.StatusCode/100 != 2 {
		return fmt.Errorf("TURN provider: %s", rs.Status)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(rs.Body).Decode(out)
}

// TurnFromEnv reads the same variables the .NET API does.
func TurnFromEnv(get func(string) string) TurnConfig {
	c := TurnConfig{CloudflareKeyID: get("CLOUDFLARE_TURN_KEY_ID"), CloudflareToken: get("CLOUDFLARE_TURN_API_TOKEN"), Secret: get("STREAMIQ_TURN_SECRET")}
	if u := get("STREAMIQ_TURN_URLS"); u != "" {
		c.URLs = strings.Split(u, ",")
	}
	return c
}

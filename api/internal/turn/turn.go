// Package turn is the ICE servers of ONE brokered session, handed out in the broker's
// `ready` (never from an endpoint of their own). Prod: Cloudflare mints a credential per
// session (CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN), revoked when the
// session's socket closes. Dev: coturn's TURN REST scheme (STREAMIQ_TURN_URLS +
// STREAMIQ_TURN_SECRET), expiry only. Neither: STUN only.
package turn

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1" // coturn's TURN REST scheme is HMAC-SHA1
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// TTL is the backstop for a credential whose revoke never happened (crash, Cloudflare
// down). ponytail: must outlast a relayed session, since TURN refreshes need a valid
// credential: a relayed session past 4 h drops at its next refresh. Upgrade path: push
// fresh servers in-band → pc.setConfiguration.
const TTL = 4 * time.Hour

const stun = `{"urls":["stun:stun.l.google.com:19302"]}`

type Issuer struct {
	KeyID, Token string   // Cloudflare
	URLs         []string // coturn
	Secret       string
	Cloudflare   string // the keys API; tests point it at a fake
	HTTP         *http.Client
}

func FromEnv() *Issuer {
	i := &Issuer{
		KeyID:      os.Getenv("CLOUDFLARE_TURN_KEY_ID"),
		Token:      os.Getenv("CLOUDFLARE_TURN_API_TOKEN"),
		Secret:     os.Getenv("STREAMIQ_TURN_SECRET"),
		Cloudflare: "https://rtc.live.cloudflare.com/v1/turn/keys",
		// A slow TURN provider must not stall the session: fail fast to STUN.
		HTTP: &http.Client{Timeout: 5 * time.Second},
	}
	if u := os.Getenv("STREAMIQ_TURN_URLS"); u != "" {
		i.URLs = strings.Split(u, ",")
	}
	return i
}

func StunOnly() []json.RawMessage { return []json.RawMessage{json.RawMessage(stun)} }

// Issue mints label's servers. Cloudflare's carry tag as their customIdentifier, which
// its usage analytics group by. revoke is set when the credential can (and must)
// be revoked at the session's end.
func (i *Issuer) Issue(ctx context.Context, label, tag string) (servers []json.RawMessage, revoke string, err error) {
	switch {
	case i.KeyID != "":
		return i.cloudflare(ctx, tag)
	case len(i.URLs) > 0:
		// TURN REST (coturn --use-auth-secret): username = "<unix expiry>:<label>",
		// credential = base64(HMAC-SHA1(secret, username)).
		username := fmt.Sprintf("%d:%s", time.Now().Add(TTL).Unix(), label)
		mac := hmac.New(sha1.New, []byte(i.Secret))
		mac.Write([]byte(username))
		turn, err := json.Marshal(map[string]any{
			"urls":       i.URLs,
			"username":   username,
			"credential": base64.StdEncoding.EncodeToString(mac.Sum(nil)),
		})
		return []json.RawMessage{json.RawMessage(stun), turn}, "", err
	}
	return StunOnly(), "", nil
}

func (i *Issuer) cloudflare(ctx context.Context, tag string) ([]json.RawMessage, string, error) {
	body, err := json.Marshal(map[string]any{"ttl": int(TTL.Seconds()), "customIdentifier": tag})
	if err != nil {
		return nil, "", err
	}
	rs, err := i.post(ctx, i.KeyID+"/credentials/generate-ice-servers", string(body))
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = rs.Body.Close() }()
	var out struct{ IceServers []json.RawMessage }
	if err := json.NewDecoder(rs.Body).Decode(&out); err != nil {
		return nil, "", err
	}
	if out.IceServers == nil {
		return nil, "", errors.New("TURN provider: no iceServers")
	}
	// Passed through as they are: we trickle ICE, so the browser-blocked :53 URLs only
	// cost a failed candidate.
	for _, s := range out.IceServers {
		var u struct{ Username *string }
		if json.Unmarshal(s, &u) == nil && u.Username != nil {
			return out.IceServers, *u.Username, nil
		}
	}
	return out.IceServers, "", nil
}

func (i *Issuer) Revoke(ctx context.Context, username string) error {
	rs, err := i.post(ctx, i.KeyID+"/credentials/"+url.PathEscape(username)+"/revoke", "")
	if err == nil {
		_ = rs.Body.Close()
	}
	return err
}

// post is a Cloudflare call; a status other than 2xx is an error.
func (i *Issuer) post(ctx context.Context, path, body string) (*http.Response, error) {
	rq, err := http.NewRequestWithContext(ctx, http.MethodPost, i.Cloudflare+"/"+path, bytes.NewBufferString(body))
	if err != nil {
		return nil, err
	}
	rq.Header.Set("Authorization", "Bearer "+i.Token)
	rq.Header.Set("Content-Type", "application/json")
	rs, err := i.HTTP.Do(rq)
	if err != nil {
		return nil, err
	}
	if rs.StatusCode/100 != 2 {
		_ = rs.Body.Close()
		return nil, fmt.Errorf("TURN provider: %s", rs.Status)
	}
	return rs, nil
}

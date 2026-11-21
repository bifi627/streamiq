package turn

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDevCredentialsAreShortLivedTURNRESTCredentials(t *testing.T) {
	i := &Issuer{URLs: []string{"turn:127.0.0.1:3478?transport=udp"}, Secret: "s3cret"}
	servers, revoke, err := i.Issue(t.Context(), "user-1")
	if err != nil || revoke != "" || len(servers) != 2 { // coturn's can't be revoked, only expire
		t.Fatal(err, revoke, len(servers))
	}
	var turn struct {
		URLs                 []string
		Username, Credential string
	}
	if err := json.Unmarshal(servers[1], &turn); err != nil {
		t.Fatal(err)
	}
	expiry, _ := strconv.ParseInt(strings.Split(turn.Username, ":")[0], 10, 64)
	left := time.Until(time.Unix(expiry, 0))
	mac := hmac.New(sha1.New, []byte("s3cret"))
	mac.Write([]byte(turn.Username))
	if left < TTL-time.Minute || left > TTL || !strings.HasSuffix(turn.Username, ":user-1") ||
		turn.Credential != base64.StdEncoding.EncodeToString(mac.Sum(nil)) || turn.URLs[0] != i.URLs[0] {
		t.Fatalf("%+v, %s left", turn, left)
	}
}

func TestNeitherIsStunOnly(t *testing.T) {
	servers, revoke, err := (&Issuer{}).Issue(t.Context(), "u")
	if err != nil || revoke != "" || len(servers) != 1 || !strings.Contains(string(servers[0]), `"stun:`) {
		t.Fatal(servers, err)
	}
}

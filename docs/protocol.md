# StreamIQ signaling protocol

Contract-first (per CLAUDE.md): onboarding, broker, pairing, tunnel. Codegen
(C#/Go/TS from one schema) is deferred until the protocol stabilizes; for now
messages are hand-mirrored in Go (`gateway/internal/{onboarding,sessions,pairing,tunnel}`),
C# (`Features/Broker`) and TS (`frontend/src/features/pairing`, `frontend/src/tunnel.ts`).

**Paths.** Every API endpoint is under `/api` (#120); the rest of the path space
belongs to the SPA's client routes (prod serves `index.html` for them, unknown
`/api/*` paths are 404). `/healthz` stays at the root. `STREAMIQ_API_URL` is the
origin only; clients append `/api/…` themselves.

## Gateway onboarding (MVP item 2)

Design: `superpowers/specs/2026-11-01-streamiq-agent-pairing-design.md`.
Fingerprints everywhere use the form `sha-256 AA:BB:…` (32 upper-case hex
pairs, SHA-256 over the DER certificate).

**`POST /api/gateways/enrollment-tokens`** (Firebase Bearer) →
`{ token, expiresAt, installCommand, installCommandPowershell }`. Token is
random 128 bit, single-use, 15 min; the API stores only its SHA-256.

**`POST /api/gateways/enroll`** (no auth — the token is the auth)
```json
{ "token": "…", "fingerprint": "sha-256 AB:…", "name": "nas" }
```
→ `200 { "gatewayId": "<uuid>", "credential": "…" }` (credential: 256 bit,
shown once, the API keeps its SHA-256) · `400` malformed fingerprint ·
`401` token unknown, expired, or used.

**`GET /api/gateways/ws`** — gateway control WebSocket, `Authorization: Bearer
<credential>` (`401` before upgrade if unknown or revoked). Gateway → API, one JSON text
frame on connect and every 30 s:
```json
{ "type": "heartbeat", "lanUrl": "http://192.168.1.20:8097", "version": "1.4.0",
  "os": "windows", "arch": "amd64", "startedAt": "2026-11-10T08:00:00Z", "update": "1.5.0",
  "jellyfin": { "reachable": true, "version": "10.11.2", "untested": false, "token": "ok" },
  "pairedClients": 2, "activeSessions": 1 }
```
The API sets `last_seen_at = now`, `lan_url` (http/https only, else null) and
`version` (≤ 40 chars, else null; `"dev"` for source builds). `version` is
optional: older gateways omit it.

The rest is the **status snapshot** (#129), stored as `gateways.status` (jsonb) and
returned as `status` by `GET /api/gateways`, last known while offline. Every field is
optional; the API keeps only these, each checked, and drops the rest:
`os`, `arch` (≤ 20 chars), `update` (newer release version, absent = up to date; ≤ 40),
`startedAt` (ISO 8601, stored as UTC), `pairedClients`, `activeSessions` (ints
0–100000), `jellyfin.reachable`, `jellyfin.untested` (bools), `jellyfin.version` (≤ 40),
`jellyfin.token` (`ok` | `missing` | `legacy` = pre-#50 admin API key). Counts only:
no client names or anything else that identifies a person (#65). No status fields →
`status` null.

**`DELETE /api/gateways/{id}`** (Firebase Bearer) → `204`: revokes the gateway's
credential (row kept, hidden from `GET /api/gateways`; its telemetry stays). The
broker closes its control socket (`1008 "revoked"`) and every browser session
through it (`1008 "gateway revoked"`). Another tenant's or an already revoked
gateway → `404`. A gateway that authenticated just before the revoke is closed
at its next heartbeat. Re-adding the box = re-enroll (`docs/install.md`).

**Rate limits.** `/api/broker/ws`, `/api/gateways/ws` and `/api/gateways/enroll` share a
budget of 120 new requests per client IP per minute; over it → `429` (for a
socket: the upgrade is refused). A flood shield, not a per-user quota: a
household needs a handful per minute, and the headroom keeps many users behind
one shared IP (carrier NAT, office) clear of it. On an open socket, a message past its token
bucket (browser: burst 50, 10/s; gateway: burst 200, 50/s) closes it with
`1008 "rate limited"`. A browser socket must send `auth` within 10 s.
`GET /api/gateways` reports `online` = last heartbeat within 90 s. The same socket
carries the gateway's half of the broker (below).

## Broker (MVP item 3)

Tenant-scoped signaling. One JSON object per WebSocket text frame. The broker
relays SDP/ICE; it can't make either side trust the other (pins + pairing do).

**`GET /api/broker/ws`** — browser socket, **one socket = one session to one gateway**.
Closing it ends the session (broker sends the gateway `bye`).

| direction | message |
|---|---|
| browser → broker | `{type:"auth", token:"<Firebase ID token>"}` — first frame (not a query param: keeps it out of logs). Bad token → close `1008`. |
| broker → browser | `{type:"ready", iceServers}` — this session's ICE servers (below) |
| browser → broker | `{type:"offer", gatewayId, sdp}` — browser is the offerer |
| broker → browser | `{type:"error", error:"gateway offline or unknown"}` — also for another tenant's gateway (no existence oracle) |
| browser → broker | `{type:"ice", candidate}` |
| broker → browser | `{type:"answer", sdp}` · `{type:"ice", candidate}` |

**Gateway side** (on `/api/gateways/ws`): broker → gateway `{type:"offer", session, sdp}`,
`{type:"ice", session, candidate}`, `{type:"bye", session}`; gateway → broker
`{type:"answer"|"ice", session, …}`. The broker only routes a gateway's message
into a session opened *for that gateway*. The gateway keeps one PeerConnection
per session (several browsers at once).

## ICE servers + connection telemetry (MVP item 5)

**ICE servers come per session, in the broker's `ready`** (there is no
free-standing TURN endpoint; item 6). Prod: Cloudflare `generate-ice-servers`
mints a fresh credential for each broker socket, passed through, and the broker
revokes it when the socket closes (= the session ends: the gateway gets `bye`).
TTL 4 h is only the backstop for a failed revoke; it must outlast a relayed
session because TURN refreshes need a valid credential. Dev: TURN REST creds for
`STREAMIQ_TURN_URLS`, `username = "<unix expiry>:<user id>"`, `credential =
base64(HMAC-SHA1(STREAMIQ_TURN_SECRET, username))` (coturn `--use-auth-secret`),
expiry only. Neither configured, or Cloudflare failing: STUN only. The browser
applies them with `setConfiguration` before creating its offer. `?relay` in the
app URL, or "Force relay" in the Diagnostics panel (header button, for TVs that
can't edit the URL; `?debug` also opens it), sets `iceTransportPolicy: "relay"`
(diagnostic; the e2e uses the panel). The
gateway stays on its own config (STUN, optional `STREAMIQ_ICE_*`): the browser's
relay candidate is enough, as the e2e's forced-relay step shows.

**Telemetry**: once the tunnel is up the browser reads the selected candidate
pair from `getStats()` and calls `POST /api/connections`
`{gatewayId, relay, ipv6, localCandidateType, remoteCandidateType, protocol}` →
`{id}`; on close, `PATCH /api/connections/{id}` `{bytesReceived, bytesSent}` (stamps
`EndedAt`). Rows live in `connection_sessions` (tenant-owned, global filter;
another tenant's gateway or row → `404`). A closed tab skips the PATCH.
A failed attempt (ICE `failed`, pin mismatch, unpaired, broker or gateway
closed, refused) posts `{gatewayId, failure}` instead: candidate fields null,
`failure` = the reason (≤ 64 chars). Rate queries: `failure IS NULL` = up.
`relay` = either selected candidate is a relay. Chrome can report a relayed
local candidate as `prflx`; only relay candidates carry `relayProtocol`, so
that counts too. The same reading drives the player's privacy indicator
(polled every 2 s).

## Pairing + connection auth (MVP item 3)

Design: `superpowers/specs/2026-11-01-streamiq-agent-pairing-design.md`. Browser
identity = non-extractable WebCrypto ECDSA P-256 **client key**; its
fingerprint = `sha-256 AA:…` over the SPKI bytes. The **gateway pin** = the
gateway's DTLS fingerprint (`a=fingerprint` of the answer SDP). The browser
checks the pin **before** `setRemoteDescription` and refuses on mismatch
(pairing again is allowed: the comparison code authenticates the new cert).

The browser opens a data channel labelled **`auth`** (JSON text frames). Until
it is authorized, the gateway closes every other channel immediately.

| # | direction | message |
|---|---|---|
| 1 | gateway → browser | `{type:"challenge", n}` — n = hex(32 random bytes) |
| 2 | browser → gateway | `{type:"auth", spki, sig, pair}` (base64; `pair:true` when the browser has no pin matching this gateway cert — forces steps 4–8 even for an allowlisted key, so a changed cert is only accepted via the code). `sig` = ECDSA P-256/SHA-256, **raw r‖s (64 bytes, IEEE P1363)** over `utf8("streamiq-auth-v1\|" + gatewayDtlsFp + "\|" + browserDtlsFp + "\|" + n)` — both DTLS fps of *this* session, so a MITM can't relay it |
| 3 | gateway → browser | `{type:"ok"}` (key on the allowlist and no `pair` → tunnel channels allowed) or `{type:"unpaired"}` |
| 4 | browser → gateway | `{type:"commit", h, name}` — h = hex(SHA-256(utf8(nB))), nB = hex(32 random bytes) |
| 5 | gateway → browser | `{type:"nonce", n: nA}` — only after the commit |
| 6 | browser → gateway | `{type:"reveal", n: nB}` — gateway checks it against h |
| 7 | both | `code = uint32_be(SHA-256(utf8(gatewayFp + "\|" + keyFp + "\|" + nA + "\|" + nB))[0..4]) mod 1e6`, zero-padded to 6 digits; gateway page lists the request (name + code), browser shows the code |
| 8 | gateway → browser | `{type:"approved"}` after **Approve on the gateway's local page** (key persisted to `allowlist.json`; browser stores the pin), or `{type:"rejected", reason}` (Reject, 5-min expiry, >3 pending, bad signature/reveal) |

The commit makes the code ungrindable: a MITM gets one guess (10⁻⁶).

**Remove** (gateway's local page) drops the key from `allowlist.json` and closes
every open session authed with it: the gateway closes the PeerConnection, so all
its channels end. Signaling can't do this — the tunnel is peer-to-peer and the
broker never sees client keys. No message is sent; the browser sees the
connection close, and its next connect gets `unpaired`.

**Shared test vectors** (asserted in `gateway/internal/pairing` and
`frontend/src/features/pairing/crypto.test.ts`; generated with WebCrypto):

```
pkcs8     MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNfSxgTmdmEdSnpZREJ8zENfSXNkksKt+maxxPfmM/0OhRANCAASZO24jDJAtjsPMwyNMixSTFrNaCBNOcl++jKq1UlDMtdhrPnx+TVcO+RDzLnEwFciaW/hHW06pJCe99d4wkcc3
spki      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmTtuIwyQLY7DzMMjTIsUkxazWggTTnJfvoyqtVJQzLXYaz58fk1XDvkQ8y5xMBXImlv4R1tOqSQnvfXeMJHHNw==
keyFp     sha-256 40:F0:B4:7F:13:E4:C0:9B:73:86:7F:7A:77:E1:16:71:A2:AF:84:61:A0:8F:9F:15:25:CB:FE:7F:82:8A:C6:10
gatewayFp   sha-256 D4:F0:BC:5A:29:DE:06:B5:10:F9:AA:42:8F:1E:ED:BA:92:60:12:B5:91:FE:F7:A5:18:E7:76:A7:C9:BD:18:24
browserFp sha-256 D4:C3:E8:A1:12:56:AB:82:A4:FC:72:56:0E:B4:A2:B0:E8:7B:AD:82:0C:29:0D:D9:B0:36:16:DE:24:0A:A6:DB
n         00…01 (64 hex chars)
sig       jXq2DxskrRUJ2/lPhsID2biFys0vK47f+Z9XNWopW2mdfxatIsNm8/UtQV6feHlf/U42r5ERviRotv6W8GE0GQ==   (verifies)
code(gatewayFp, keyFp, nA="11"×32, nB="22"×32) = 138781
```

Once authorized, tunnel requests use the framing below, one channel each.

## Tunnel framing (MVP item 5)

The browser tunnels HTTP to the gateway's local Jellyfin over data channels.
**One data channel per request**: the channel *is* the request/response
lifecycle. There are no request IDs, no length prefixes and no multiplexing, so
there's no head-of-line blocking between requests. Any channel label other than
`auth` is a tunnel request.

Sequence on a request channel:

1. **Browser → gateway** (one text frame): the request.
   ```json
   { "method": "GET", "url": "/Items?parentId=…", "headers": { "Range": "bytes=0-99" }, "body": "{…}" }
   ```
   `url` is origin-relative. `body` is optional, a UTF-8 string of at most
   64 KB (small JSON for `POST`; `Content-Type` defaults to `application/json`).
   Headers are forwarded, except credentials (below). **`Range` must survive
   intact or seek breaks.**
2. **Gateway → browser** (one text frame): the response head.
   ```json
   { "status": 206, "headers": { "Content-Range": "bytes 0-99/9723", "...": "..." } }
   ```
   A refused request gets a head (then EOF) only: `403` (not allowlisted), `413` (body too
   large), `503` (gateway has no Jellyfin key), `502` (Jellyfin unreachable).
3. **Gateway → browser** (zero or more binary frames): the body, in ~16 KB
   chunks under `bufferedAmount` backpressure. A whole segment is never sent
   as one message.
4. **Gateway → browser** (one text frame): `{"eof":true}`, the end of the body.
5. **Browser closes the channel.** The gateway closes only if the browser hasn't
   within 10 s (`EOFGrace`). A channel that closes before the EOF frame is a
   failed request. The gateway must not close first: Chrome 87 (webOS TVs) drops
   frames still in flight on a remote close (#71, #72).

The head and EOF are **text** frames and body chunks are **binary**, so the
browser tells them apart by type.

**Media bytes are untouched.** The gateway never negotiates or applies
content compression for the browser. Go's default transport would inject
`Accept-Encoding: gzip` and silently decompress, which rewrites the body and
drops `Content-Length`. Compression stays end-to-end. The one rewrite is
key redaction in text responses (below).

### Jellyfin policy (gateway, `gateway/internal/tunnel/jellyfin.go`)

The browser authenticates to StreamIQ, never to Jellyfin, and a paired browser
stays a *viewer*:

- **Credential injection.** The gateway holds a Jellyfin user token for the
  hidden, non-admin user `streamiq-viewer` (`gateway/internal/jellyfin` creates
  it with an admin session it doesn't keep; `state/jellyfin.json`). It sets
  `Authorization: MediaBrowser Token="…"`, and drops browser-sent `Authorization`,
  `Cookie`, `X-Emby-*` and `X-MediaBrowser-*` headers, and `api_key`/`ApiKey`
  query parameters. Jellyfin itself refuses admin calls with this token. The
  viewer's policy: not admin, hidden, no content deletion, no remote control of
  other users or shared devices, no public sharing, no collection, subtitle,
  lyric or Live TV management; all libraries.
- **User pinning.** Every request gets `userId=<viewer id>`, and any
  browser-sent `userId` is dropped (Jellyfin also answers `403` to another
  user's id with this token). Tenant = household = one Jellyfin user. A
  gateway set up before #50 still runs on an admin API key pinned to the user
  stored with it, until the next admin login on its local page replaces it.
- **Allowlist.** Defense in depth on top of the viewer token: only these pass
  (anything else is `403`):

  | method | path |
  |---|---|
  | GET | `/System/Info/Public` |
  | GET | `/UserViews`, `/Items`, `/UserItems/Resume`, `/Items/{id}` |
  | GET | `/Shows/{id}/Seasons`, `/Shows/{id}/Episodes` |
  | GET | `/Items/{id}/Images/{type}[/{index}]` |
  | GET | `/Videos/{id}/…` (HLS playlists, segments, subtitles) |
  | POST | `/Items/{id}/PlaybackInfo` |
  | POST | `/UserItems/{id}/UserData` (resume position, played) |

  The path must already be clean: no `..`, no `//`, no percent-encoding, not
  absolute. `{id}` is 32–36 hex digits or dashes. `/Videos/` matches in any
  case (Jellyfin routes case-insensitively; `PlaybackInfo`'s `TranscodingUrl`
  says `/videos/`).
- **Redaction.** Jellyfin writes `ApiKey=<token>` into the URLs inside its HLS
  playlists. Text responses (`json`, `mpegurl`, `text/*`, at most 16 MB) are
  buffered, the token is replaced with `redacted`, and `Content-Length` is
  recomputed. The follow-up request then carries `ApiKey=redacted`, which the
  gateway strips like any other browser-sent key.
- **Token repair.** Once a minute the gateway checks the token (`GET /Users/Me`).
  On `401` it signs in again as the viewer with the stored viewer password; if
  Jellyfin refuses that too, the local page asks for an admin login again.

Resume goes through `UserData` (`PlaybackPositionTicks`). `/Sessions/Playing*`
isn't allowlisted (Jellyfin ignored it from the pre-#50 API key; not needed).

### Browser mechanism: hls.js custom loader, not a Service Worker (decided)

Playback is Jellyfin **HLS**, so a custom hls.js loader
(`frontend/src/features/library/loader.ts`) reads straight from the data
channel in **page context**, where the channel handle already lives. A Service
Worker would add a `postMessage` hop (the channel can't live in the SW). It
would also need register+activate before it controls the page, and it can be
killed mid-stream. A SW only earns its keep to put arbitrary Jellyfin traffic
behind a real URL (e.g. iOS native HLS, which needs a URL), so it's deferred
until a concrete need appears. The master playlist is loaded from a sentinel
origin (`https://jellyfin.tunnel`) that can never be fetched directly. The
loader strips it back to an origin-relative path, so nothing bypasses the
tunnel. Posters go through the tunnel too, as blob URLs.

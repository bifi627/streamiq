# StreamIQ signaling protocol

This file is the contract: onboarding, broker, pairing, tunnel. The broker's messages on
both sockets (`/api/gateways/ws`, `/api/broker/ws`) are Go types in `protocol/` (#727):
the gateway and the Go API's broker (`api/internal/broker`) use them, the web app's TypeScript
is generated from them (`bash scripts/gen-types.sh` → `frontend/src/generated/`). The
gateway ↔ browser contracts are Go types in the gateway slice that serves them, one
types-only file each, generated the same way (#801): the `auth` channel
(`gateway/internal/sessions/messages.go`, "Pairing") and the gateway API's bodies
("Gateway API"). The tunnel framing is hand-mirrored in Go (`gateway/internal/tunnel`)
and TS (`frontend/src/shared/tunnel.ts`).

**Paths.** Every API endpoint is under `/api` (#120); the rest of the path space
belongs to the SPA's client routes (prod serves `index.html` for them, unknown
`/api/*` paths are 404). `/healthz` stays at the root. `STREAMIQ_API_URL` is the
origin only; clients append `/api/…` themselves.

## Gateway onboarding

Design: `superpowers/specs/2026-11-01-streamiq-agent-pairing-design.md`.
Fingerprints everywhere use the form `sha-256 AA:BB:…` (32 upper-case hex
pairs, SHA-256 over the DER certificate).

**`POST /api/gateways/enrollment-tokens`** (Firebase Bearer, household admin; a
member gets `403`) →
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
{ "type": "heartbeat", "lanUrl": "http://192.168.1.20:8097", "version": "1.4.0", "update": "1.5.0", "protocol": 2, "name": "Living room NAS", "relayOff": true }
```
Liveness plus what the gateway owns and the API mirrors (#140, #310, #785); a gateway sends one
early, right after its name or relay setting changes, not just every 30 s.
An older gateway also sends `telemetry` and, at `full`, `health` (#422): the API ignores
both (#783). The box's health stays in the gateway's own history (`GET /streamiq/health`).
The API also sets `last_seen_at = now`, `lan_url` (http/https only,
else null), `version` (≤ 40 chars, else null; `"dev"` for source builds) and
`update` (newer release version, absent = up to date; ≤ 40 chars, else null) and
`protocol` (below), and `name` (#310: trimmed, cut to 100 UTF-16 units, never inside a
surrogate pair; missing, blank or with a control character = the stored name stays), and
`relay_off` from `relayOff` (#785: `true` = direct connections only; missing, an older
gateway, or not a boolean = relay on), and ignores any other field. The gateway owns
its name; the API never writes it after enrollment. `GET /api/gateways` returns `online`, `lastSeenAt`, `lanUrl`,
`version`, `update`, `upgradeRequired` and `relayOff`; everything richer comes from the gateway itself over the
tunnel (`GET /streamiq/status`, below), so an unpaired browser sees only these.

**Protocol version (#176).** `protocol` is an integer, the version of this gateway ↔ API
protocol (currently **2**: 2 added a `tunnel` report, #390, which gateways no longer send since #783; Go `onboarding.Protocol`). A breaking change bumps it. The API
has one minimum (`broker.MinGatewayProtocol`, `api/internal/broker`); raising it is a deliberate step,
since every gateway below it stops working until its owner updates. A first heartbeat
below the minimum, or without `protocol`, gets `1008 "upgrade required"`; the API
records the version, `GET /api/gateways` reports `upgradeRequired: true`, and the
broker never routes a session to that socket. The gateway logs "rerun the install
command" and retries every 10 minutes. No negotiation: one version at a time.
**Release order** when raising the minimum: release the gateway that sends the new
version first (the installers fetch the latest release; the old API ignores the
new value), deploy the API after. Separate PRs: merging the gateway one releases it
(#274), the API one follows once that release is out. API first = every gateway refused, and rerunning the
installer reinstalls the old release.

**Households (#189).** A user can belong to several households (tenants). Every
Firebase-authenticated HTTP request acts in one: `X-StreamIQ-Household: <tenant id>`
names it, else the user's oldest membership. The API uses it only after finding
the user's own membership in it; a household the user isn't a member of, one that
doesn't exist, or a malformed id → `404` with header `X-StreamIQ-Not-Member: 1` (exposed
to CORS) before the endpoint runs, the same answer in all three cases (an endpoint's own
`404` never carries that header). `GET /api/me`
returns `{userId, tenantId, memberships:[{id, name, role}]}` (oldest first; `tenantId`
= the household this request acts in; `role` = `admin` | `member`).
The web app stores the household it acts in per device (`localStorage`
`streamiq.household`, set on joining one) and sends it on every request; once `/me`
is in, it sends that household even when it's the default. A `404` with
`X-StreamIQ-Not-Member` on any request clears the choice and reloads into the default household with a notice (#210).
**No household (#387).** Sign-up makes none: a user may have zero memberships. Such a
user gets `200` from `GET /api/me` (`tenantId: null`, `memberships: []`), the invite
`preview`/`accept` and `POST /api/households` → `{householdId}` (any signed-in user,
creates a household with the caller as its admin); every other Firebase-authenticated
endpoint answers the not-a-member `404` above, and the broker closes their socket
(`1008`, "no household") before `ready`, so no TURN credential either.

**Invites (#191).** Household admin (a member gets `403`): `POST /api/invites` →
`{id, token, expiresAt}` (single use, 7 days; only the SHA-256 hash is stored, the
token is shown once); `GET /api/invites` → pending ones `[{id, createdAt, expiresAt}]`;
`DELETE /api/invites/{id}` → `204` (revoke = row deleted; another household's → `404`).
Any signed-in user, token in the body (the link is `/join#<token>`: the fragment
never reaches a server log): `POST /api/invites/preview {token}` →
`{householdId, name, member}` (`name` = the household's, else "<inviter>'s household"
from Firebase, nothing stored); `POST /api/invites/accept {token}` → `{householdId}`,
the caller becomes a `member` of the invite's household and nothing else changes.
Already a member: both answer `200` without spending the invite. Unknown, expired,
used or revoked: `404`, all alike.

**Members (#192).** Any member: `GET /api/members` →
`[{userId, name, email?, role, joinedAt}]` of the request's household (looked up in
Firebase per call, nothing stored): `name` = the alias (Firebase `displayName`, set by the
web app, #388), else the email, `null` when unknown; `email` only on the caller's own row;
`DELETE /api/members/{own userId}` → `204` (leave). Household admin (a member gets
`403`): `DELETE /api/members/{userId}` → `204` (remove);
`PUT /api/members/{userId}/role {role}` → `204` (`admin` | `member`). Removing a user also deletes their
pending invites in that household. A user outside
the household → `404`. Anything that would leave the household without an admin →
`409 {error}`. A gone membership ends access on the next request or broker `offer`
(open sessions run to their end). A user left without any household stays without one
(#387).

**`DELETE /api/gateways/{id}`** (Firebase Bearer, household admin; a member gets
`403`) → `204`: revokes the gateway's
credential (row kept, hidden from `GET /api/gateways`; its relay usage stays). The
broker closes its control socket (`1008 "revoked"`) and every browser session
through it (`1008 "gateway revoked"`). Another tenant's or an already revoked
gateway → `404`. A gateway that authenticated just before the revoke is closed
at its next heartbeat. Re-adding the box = re-enroll (`docs/install.md`).

**Rate limits.** `/api/broker/ws`, `/api/gateways/ws`, `/api/gateways/enroll` and
`POST /api/gateways/enrollment-tokens` share a budget of 120 per client IP per minute;
the `POST`s that create an invite or a household share another 120. Over either → `429`
(for a socket: the upgrade is refused). A flood shield, not a per-user quota: a
household needs a handful per minute, and the headroom keeps many users behind
one shared IP (carrier NAT, office) clear of it. On an open socket, a message past its token
bucket (browser: burst 50, 10/s; gateway: burst 200, 50/s) closes it with
`1008 "rate limited"`. A browser socket must send `auth` within 10 s.
`GET /api/gateways` reports `online` = last heartbeat within 90 s. The same socket
carries the gateway's half of the broker (below).

## Broker

Tenant-scoped signaling. One JSON object per WebSocket text frame. The browser
socket picks no household: the `offer`'s gateway decides it, and the broker checks
the signed-in user's membership in *that gateway's* household (any household the
browser names, as a header or a field, is ignored). The broker
relays SDP/ICE; it can't make either side trust the other (pins + pairing do).

**`GET /api/broker/ws`** — browser socket, **one socket = one session to one gateway**.
Closing it ends the session (broker sends the gateway `bye`).
The broker closes it as `1008 "gateway gone"` when the gateway socket that took
this session's offer closes (restart, update): the session is dead even if ICE
hasn't noticed yet, and the client closes its pc (#172). A control-socket drop the
gateway survives ends it too: rare, and the next open makes a fresh session.

| direction | message |
|---|---|
| browser → broker | `{type:"auth", token:"<Firebase ID token>", gatewayId}` — first frame (not a query param: keeps it out of logs), within 10 s. `gatewayId` = the gateway this session's offer goes to: `ready` carries TURN only when it is a gateway of the user's households that isn't revoked and has its relay on, online or not (else STUN only, alike for an unknown or foreign gateway: no existence oracle), and an offer to another gateway gets "gateway offline or unknown" (#784). Without it (a web app from before): STUN only. Each failure closes `1008` with a reason: a first frame that isn't auth (or isn't a JSON object, or is over 8 KB) → "auth first"; nothing within 10 s → "auth timeout"; bad token → "unauthorized" (#555). |
| broker → browser | `{type:"ready", iceServers, relayOff?}` — this session's ICE servers (below); `relayOff: true` = the named gateway allows direct connections only (#785), so STUN only |
| browser → broker | `{type:"offer", gatewayId, sdp}` — browser is the offerer |
| broker → browser | `{type:"error", error:"gateway offline or unknown"}` — also for a gateway of a household the user isn't a member of (no existence oracle) |
| broker → browser | `{type:"error", error:"gateway busy"}` — relayed from the gateway: it refused the offer ("Limits before auth" below); a retry may get through |
| browser → broker | `{type:"ice", candidate}` |
| broker → browser | `{type:"answer", sdp}` · `{type:"ice", candidate}` |
| browser → broker | `{type:"ping"}` — every 25 s while the socket is open, ignored by the broker: keeps an idle session's socket from being dropped by a proxy (#178, #180) |

**Gateway side** (on `/api/gateways/ws`): broker → gateway `{type:"offer", session, user, role, sdp}`,
`{type:"ice", session, candidate}`, `{type:"bye", session}`; gateway → broker
`{type:"answer"|"ice", session, …}`, `{type:"error", session, error}` (the offer
refused, "Limits before auth" below: the broker relays it to that browser as its
`error` frame). The broker only routes a gateway's message
into a session opened *for that gateway*. The gateway keeps one PeerConnection
per session (several browsers at once).

**Device + user (#138).** Every session has both, checked independently:
- **device** = the client key, proven on the `auth` channel (pairing, below): *which
  device*. Paired once per browser, e.g. a shared TV.
- **user** = `user` in the gateway's `offer`: the signed-in browser's `users.id` (never
  the Firebase UID), stamped by the broker from the authenticated browser socket; the
  browser can't set it. *Who acts*: any household member signs in on a shared device as
  themselves. The gateway refuses an offer without `user` and keeps it on the session
  for gateway API handlers. It also picks the session's Jellyfin user (#195, "Jellyfin
  policy" below): on a user's first session, once its device has proven a paired key
  and before the tunnel opens, the gateway creates their own viewer (an offer alone,
  i.e. the API, makes none). The gateway never contacts Firebase.
- **role** = `role` in the gateway's `offer` (#194): `admin` | `member`, the user's role
  in *the gateway's* household, from the same membership lookup that lets the offer
  through (never anything the browser sends). The gateway refuses an offer without a
  known `role` and keeps it on the session: admin-only gateway API endpoints answer a
  member `403` (below). No protocol bump: a gateway from before #194 ignores `role` (it
  has no admin-only endpoint), so the API that sends it deploys *before* the
  gateway release that requires it (the reverse of the order above: API PR first).
- Not tied together: a stolen key alone gets nothing without a household sign-in; a
  compromised API alone gets nothing without a paired device. The role is fixed for the session: a demoted admin keeps it until the
  session ends (like a removed membership, #192).

## ICE servers + tunnel report

**ICE servers come per session, in the broker's `ready`** (there is no
free-standing TURN endpoint). Prod: Cloudflare `generate-ice-servers`
mints a fresh credential for each broker socket whose `auth.gatewayId` is a gateway of the user's households,
`customIdentifier` = that gateway's opaque relay tag (relay usage per gateway, #784), passed through, and the broker
revokes it when the socket closes (= the session ends: the gateway gets `bye`).
TTL 4 h is only the backstop for a failed revoke; it must outlast a relayed
session because TURN refreshes need a valid credential. Dev: TURN REST creds for
`STREAMIQ_TURN_URLS`, `username = "<unix expiry>:<user id>"`, `credential =
base64(HMAC-SHA1(STREAMIQ_TURN_SECRET, username))` (coturn `--use-auth-secret`),
expiry only. Neither configured, or Cloudflare failing: STUN only; the browser
then reports `relay: unavailable` in the diagnostics test, fails a forced relay
right after `ready`, and names it in an ICE failure (#585). **Relay off (#785).** A gateway whose heartbeat says `relayOff` gets no credential: STUN
only, and `ready` says `relayOff: true`; the browser then names it ("This gateway allows
direct connections only") in an ICE failure and a forced relay, and `/diagnostics` shows
`relay: off` and skips the forced-relay test. The gateway enforces it too: no TURN of
its own (`STREAMIQ_ICE_*` ignored), the browser's relay candidates dropped (offer SDP and
trickled), and a tunnel that still came up over a relay (a dropped relay reaching it as
prflx) closed. The browser
applies them with `setConfiguration` before creating its offer. `?relay` in the
app URL, or "Force relay" in the Diagnostics panel (turned on in Settings, for TVs
that can't edit the URL; `?debug` also opens it), sets `iceTransportPolicy: "relay"`
(diagnostic; the e2e uses the panel). The
gateway stays on its own config (STUN, optional `STREAMIQ_ICE_*`): the browser's
relay candidate is enough, as the e2e's forced-relay step shows.

**Tunnel report** (#390, #782): the gateway records every tunnel in its own history; the
API keeps no per-tunnel data (#783) and the browser can't create, alter or skip a line.
- **Report**: when a session's PeerConnection fails or closes (any path: ICE, `bye`, a
  removed client), the gateway reads once, from pion before `pc.Close()`, `relay`, `ipv6`,
  the candidate types, `protocol`, `bytesSent`, `bytesReceived`, `failure`, `use` and
  `activeMs` (`tunnel.Report`) and writes its line to
  `state/history/tunnels-YYYY-MM-DD.jsonl` (below), which Activity reads. From the gateway's
  side: `local` = the gateway's selected candidate, `remote` = the browser's, `bytesSent` =
  gateway → client (ICE transport totals). `relay` = either side of the pair is a relay, or
  the browser's side is `prflx` and every candidate the browser signaled is a relay (forced
  relay: a NAT in front of the TURN server, like Docker in the e2e, hides the signaled relay
  address). No pair (ICE never connected) = candidate fields absent. `failure`:
  `"ice failed"` (ICE failed before it ever connected; a later loss keeps the pair it had), else, when auth never succeeded, the gateway's last auth outcome
  (`"unpaired"`, a refusal reason) or `"ended before auth"` (incl. a browser that refused the
  gateway's pin: it hangs up before auth), `"not authenticated within 30s"` or `"gateway busy"`
  ("Limits before auth" below); null = the tunnel came up and passed auth. A gateway crash
  mid-tunnel loses that tunnel's line. Older gateways also sent it to the broker as
  a `tunnel` message: the broker ignores it.
- **Use + active time** (#681). `use` = what the tunnel was for, the highest-ranked use among
  the requests it served (the gateway's table in `tunnel/usage.go`, highest first):
  `playback` (a GET under `/Videos/{id}/`: playlists, segments, subtitles), `browsing` (any
  other Jellyfin request), `diagnostics` (`/streamiq/burst`), `management` (any other
  `/streamiq/*`). A new use is a gateway table row + this list + a web label. `activeMs` =
  from the gateway receiving the offer to the end of the tunnel's last request (the shared
  tunnel's idle wait before it closes is not in it). Both absent when no request was served.
- **Browser**: only its measured throughput, to the gateway over the tunnel itself
  (`POST /streamiq/tunnels/throughput`, below), before it closes the socket; a closed tab
  skips it.

The browser's own reading of its pair (`getStats()`; Chrome can report a relayed local
candidate as `prflx`, only relay candidates carry `relayProtocol`, so that counts too) drives
the player's privacy indicator (polled every 2 s) and Diagnostics, not the history.

## Pairing + connection auth

Design: `superpowers/specs/2026-11-01-streamiq-agent-pairing-design.md`. Browser
identity = non-extractable WebCrypto ECDSA P-256 **client key**; its
fingerprint = `sha-256 AA:…` over the SPKI bytes. The **gateway pin** = the
gateway's DTLS fingerprint (`a=fingerprint` of the answer SDP). The browser
checks the pin **before** `setRemoteDescription` and refuses on mismatch
(pairing again is allowed: the comparison code authenticates the new cert).
The answer must carry exactly one distinct fingerprint, a `sha-256` one (the same
line repeated at session and media level counts as one); anything else is refused
like a mismatch.

The browser opens a data channel labelled **`auth`** (JSON text frames). Until
it is authorized, the gateway closes every other channel immediately. The messages
are the Go types in `gateway/internal/sessions/messages.go`, generated as the
`GatewayAuthMessage` and `ClientAuthMessage` unions.

| # | direction | message |
|---|---|---|
| 1 | gateway → browser | `{type:"challenge", n}` — n = hex(32 random bytes) |
| 2 | browser → gateway | `{type:"auth", spki, sig, pair}` (base64; `pair:true` when the browser has no pin matching this gateway cert — forces steps 4–8 even for an allowlisted key, so a changed cert is only accepted via the code). `sig` = ECDSA P-256/SHA-256, **raw r‖s (64 bytes, IEEE P1363)** over `utf8("streamiq-auth-v1\|" + gatewayDtlsFp + "\|" + browserDtlsFp + "\|" + n)` — both DTLS fps of *this* session, so a MITM can't relay it |
| 3 | gateway → browser | `{type:"ok"}` (key on the allowlist and no `pair` → tunnel channels allowed) or `{type:"unpaired"}` |
| 4 | browser → gateway | `{type:"commit", h, name}` — h = hex(SHA-256(utf8(nB))), nB = hex(32 random bytes) |
| 5 | gateway → browser | `{type:"nonce", n: nA}` — only after the commit |
| 6 | browser → gateway | `{type:"reveal", n: nB}` — gateway checks it against h |
| 7 | both | `code = uint32_be(SHA-256(utf8(gatewayFp + "\|" + keyFp + "\|" + nA + "\|" + nB))[0..4]) mod 1e6`, zero-padded to 6 digits; local gateway page lists the request (name + code), browser shows the code |
| 8 | gateway → browser | `{type:"approved"}` after **Approve on the local gateway page** (key persisted to `allowlist.json`; browser stores the pin), or `{type:"rejected", reason}` (Reject, 5-min expiry, no free slot, bad signature/reveal, any message out of order) |

The commit makes the code ungrindable: a MITM gets one guess (10⁻⁶). The gateway
holds that to one guess per connection:

- **One `auth` channel per connection.** The gateway serves the first; any later
  channel labelled `auth` on the same PeerConnection is closed without reading a
  message, whether the first handshake succeeded, failed or is still running. A
  new attempt needs a new connection (a new broker session).
- **One `commit` per channel**, so one `nonce`. A second `commit` (or any message
  out of order) gets `rejected` and the channel is closed; nothing after a
  `rejected` is handled.
- **The pairing slot is taken at `commit`**, before the `nonce` is sent. There are
  3 slots; with none free the `commit` gets `rejected` (`too many pending pairing
  requests`) and no `nonce`. The slot is held until the exchange ends: Approve,
  Reject, expiry (5 min for the `reveal`, 5 min for the decision), a bad `reveal`,
  or the channel or connection closing. A request whose connection closed leaves
  the local gateway page. An exchange that ends between `commit` and `reveal` is
  logged.
- **One slot per user** (`offer.user`, `pairing.MaxPendingPerUser`): a second
  `commit` from a user whose exchange still runs gets `rejected` (`this user is
  already pairing a browser`), so one account can't hold every slot. The browser
  shows both full-queue rejections as busy ("Try again in a moment"), not as a
  refusal, and ends its attempt when the pairing view unmounts, which frees the slot.

**Limits before auth** (#758, `gateway/internal/sessions/limits.go`). A connection
is *not authenticated* from its offer until `ok` or `approved`:

- **At most 8 at once** (`MaxUnauthed`). An offer over it builds no PeerConnection:
  the gateway sends the broker `{type:"error", session, error:"gateway busy"}` and
  records that failure in its tunnel history; the broker relays only this one reason
  (`protocol.GatewayBusy`; any other gateway `error` is dropped), and the browser
  shows "The gateway is busy. Try again in a moment." with Retry.
- **30 s from the offer** (`UnauthedFor`). Still not authenticated then and no
  pairing exchange running (an accepted `commit`) → the gateway closes the
  PeerConnection; the history line's failure is `not authenticated within 30s`, or
  `ice failed` when ICE never connected. A running exchange keeps its 5-minute
  windows; one that ends without `approved` is closed at the next 30-s check after
  it. The browser sees the connection close.

**Remove** (local gateway page, or `POST /streamiq/clients/remove` from the web
app: an admin any client, #311; a member only its own, #341) drops the key from `allowlist.json` and closes
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

## Tunnel framing

The browser tunnels HTTP to the gateway's local Jellyfin over data channels.
**One data channel per request**: the channel *is* the request/response
lifecycle. There are no request IDs, no length prefixes and no multiplexing, so
there's no head-of-line blocking between requests. Any channel label other than
`auth` is a tunnel request. The gateway serves at most 32 tunnel channels at
once per connection (`tunnel.MaxChannels`); one over that is closed without a
response head, which the browser sees as a failed request.

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
   large), `503` (gateway has no Jellyfin key), `502` (Jellyfin unreachable). The
   gateway API (below) refuses with its own statuses (`400`, `404`, `409`), and answers
   its own failure with `500`.
3. **Gateway → browser** (zero or more binary frames): the body, in ~60 KB
   chunks under `bufferedAmount` backpressure. A whole segment is never sent
   as one message.
4. **Gateway → browser** (one text frame): `{"eof":true}`, the end of the body.
   If the body broke off part-way (upstream read or send failed), this frame is
   `{"error":"…"}` instead, and the browser fails the request. The browser also
   fails it when the body's size differs from `Content-Length` (#263).
5. **Browser closes the channel.** The gateway closes only if the browser hasn't
   within 10 s (`EOFGrace`). A channel that closes before the EOF frame is a
   failed request. The gateway must not close first: Chrome 87 (webOS TVs) drops
   frames still in flight on a remote close (#71, #72).

The head and EOF (or error) are **text** frames and body chunks are **binary**, so the
browser tells them apart by type.

**Media bytes are untouched.** The gateway never negotiates or applies
content compression for the browser. Go's default transport would inject
`Accept-Encoding: gzip` and silently decompress, which rewrites the body and
drops `Content-Length`. Compression stays end-to-end. The one rewrite is
key redaction in text responses (below).

### Gateway API (`/streamiq/*`, #138)

Every tunnel request whose path starts with `/streamiq/` (the prefix matched
case-insensitively, like Jellyfin's routing) is answered by the **gateway
itself** and never proxied to Jellyfin; none needs a Jellyfin token. Only an
exact, unencoded path with its method (`GET`, or `POST` on the screen endpoints,
`/streamiq/name`, `/streamiq/relay`, `/streamiq/clients/remove`, `/streamiq/clients/rename`, `/streamiq/clients/profile` and `/streamiq/update`) matches an endpoint; an unknown, unclean or
percent-encoded path under the prefix is `404`; a known path with another method
is `405` with an `Allow` header listing its methods, no body (#436; `HEAD` is never
served, so a `GET` path answers it `405` with `Allow: GET`), checked before the
admin-only role check. A `body` over 64 KB is `413`. A handler's own failure
(e.g. `/streamiq/name` can't write `state/gateway.json`) is `500`, never the `502`
that means Jellyfin is unreachable (#327). Like every
tunnel request it exists only after connection auth: an unpaired browser gets
no tunnel channels. The session's user (`offer.user`) and role (`offer.role`) are
known to handlers. An endpoint can be marked **admin-only** (the route option
`tunnel.AdminOnly`): a session whose role isn't `admin` gets `403`: `/streamiq/name`,
`/streamiq/relay` and `/streamiq/update` so far; #89 decides per endpoint. `/streamiq/clients*` is
open to a member for its own client key only (#341, below). Code: the router in
`gateway/internal/tunnel/api.go` (`net/http` handlers, each in the package that owns
its feature, registered in `gateway/cmd/gateway/main.go`). The request and response
bodies are Go types in a types-only file of the package that serves them, generated
into `frontend/src/generated/`: `gateway/internal/{tunnel,screen,pairing,onboarding,update,history}/types.go`,
and `/streamiq/status` in `gateway/cmd/gateway/status.go` (with `host/load.go`,
`jellyfin/viewer.go`).

**`GET /streamiq/status`** (#146, #140): `200`, JSON, built on each request.
Fields are added over time; a client ignores ones it doesn't know.
```json
{ "transcoding": "nvenc", "os": "windows", "arch": "amd64", "startedAt": "2026-11-10T08:00:00Z",
  "jellyfin": { "reachable": true, "version": "10.11.2", "untested": false, "token": "ok", "offline": "enforced" },
  "pairedClients": 2, "activeSessions": 1,
  "viewer": { "shared": true, "reason": "admin-refused" },
  "remoteUpdate": "no logon task, so nothing would start the gateway again after the update",
  "host": { "cpu": 12.5, "memory": { "used": 8123456789, "total": 17179869184 },
            "disk": { "free": 120000000000, "total": 1000000000000 } } }
```

| Field | Values |
|---|---|
| `transcoding` | `"nvenc"` / `"none"`: the `STREAMIQ_JELLYFIN_HWACCEL` the gateway applied to a Jellyfin it set up; `"unmanaged"`: a Jellyfin the user brought (the gateway doesn't own its settings) |
| `os`, `arch` | Go's `GOOS` / `GOARCH` |
| `startedAt` | gateway process start, ISO 8601 UTC |
| `jellyfin` | `reachable`, `untested` (version outside the tested line), `version`, `token`: `ok` / `missing`, `offline` (#321, from `jellyfin-compose.yml` on each request): `enforced` (the jail is on: Jellyfin has no internet access) / `allowed` (online lookups possible); absent when the gateway has no compose file (a Jellyfin the user brought, or native) |
| `pairedClients`, `activeSessions` | counts only, no client names (#65) |
| `viewer` | the calling session's Jellyfin viewer (#242): `shared: false` = the user's own; `shared: true` = the shared `streamiq-viewer` (#195 fallback), with a `reason` code: `admin-refused` (Jellyfin refused the gateway's admin sign-in), `no-admin` (the gateway has no Jellyfin admin of its own), `failed` (anything else; retried on the user's next session). The web app words it; an unknown code shows no reason. No credentials, no Jellyfin ids. The web app shows a guest-mode banner on the library and player while `shared` is true; no field (older gateway) = no banner |
| `host` | the box's live load (#671), never stored: `cpu` busy % (0–100, averaged over the last ~10 s by a background sampler; absent until its first sample), `memory` `used`/`total` bytes (physical), `disk` `free`/`total` bytes of the drive holding `jellyfin-compose.yml` (and so `jellyfin-config/`; absent without a compose file). A field the platform can't measure is left out: macOS sends only `disk`. The web gateway page asks again every 10 s while Status is open and leaves `host` out of its offline cache |
| `remoteUpdate` | `true` = `POST /streamiq/update` would start an update now (#312); else a sentence saying why not, shown as it is: not Windows, dev build, an update already running, already up to date, no logon task. No field (older gateway) = update by hand |

The web gateway page caches the last response per gateway in `localStorage` and
shows it as "as of <time>" while the gateway is offline.

The setting, not a live transcode, is the answer on purpose: Jellyfin doesn't
fall back to the CPU silently (a broken GPU setup fails playback), and
Jellyfin's `/Sessions` can't tell more to the viewer token (spike on #86). A
gateway older than this endpoint answers `404`; the web gateway page then says
to update it.

**`GET /streamiq/health`** (#781, any member) → `200`, the health the gateway recorded
itself in `state/history/` (JSON Lines, a file per UTC day, 7 days
kept): its rows of the last 7 days, oldest first, led by the latest row before them, each
`{ "at", "jellyfinReachable", "jellyfinVersion", "gatewayVersion", "tunnels", "transcodes",
"cpu", "memory" }` (null = not measured; `[]` before the first). A row is recorded
when it adds something (every 30 s the gateway checks; a change of `jellyfin`, `os`,
`arch`, `transcoding`, `offline` or its version, else every 5 min, never within 25 s). A
gateway older than this endpoint answers `404`.

**`GET /streamiq/tunnels[?scope=household]`** (#782) → `200`, the tunnels to this gateway
the gateway recorded itself, one JSON line per ended tunnel in `state/history/` (a file per
UTC day, 30 days kept), the same fields the report has plus who and when: `[{ "id" (the
broker session), "gatewayId" (the enrollment that wrote it: a re-enrolled gateway, maybe in
another household, answers none of its earlier lines), "createdAt" (the offer), "endedAt", "relay", "ipv6", "bytesSent",
"bytesReceived", "throughputKbps", "failure", "use", "activeMs" }]` (null = none). A tunnel
that failed on the gateway (ICE, auth, busy) is a line too; one that never reached it is
nowhere. Without `scope`: the session's user's own; `scope=household` (admin only, a member
gets `403`; another value `400`): every member's, each with `userId`. The last 30 days,
newest first, at most 200. The user and role are the session's (the broker's offer), never
the request's. A gateway older than this answers `404`.

**`GET /streamiq/tunnels/summary`** (#782, admin-only) → `200` `[{ "userId", "tunnels",
"hidden", "failed", "relayedBytes" }]`: per user over every line of the 30 days, most
tunnels first. `hidden` = management or diagnostics without a failure (what Activity hides by
default), `relayedBytes` = both directions of every relayed line.

**`POST /streamiq/tunnels/throughput`** (#782) `{ "throughputKbps": 4200 }` → `204`: the
gateway → client throughput the browser measured (the tunnel's last burst measurement,
below), kept for this session's own tunnel and written with its line when it ends; missing,
zero or negative = none, a later call replaces it. Not JSON → `400`. Served by the tunnel
itself (`tunnel.NewRouter`, like burst and route) and counted as neither use nor active time:
it comes as the tunnel closes, after a shared tunnel's idle wait. The web app sends it only
on a connected tunnel and closes after 2 s at most without an answer.

**`POST /streamiq/name`** (#310, admin-only) `{ "name": "Living room NAS" }` → `200`
`{ "name": "<stored>" }`. The name is trimmed, 1–100 characters counted in UTF-16
units like the API (the enrollment bound; an emoji counts 2), no control characters,
else `400`. The gateway writes it to `state/gateway.json` (atomically) and uses it at
once (local page, backup file names, logs), then sends an early heartbeat so
`GET /api/gateways` shows it within a second. A gateway older than this endpoint
answers `404`; the web app then says to update it.

**`POST /streamiq/relay`** (#785, admin-only) `{ "relay": false }` → `200` `{ "relay":
<stored> }`; a body without a boolean `relay` is `400`. Off = direct connections only
(ICE servers, above). Stored in `state/gateway.json` as `relayOff` (`false` or no field = on, the
default), then an early heartbeat. The CLI's `gateway relay on|off` writes the same file
with the gateway stopped. An older gateway answers `404`; the web app says to update it.

**`GET /streamiq/clients`** (#311) → `200`
`[{ "keyFp": "…", "name": "Pixel 8 · Chrome", "addedAt": "2026-11-01T10:00:00Z", "self": true, "profile": null }]`:
the allowlist (`allowlist.json`); `self` = the calling session's client key; `profile` =
its last stored probe (below) or `null`. A member's list holds only its own entry (#341).
**`POST /streamiq/clients/remove`** (#311) `{ "keyFp": "…" }` → the Remove above, then
`200 {}`; a member naming any key but its own `403` (#341), unknown key `404`, a failed save of `allowlist.json` `500`. The calling
browser's own key is removed only once the reply is delivered (the browser closed the
request channel, at most `EOFGrace` 10 s later), so it still gets its `200` before its
session closes.
**`POST /streamiq/clients/rename`** (#365) `{ "keyFp": "…", "name": "Living room TV" }` →
`200 { "name": "<stored>" }`, saved in `allowlist.json`. The name rules of
`/streamiq/name` (trimmed, 1–100 UTF-16 units, no control characters, else `400`); the
access and errors of remove (a member names only its own key, `403`; unknown key
`404`; failed save `500`, the old name kept). An open screen keeps the name it opened
with until it opens again. The web app offers it once right after pairing (prefilled
with the paired name, Skip keeps it) and on the Paired clients list; a gateway older
than this answers `404`. Names and keys stay on
the gateway: the API never sees or stores them.
**`POST /streamiq/clients/profile`** (#792) `{ "probe": { "h264": {…} | null, "hevc": {…} | null,
"av1": {…} | null, "audio": ["aac", …], "surround": true }, "compatible": false }` → `200 {}`:
the web app's capability probe (`Probe` in `gateway/internal/pairing/types.go`) and its
Compatible mode setting, stored for the **calling session's own client key** (any key in
the body is ignored) in `profiles.json` with the gateway's `probedAt`; the latest replaces
the last, and it goes with the client's Remove. `profiles.json` is apart from
`allowlist.json` and written atomically: unreadable, it only empties the profiles. A body
over 4 KiB, a missing `audio` list (or `h264` without `profiles`), or names that aren't
short lowercase words (at most 8 per list) `400`; unknown fields are ignored, so a newer
web app still stores on an older gateway. A failed save `500`. The web app posts it at
each playback start and only logs a failure; a gateway older than this answers `404`.

**`POST /streamiq/update`** (#312, admin-only, body ignored) → `202 { "version": "1.5.0" }`: the
gateway started a detached `gateway update` (output in `update.log` next to the binary) for the
newer release its daily check found. That process outlives the logon task it stops: it
downloads and checks the release, backs up the gateway, ends the task, swaps the binary and
starts the task again (the update in `docs/install.md`). The gateway goes down a few seconds
after the reply and comes back on its own; its heartbeat `version` is the result (no API
change). `409 { "reason": "…" }` = nothing started, the same reasons as `remoteUpdate`
above (one updater at a time). A failure to start the process is `500`. Windows with the
logon task only: Linux/macOS have no service that would start the gateway again (#119, #277).
The updater installs the latest release when it runs, which can be newer than the
`version` in the reply (the daily check's); the web app counts any other version as done.
A gateway older than this answers `404`.

**`GET /streamiq/route`** (privacy badge, #428): `200`, JSON `{"route": "lan" | "direct" | "relay"}` for the tunnel the request came on, from its selected candidate pair at that moment. `lan` = not relayed and the browser's address is inside a subnet of one of the gateway's up interfaces (loopback, point-to-point links and interfaces without a MAC, i.e. WireGuard/Tailscale tunnels, excluded), or an mDNS `.local` name (pion resolves those only over link-local multicast). The player asks every 10 s; a gateway older than this answers `404` and the badge shows only direct / relayed.

**`GET /streamiq/burst[?size=N]`** (throughput test, #90): `200`,
`Content-Type: application/octet-stream`, `Content-Length: N`, then N generated
bytes through the normal chunking and backpressure above. `size` defaults to
4 MiB and is capped at 16 MiB; anything else (over the cap, negative, not a
number) is `400`. The client times a `size=1048576` warm-up burst (dropped:
mostly ramp-up), then 3 bursts sized to last ~2 s at the previous read
(1–16 MiB), and keeps the median (Mbps): the player's Auto quality caps
`MaxStreamingBitrate` at 70 % of it. It measures only when playback
starts with Auto (never while browsing, never for Source, Raw or a rung) and
again on a `navigator.connection` `change` that switched the connection type.
Each reading is stored in localStorage with its time, per gateway +
direct/relay + connection type; one younger than the per-device "Measure
connection speed" setting (every 30 min / 2 h, the default / day) is used
without bursts, and with the setting Off only `/diagnostics` "Test connection"
measures (it always does, fresh). Only a fresh measurement goes to the tunnel history
(`throughputKbps`). With the client's data saver on a run is just 3
`size=1048576` bursts (no warm-up, ~3 MB), not stored, and Auto stays at 480p.

### Screens: phone as remote (`/streamiq/screen*`, #95, #179)

A TV in screen mode is remote-controlled by a phone on the **same gateway**: the
gateway relays the commands, so the API is not involved and what's watched never
reaches the API. Both devices are paired clients with their own tunnel.
Code: `gateway/internal/screen/screen.go`; the commands and state: `gateway/internal/screen/types.go`.

- **Opt-in is structural.** A screen exists only while a session holds its
  `GET /streamiq/screen` response open, and is removed the moment that channel
  closes (Back, tab closed, session ended). Commands go only to screen ids, so a
  session that never opened a screen can't be reached.
- **Screen id**: random per screen (`crypto/rand.Text()`, 26 chars, base32), not
  the client key; a reconnect gets a new id. No keep-alive on the held response:
  an idle tunnel survives 60 min direct and relayed (#178).
- **Who controls: the whole household** (#245, decided). Any paired client of the
  gateway, whichever user is signed in, lists and controls every open screen; there
  is no per-user or role filter. A shared living-room TV is the point of the remote.
- **Whose progress: the TV's user.** The TV plays through its own session, so resume
  and played state land on its signed-in user's Jellyfin viewer, even when another
  user's phone started or controls playback. To watch as B, sign the TV in as B.

**`GET /streamiq/screen`** (TV): opens this session's screen, named by the
client's pairing `name`. `200`, `Content-Type: application/x-ndjson`, no
`Content-Length`; the body stays open and carries one command per line (below),
as the phone sent it, re-encoded by the gateway (unknown fields dropped), in
arrival order: with two phones, the last command wins. The body never ends with
an EOF frame: the TV closing the channel (or its session ending) is the end of
the screen, and the gateway never closes it first. A session that already holds
an open screen gets `409`.

**`POST /streamiq/screen/state`** (TV): the screen's playback state, about once a
second and on every change. `204`. `404` from a session without a screen; `400`
if malformed (negative ticks, `itemId` not a Jellyfin id, `audio` < 0, `subtitle` < -1).
```json
{ "itemId": "aad7…", "positionTicks": 1200000000, "durationTicks": 26000000000,
  "paused": false, "audio": 1, "subtitle": null }
```
Ticks are integers (Jellyfin ticks, 10⁷ per second; a fractional number is
`400`). `audio` / `subtitle` are Jellyfin stream indexes, `subtitle: -1` = off,
`null` = not known; `itemId` is `""` while nothing plays.

**`GET /streamiq/screens`** (phone): the open screens on this gateway, `200`, JSON;
`state` is `null` until the TV first posts one.
```json
[ { "id": "K3Q…", "name": "Living room TV", "state": { "itemId": "aad7…", "...": "..." } } ]
```

**`POST /streamiq/screens/{id}`** (phone): one command to that screen. `204` once
queued for the TV; `404` for an unknown id (or a screen that closed); `400` for a
malformed command or a field that doesn't belong to its type; `413` over 64 KB.
A TV that isn't reading keeps the newest 16 commands (the oldest are dropped).
Each POST is its own channel, so a client that needs its own commands in order
sends the next one after the previous `204`.

| Command | Fields |
|---|---|
| `{"type":"play","itemId":"…","startTicks":0}` | `itemId` required (Jellyfin id); `startTicks` optional, integer ≥ 0 |
| `{"type":"pause"}` / `{"type":"resume"}` / `{"type":"stop"}` | none |
| `{"type":"seek","ticks":1200000000}` | `ticks` required, integer ≥ 0 (absolute position) |
| `{"type":"tracks","audio":1,"subtitle":-1}` | at least one; Jellyfin stream index (`audio` ≥ 0, `subtitle` ≥ -1; -1 = off) |

### Jellyfin policy (gateway, `gateway/internal/tunnel/jellyfin.go`)

The browser authenticates to StreamIQ, never to Jellyfin, and a paired browser
stays a *viewer*:

- **Credential injection.** The gateway holds a Jellyfin user token per StreamIQ
  user (#195): their own hidden, non-admin viewer `streamiq-<users.id>`, created on
  their first paired session (the offer's `user`, lowercased; one at a time, so two
  sessions at once make one), plus the shared viewer `streamiq-viewer` (#50) as the fallback. A session whose
  user has no viewer (creating it failed: the gateway log and local page say why, the
  next session tries again; after Jellyfin refused the gateway's admin, not until it has
  new admin credentials, since Jellyfin locks out users after failed sign-ins: on a
  Jellyfin the user brought, the next admin login on the local page; on one the gateway
  set up, a page login as `streamiq` with its changed password, or that password put into `state/jellyfin.json`, which the gateway re-reads when it changes) plays as `streamiq-viewer`. `gateway/internal/jellyfin`
  creates viewers with the gateway's own admin (`streamiq`, or hidden `streamiq-admin`
  on a Jellyfin the user brought) and logs that session out again; tokens and
  passwords are in `state/jellyfin.json` (`users`: `users.id` → viewer). No admin
  credential ever reaches the tunnel. It sets
  `Authorization: MediaBrowser Token="…"`, and drops browser-sent `Authorization`,
  `Cookie`, `X-Emby-*` and `X-MediaBrowser-*` headers, and `api_key`/`ApiKey`
  query parameters. Jellyfin itself refuses admin calls with this token. Every
  viewer's policy: not admin, hidden, no content deletion, no remote control of
  other users or shared devices, no public sharing, no collection, subtitle,
  lyric or Live TV management; all libraries.
- **User pinning.** Every request gets `userId=<id of the session's viewer>`, and any
  browser-sent `userId` is dropped (Jellyfin also answers `403` to another
  user's id with this token). Resume and played state are per StreamIQ user.
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
  buffered, the session's token is replaced with `redacted`, and `Content-Length` is
  recomputed. The follow-up request then carries `ApiKey=redacted`, which the
  gateway strips like any other browser-sent key.
- **Token repair.** Once a minute the gateway checks every viewer's token (`GET /Users/Me`).
  On `401` it signs in again as that viewer with its stored password. If Jellyfin
  refuses that too: for `streamiq-viewer`, the local gateway page asks for an admin
  login again; a user's own viewer is dropped and made again on their next session.

Resume goes through `UserData` (`PlaybackPositionTicks`). `/Sessions/Playing*`
isn't allowlisted (not needed).

### Browser mechanism: hls.js custom loader, not a Service Worker (decided)

Playback is Jellyfin **HLS**, so a custom hls.js loader
(`frontend/src/features/player/loader.ts`) reads straight from the data
channel in **page context**, where the channel handle already lives. A Service
Worker would add a `postMessage` hop (the channel can't live in the SW). It
would also need register+activate before it controls the page, and it can be
killed mid-stream. A SW only earns its keep to put arbitrary Jellyfin traffic
behind a real URL (e.g. iOS native HLS, which needs a URL), so it's deferred
until a concrete need appears. The master playlist is loaded from a sentinel
origin (`https://gateway.tunnel`) that can never be fetched directly. The
loader strips it back to an origin-relative path, so nothing bypasses the
tunnel. Posters go through the tunnel too, as blob URLs.

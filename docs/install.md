# Setting up StreamIQ at home

StreamIQ streams the media on your own machine (NAS, PC, Mac) to your browser
anywhere, without router configuration. Two programs run on that machine:

- **Jellyfin**, the media server that scans your files and plays them, and
- the **StreamIQ gateway**, one native binary that connects Jellyfin to your
  browsers.

Setup takes five steps. The gateway's local page (`http://localhost:8097`)
shows a status section for each of them.

## 1. Get Jellyfin

Pick one:

- **You already run Jellyfin:** keep it. It must be reachable on the same
  machine at `http://localhost:8096`.
- **Native install:** install [Jellyfin](https://jellyfin.org/downloads), but
  **skip its setup wizard**. The gateway completes it in step 3.
- **Docker:** download `jellyfin-compose.yml` from the
  [latest release](https://github.com/bifi627/streamiq/releases/latest) into a
  folder of your choice. It is just Jellyfin, pinned to the version the gateway
  was tested with, on port 8096. Edit the media folders in it: one read-only
  bind per folder, any number of drives, Windows paths like `'D:\Movies'` work.
  Each `source` folder must exist. Then run
  `docker compose -f jellyfin-compose.yml up -d` in that folder and leave the
  setup wizard alone. The file is yours; updates never overwrite it.

## 2. Install the gateway

1. In the StreamIQ web app: **Gateways → Add gateway**. Copy the command for your
   shell. It contains a one-time token that is valid for 15 minutes.
2. Run it on the media machine:
   - Linux / macOS: `curl -fsSL …/install.sh | STREAMIQ_API_URL=… STREAMIQ_ENROLL_TOKEN=… sh`
   - Windows (PowerShell): `$env:STREAMIQ_API_URL='…'; $env:STREAMIQ_ENROLL_TOKEN='…'; irm …/install.ps1 | iex`
3. Open the local page it prints (`http://localhost:8097`). On Windows, allow
   the firewall prompt for private networks. The web app now lists the gateway.

From another device (phone, laptop; the usual case for a NAS) the page asks for
a token. Open the link the installer printed after **from another device**
(`http://<lan-ip>:8097/?t=…`) once in that browser; it stays signed in for a
year. Lost it? It's in `state/page-link` (the token alone: `state/page-token`).
On the media machine itself (`localhost`) no token is needed. To sign out every
browser, delete `state/page-token` and restart the gateway.

The installer verifies the binary against the release's `SHA256SUMS` and
refuses a mismatch.

## 3. Connect Jellyfin

The local page's status shows **Jellyfin: reachable** and whether the gateway
has its **token**. The gateway streams as its own hidden Jellyfin user,
`streamiq-viewer`: not an administrator, can't delete anything, sees all
libraries and keeps its own watch progress (separate from yours in Jellyfin).

- **Fresh Jellyfin** (wizard not done): nothing to do. Within seconds the
  gateway completes the wizard, creates the Jellyfin admin `streamiq` with a
  random password, and creates `streamiq-viewer`. The local page shows where
  the admin password is (`state/jellyfin.json`, readable only on this
  computer), never the password itself. You use it to manage
  Jellyfin.
- **Jellyfin already set up:** the page shows **Connect Jellyfin**. Sign in once
  with a Jellyfin administrator. The gateway uses that session to create
  `streamiq-viewer`, then signs out. It never stores your password, so
  changing it later doesn't break anything.

If the token stops working (for example you signed the gateway out under
Dashboard → Devices), the gateway signs in again by itself. If you deleted
`streamiq-viewer` or changed its password, the page asks you to **Connect
Jellyfin** again. A gateway set up before this change uses an admin API key
and shows **admin API key: reconnect Jellyfin**: sign in once, and the
gateway switches over and deletes the old key.

The page warns when Jellyfin runs a version the gateway wasn't tested with.

## 4. Add your media libraries

Open Jellyfin at `http://localhost:8096`, sign in as the admin (step 3) and go
to **Dashboard → Libraries → Add Media Library**. With the Docker compose file,
pick the folder **inside the container**: a bind with `target: /media/movies`
appears as `/media/movies`, not as `D:\Movies`. Jellyfin scans the library; that
can take a while for big collections.

## 5. Pair a browser and watch

1. In the web app: **Gateways → Open** on your gateway, then **Pair this browser**.
2. The browser shows a code. The local page shows a pairing request with a code.
   **Approve** only if both codes match.
3. Browse your libraries and play. The player shows whether the connection is
   direct or relayed. Each browser (phone, laptop, …) is paired once; remove
   browsers on the local page.

## Removing a gateway

**Gateways → Remove** in the web app revokes the gateway's credential at once:
it disconnects, any open streams through it stop, and it logs
`credential revoked or unknown` while it keeps retrying. To add the same box
again, stop the gateway, delete `gateway.json` in its state directory, and run a
new install command (**Add gateway**). The certificate in the state directory
is kept, so paired browsers don't need to pair again.

## Where things live

| | Windows | Linux / macOS |
|---|---|---|
| Install dir | `%LOCALAPPDATA%\streamiq` | `~/.local/share/streamiq` |
| Settings | `gateway.env` (yours, kept on updates) | same |
| Identity, paired browsers, Jellyfin token, page token | `state\` (never touched by updates) | `state/` |
| Log | `gateway.log` | `gateway.log` |

`STREAMIQ_DIR` overrides the install dir. Set `STREAMIQ_NAME` and `STREAMIQ_PAGE_PORT` on
the first install to change the gateway's name or page port.

## Update

The gateway checks GitHub once a day. When a newer release exists, it logs
`update available vA → vB. Run: …` and shows the same on its local page. Run
that command:

- Linux / macOS: `curl -fsSL https://github.com/bifi627/streamiq/releases/latest/download/install.sh | sh`
- Windows: `irm https://github.com/bifi627/streamiq/releases/latest/download/install.ps1 | iex`

It stops the running gateway, swaps the binary and starts it again. Your
settings and paired browsers stay. Nothing updates without you running it
(notify-only for now).

## Start on boot (manual for now)

- Windows: `schtasks /Create /SC ONLOGON /TN streamiq-gateway /TR "'%LOCALAPPDATA%\StreamIQ\gateway.exe'"`
- Linux / macOS: `crontab -e`, add `@reboot cd ~/.local/share/streamiq && ./gateway >> gateway.log 2>&1`

## Releasing (maintainers)

Push a tag `gateway-vX.Y.Z`. CI (`release-gateway.yml`) tests, builds all six
binaries, and publishes the GitHub Release with `SHA256SUMS`, both install
scripts and `jellyfin-compose.yml`. When bumping the Jellyfin pin, update
`docker-compose.yml`, `gateway/install/jellyfin-compose.yml` and
`jellyfin.Tested` together (a gateway test enforces it). A tag with a suffix (`gateway-v1.5.0-rc.1`) becomes a prerelease,
which `latest` and the update check skip.

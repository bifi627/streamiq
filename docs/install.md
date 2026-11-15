# Setting up StreamIQ at home

StreamIQ streams the media on your own machine (NAS, PC, Mac) to your browser
anywhere, without router configuration. Two programs run on that machine:

- **Jellyfin**, the media server that scans your files and plays them, and
- the **StreamIQ gateway**, one native binary that connects Jellyfin to your
  browsers.

Setup takes five steps. The local gateway page (`http://localhost:8097`)
shows a status section for each of them.

## 1. Get Jellyfin

Pick one:

- **You already run Jellyfin:** keep it. It must be reachable on the same
  machine at `http://localhost:8096`.
- **Native install:** install [Jellyfin](https://jellyfin.org/downloads), but
  **skip its setup wizard**. The gateway completes it in step 3.
- **Docker:** install the gateway first (step 2), then run `gateway jellyfin up`
  in its install dir. It downloads `jellyfin-compose.yml` there (checked against
  the release's `SHA256SUMS`) and starts it: just Jellyfin, pinned to the version
  the gateway was tested with, on port 8096. Edit the media folders in that file:
  one read-only bind per folder, any number of drives, Windows paths like
  `'D:\Movies'` work. Each `source` folder must exist. Then run
  `gateway jellyfin up` again and leave the setup wizard alone. The file is
  yours; updates never overwrite it. Needs Docker with Compose v2
  (`docker compose`); the gateway says so if it's missing.
  Jellyfin keeps its users, libraries and watch state in the `jellyfin-config`
  folder next to the file, so Docker cleanups (`docker system prune --volumes`,
  Docker Desktop's "Clean up data") don't touch them; after one, run
  `gateway jellyfin up` again. If Jellyfin does come back empty (that folder
  deleted), the gateway sets it up again by itself: add your media libraries
  again; each user's resume state starts over.

## 2. Install the gateway

1. In the StreamIQ web app: **Gateways → Add gateway** (household admins only). Copy the command for your
   shell. It contains a one-time token that is valid for 15 minutes.
2. Run it on the media machine:
   - Linux / macOS: `curl -fsSL …/install.sh | STREAMIQ_API_URL=… STREAMIQ_ENROLL_TOKEN=… sh`
   - Windows (PowerShell): `$env:STREAMIQ_API_URL='…'; $env:STREAMIQ_ENROLL_TOKEN='…'; irm …/install.ps1 | iex`
3. Open the local gateway page it prints (`http://localhost:8097`). On Windows, allow
   the firewall prompt for private networks. The web app now lists the gateway.

On Windows the installer also sets the gateway to start at every logon (see
[Start on boot](#start-on-boot)). `gateway status` (in the install dir) shows
whether it is connected, Jellyfin, the version and the local gateway page link.

From another device (phone, laptop; the usual case for a NAS) the page asks for
a token. Open the link the installer printed after **from another device**
(`http://<lan-ip>:8097/?t=…`) once in that browser; it stays signed in for a
year. Lost it? It's in `state/page-link` (the token alone: `state/page-token`).
On the media machine itself (`localhost`) no token is needed. To sign out every
browser, delete `state/page-token` and restart the gateway.

The installer verifies the binary against the release's `SHA256SUMS` and
refuses a mismatch.

## 3. Connect Jellyfin

The local gateway page's status shows **Jellyfin: reachable** and whether the gateway
has its **token**. Each household member streams as their own hidden Jellyfin
user, `streamiq-<id>`, created on their first visit: not an administrator, can't
delete anything, sees all libraries and keeps that member's own watch progress
(separate from yours in Jellyfin). If creating it fails, the member plays as the
shared hidden user `streamiq-viewer` and the page says why.

- **Fresh Jellyfin** (wizard not done): nothing to do. Within seconds the
  gateway completes the wizard, creates the Jellyfin admin `streamiq` with a
  random password, and creates `streamiq-viewer`. The local gateway page shows where
  the admin password is (`state/jellyfin.json`, readable only on this
  computer), never the password itself. You use it to manage
  Jellyfin. You may change that password in Jellyfin; then sign in as
  `streamiq` with the new one on the local gateway page (it asks with
  **Connect Jellyfin** once the old one is refused), or put it in the file's
  `password`: the gateway picks up either without a restart. Until then, new
  household members play as `streamiq-viewer`.
- **Jellyfin already set up:** the page shows **Connect Jellyfin**. Sign in once
  with a Jellyfin administrator. The gateway uses that session to create
  `streamiq-viewer` and its own hidden admin `streamiq-admin` with a
  random password (in `state/jellyfin.json`, readable only on this computer), then
  signs out. It never stores your password, so changing it later doesn't break
  anything. The gateway needs its own admin to create the members' Jellyfin
  users; it doesn't touch your Jellyfin's settings.
  A gateway connected before this change shows **Connect Jellyfin** once more:
  sign in again, and playback keeps working until you do.

If the token stops working (for example you signed the gateway out under
Dashboard → Devices), the gateway signs in again by itself. If you deleted
`streamiq-viewer` or changed its password, the page asks you to **Connect
Jellyfin** again. A gateway set up before this change uses an admin API key
and shows **admin API key: reconnect Jellyfin**: sign in once, and the
gateway switches over and deletes the old key.

**Without the page** (a headless NAS or server over SSH): run
`gateway jellyfin login` on the gateway's computer. It asks for a Jellyfin
administrator and its password (not shown while you type) and does what the
page's sign-in does: on a Jellyfin the gateway set up, sign in as `streamiq`
with its new password; on your own Jellyfin, with your administrator (it resets
`streamiq-admin` and `streamiq-viewer`). It finds the gateway's state through
`gateway.env` next to the binary, like the running gateway, which picks the
change up within a minute without a restart. Check with `gateway status`.

The page warns when Jellyfin runs a version the gateway wasn't tested with.

## 4. Add your media libraries

Open Jellyfin at `http://localhost:8096`, sign in as the admin (step 3) and go
to **Dashboard → Libraries → Add Media Library**. With the Docker compose file,
pick the folder **inside the container**: a bind with `target: /media/movies`
appears as `/media/movies`, not as `D:\Movies`. Jellyfin scans the library; that
can take a while for big collections.

## 5. Pair a browser and watch

1. In the web app: **Gateways → Open** on your gateway, then **Pair this browser**.
2. The browser shows a code. The local gateway page shows a pairing request with a code.
   **Approve** only if both codes match.
3. Browse your libraries and play. The player shows whether the connection is
   direct or relayed. Each browser (phone, laptop, …) is paired once; remove
   browsers on the local gateway page.

## GPU transcoding (optional)

Most files play as-is (stream copy). Jellyfin re-encodes the video when a
device can't play it that way (some older TVs fall back to this automatically).
On the CPU that can max out a small NAS; a GPU does it almost for free.

**1. Give the container the GPU** (Docker compose file only; a native Jellyfin
sees the GPU already). In `jellyfin-compose.yml`, uncomment one block, then run
`gateway jellyfin up` again:

- **NVIDIA** (`deploy:` block): on Windows, Docker Desktop with the WSL 2 backend
  and a current NVIDIA driver is enough. On Linux, install the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  first.
- **Intel / AMD on Linux** (`devices: /dev/dri` block).
- **Intel QSV / AMD AMF on Windows:** not available in Docker on Windows
  (WSL 2), per Jellyfin's docs. Use a
  [native Jellyfin](https://jellyfin.org/downloads) instead (step 1).

**2. Turn it on.** If the gateway set Jellyfin up (the local gateway page says
**Transcoding settings: managed**), add this line to `gateway.env` and restart
the gateway:

```
STREAMIQ_JELLYFIN_HWACCEL=nvenc
```

The gateway sets NVENC, hardware decoding, tone mapping and the encoder preset
for you. With NVENC on but no GPU in the container, every transcode fails:
remove the line (or leave it empty) and restart, and the gateway turns it off
again. Only NVIDIA is automated so far.

Your own Jellyfin (**not managed**), or Intel / AMD: **Dashboard → Playback →
Transcoding**:

- **Hardware acceleration:** NVIDIA NVENC (Intel: QSV or VA-API; AMD: VA-API
  on Linux, AMF on Windows)
- **Enable hardware decoding for:** tick the codecs your GPU decodes
  (H.264, HEVC, …)
- **Throttle transcodes:** on (stops encoding far ahead of the player)
- **Encoder preset:** `fast` or `medium`, not `auto`: with NVENC, `auto`
  means the lowest-quality preset (p1)

**3. Check it works.** Play something that transcodes (an HEVC file: the web
app always asks for H.264):

- NVIDIA: `docker exec streamiq-jellyfin-jellyfin-1 nvidia-smi` lists the GPU,
  and shows an `ffmpeg` process while it plays.
- Windows: **Task Manager → Performance → GPU**; the **Video Encode** graph
  moves while it plays.

## Removing a gateway

**Gateways → Remove** in the web app revokes the gateway's credential at once:
it disconnects, any open streams through it stop, and it logs
`credential revoked or unknown` while it keeps retrying. To add the same box
again, stop the gateway, delete `gateway.json` in its state directory, and run a
new install command (**Add gateway**). The certificate in the state directory
is kept, so paired browsers don't need to pair again.

### If the gateway or a backup of its state may have leaked

Whoever has a copy of `state/` can pose as your gateway. Replace its identity:

1. **Gateways → Remove** in the web app (revokes the leaked credential).
2. Stop the gateway (Windows: `gateway service uninstall`), delete `gateway.json`
   in its state directory, and run a new install command (**Add gateway**).
3. Stop it again and run `gateway reset-identity`: a new certificate, and every
   paired browser is removed. Start the gateway (`gateway service install`).
4. Open StreamIQ on each browser: it shows a pairing code, approve it on the
   local gateway page.
5. A leaked backup with Jellyfin's data also holds the password hashes of
   Jellyfin's users: change the passwords of Jellyfin users you made yourself.

## Back up and restore the gateway

`state/` is what makes your gateway *this* gateway: its certificate (paired
browsers check it), its StreamIQ credential, the paired browsers and its Jellyfin
login. Back it up once, and again after you pair a new browser:

    gateway backup                 # streamiq-gateway-<name>-<date>-<time>.zip in the current folder
    gateway backup D:\keep\gw.zip  # or name the file

Run the `gateway` in the install dir; it works while the gateway runs. The page login (`page-token`, `page-link`) is left out: the
restored gateway makes a new one. If you run Jellyfin with `gateway jellyfin up`, the
backup also holds its `jellyfin-compose.yml` (your media folders and the Jellyfin
version) and Jellyfin's database: its users, libraries, watch history and resume
points (Jellyfin's own backup, made through its API; not posters, images, trickplay
or subtitles). The gateway includes Jellyfin only if it set that Jellyfin up, the
compose file is next to it and Jellyfin keeps its data in the `jellyfin-config`
folder beside it; otherwise, or if Jellyfin is unreachable or refuses the gateway's
admin password, the backup holds the gateway alone and `gateway backup` says why.

**The backup is a secret and not encrypted.** Whoever has the file can pose as
your gateway. Keep it like a password: not in a shared or synced folder, not in
email. If it leaks, see
[If the gateway or a backup of its state may have leaked](#if-the-gateway-or-a-backup-of-its-state-may-have-leaked).

First stop or uninstall the old gateway if it still runs (Windows: `gateway
service uninstall`). Two copies of the same gateway fight over its connection:
the one that connected last wins, the other one keeps reconnecting.

**Onto a new machine** (or after deleting the install dir): run the installer with
the backup instead of an enroll token. `STREAMIQ_API_URL` is your StreamIQ web
app's address (it's also in the old install's `gateway.env`):

- Linux / macOS: `curl -fsSL …/install.sh | STREAMIQ_API_URL=… STREAMIQ_RESTORE=./streamiq-gateway-….zip sh`
- Windows (PowerShell): `$env:STREAMIQ_API_URL='…'; $env:STREAMIQ_RESTORE='.\streamiq-gateway-….zip'; irm …/install.ps1 | iex`

It installs, restores the backup, then starts the gateway. No new gateway is added
in the web app. The backup holds `state/` (and `jellyfin-compose.yml`), not your settings in `gateway.env`:
if you set more than the API URL (`STREAMIQ_ORIGIN` for a Jellyfin on another
machine, `STREAMIQ_JELLYFIN_HWACCEL`, `STREAMIQ_PAGE_PORT`, …), keep a copy of the
old `gateway.env` with the backup. Copy those lines into the new install's
`gateway.env` (leave its `STREAMIQ_STATE_DIR`), then restart the gateway.

**Same install, `state/` lost or broken:** stop the gateway, run `gateway restore
<file>`, start it again (`gateway service install`, or as in
[Start on boot](#start-on-boot)). Restore refuses while the gateway runs, and over
a state dir that already holds a gateway: `gateway restore --force <file>` replaces
it (files the backup doesn't have are removed).

Either way the gateway comes back with its old name and ID, and paired browsers
open it without a new pairing code.

Restore puts the backup's `jellyfin-compose.yml` next to the binary only if there is
none yet: an existing one is never replaced, not even with `--force` (it says which).
**On a new machine, check the media folder paths in `jellyfin-compose.yml`** (each
media folder's `source:`) before `gateway jellyfin up`: the old machine's
folders may not exist there.

Not in the backup: `gateway.env` (see above). `gateway restore` and the installer
leave Jellyfin's data in the zip: `gateway jellyfin restore <file>` puts it back.

**Jellyfin onto a new machine**, in this order:

1. Install with `STREAMIQ_RESTORE` (above).
2. Stop the gateway (Windows: `gateway service uninstall`; Linux / macOS: stop the
   `gateway run` process).
3. Fix the media folder paths in `jellyfin-compose.yml`.
4. `gateway jellyfin up`
5. `gateway jellyfin restore <file>`: it replaces whatever users, libraries and
   watch state this Jellyfin has, completes its setup wizard first if needed, and
   warns if the backup comes from another Jellyfin version. When Jellyfin is back
   and accepts the backup's admin password, it puts the backup's Jellyfin login into
   `state/`. If that fails, the login is unchanged and Jellyfin's log says why
   (`docker compose -f jellyfin-compose.yml logs jellyfin`).
6. Start the gateway (`gateway service install`, or as in [Start on boot](#start-on-boot)).
   It signs in to the restored Jellyfin by itself, and household members find their
   resume points again.
7. Only then `gateway jellyfin upgrade`, if you want a newer Jellyfin.

Posters and images come back with a library scan (Jellyfin: **Dashboard →
Libraries → Scan All Libraries**). Restore refuses while the gateway runs: it would
overwrite the login the restore puts back.

Without Jellyfin's data in the backup, on a fresh Jellyfin (wizard not done) the
gateway sets it up again by itself, as in [3. Connect Jellyfin](#3-connect-jellyfin);
add your libraries again. Against the same Jellyfin the restored login just works.
A different Jellyfin that is already set up refuses the old login: the local
gateway page asks you to **Connect Jellyfin**. Your own Jellyfin (not set up by the
gateway) has its own backups: **Dashboard → Backups**.

## Where things live

| | Windows | Linux / macOS |
|---|---|---|
| Install dir | `%LOCALAPPDATA%\streamiq` | `~/.local/share/streamiq` |
| Settings | `gateway.env` (yours, kept on updates) | same |
| Identity, paired browsers, Jellyfin token, page token | `state\` (never touched by updates; [`gateway backup`](#back-up-and-restore-the-gateway) copies it) | `state/` |
| Log | the gateway's console window (closing it stops the gateway) | `gateway.log` |
| Autostart | scheduled task `streamiq-gateway` (`gateway service install`) | your crontab line |
| Previous binary after `gateway update` | `gateway.exe.old` (replaced by the next update) | — |

`STREAMIQ_DIR` overrides the install dir. Set `STREAMIQ_NAME` and `STREAMIQ_PAGE_PORT` on
the first install to change the gateway's name or page port.

## Update

The gateway checks GitHub once a day. When a newer release exists, it logs
`update available vA → vB. Run: …` and shows the same on its local gateway page. Run
that command:

- Windows: `%LOCALAPPDATA%\streamiq\gateway.exe update` (cmd) or
  `& "$env:LOCALAPPDATA\streamiq\gateway.exe" update` (PowerShell). It downloads
  the release, checks it against `SHA256SUMS` (a mismatch installs nothing),
  swaps the binary and restarts the `streamiq-gateway` task. Without the task it
  tells you to restart the gateway yourself.
- Linux / macOS: `curl -fsSL https://github.com/bifi627/streamiq/releases/latest/download/install.sh | sh`
  stops the running gateway, swaps the binary and starts it again.

Your settings and paired browsers stay. Nothing updates without you running it.

**Jellyfin (Docker):** when the page warns that Jellyfin runs a version the
gateway wasn't tested with, run `gateway jellyfin upgrade`. It changes only the
`image:` line in `jellyfin-compose.yml` to the tested version and restarts
Jellyfin; your media folders and everything else in the file stay.

## Start on boot

- Windows: the installer runs `gateway service install`, which creates the
  scheduled task `streamiq-gateway`: the gateway starts at your logon in its own
  console window (closing it stops the gateway until the next logon). Start it
  again now with `schtasks /Run /TN streamiq-gateway`. `gateway service uninstall`
  stops it and removes the task; `state\` and `gateway.env` stay.
- Linux / macOS (manual for now): `crontab -e`, add `@reboot cd ~/.local/share/streamiq && ./gateway >> gateway.log 2>&1`

## Releasing (maintainers)

Automatic (#274): after CI passed on a push to `main` (the last job of `ci.yml`), the
gateway releases if `gateway/` (`*_test.go` aside) changed since the last stable release.
It releases what `main` is, so a change whose own push didn't release (red CI, a cancelled
run, `[skip release]` in the subject) goes out with the next one. Version
(`scripts/next-gateway-version.sh`): the highest stable `gateway-v*` tag, minor bumped if any
gateway commit since it is marked breaking with `!` right after the type (`feat!: …`,
`fix(gateway)!: …`, `feat!: gateway: …`; not `feat: gateway!: …`), else patch bumped. The
subject is the PR title (repo setting: squash commit = PR title). A re-run or an older commit never releases over a newer one.

The major never changes automatically: to bump it, push a tag `gateway-vN.0.0` by hand on a
commit on `main`; that releases it, and later automatic releases build on it.

Either way CI (`release-gateway.yml`) tests, builds all six
binaries, and publishes the GitHub Release with `SHA256SUMS`, both install
scripts and `jellyfin-compose.yml`. When bumping the Jellyfin pin, update
`docker-compose.yml`, `gateway/install/jellyfin-compose.yml`,
`jellyfin.Image` and `jellyfin.Tested` together (a gateway test enforces it). A tag with a suffix (`gateway-v1.5.0-rc.1`) becomes a prerelease,
which `latest` and the update check skip.

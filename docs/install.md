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
  machine at `http://localhost:8096`. Add `STREAMIQ_ORIGIN=http://localhost:8096`
  to the install command (step 2): the installer otherwise sees port 8096 taken and
  points the gateway at the next free port instead.
- **Native install:** install [Jellyfin](https://jellyfin.org/downloads), but
  **skip its setup wizard**. The gateway completes it in step 3. Add
  `STREAMIQ_ORIGIN=http://localhost:8096` to the install command, as above.
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
  This Jellyfin starts **offline**: see [Offline Jellyfin](#offline-jellyfin).

## 2. Install the gateway

1. In the StreamIQ web app: a new account is in no household yet, so click **Create a household**
   first (you become its admin; already a member of someone else's: **Household → Create another household**). Then **Gateways → Add gateway** (household admins only). Copy the command for your
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

If the token stops working (for example you signed the gateway out under
Dashboard → Devices), the gateway signs in again by itself. If you deleted
`streamiq-viewer` or changed its password, the page asks you to **Connect
Jellyfin** again.

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

1. In the web app: **Gateways**, then **Pair this browser** on your gateway's card
   (it stands where **Open** is until this browser is paired).
2. The browser shows a code. The local gateway page shows a pairing request with a code.
   **Approve** only if both codes match.
3. **Open** the gateway, browse your libraries and play. The player shows whether the connection is
   direct or relayed. Each browser (phone, laptop, …) is paired once; remove
   browsers on the local gateway page, or under **Paired clients** on the gateway's card in
   the web app (a household admin any browser, a member only the one they're using).

## Offline Jellyfin

The Jellyfin from `gateway jellyfin up` runs **offline by default**: it sits on a
Docker network with no way out (`internal: true`), and a small forwarder
container (`alpine/socat`) is the only way in, on the gateway's Jellyfin port
(8096, or the one in its `STREAMIQ_ORIGIN`). Jellyfin
can't send your titles or cast to TMDb, OMDb or anyone else, whatever its own
settings say. Scanning and streaming work the same.

What you lose: no downloaded posters, descriptions, ratings or cast photos.
Jellyfin shows the file names, plus artwork and `.nfo` files you keep next to
your media. Its log shows failed plugin update checks (`repo.jellyfin.org`);
that is expected.

The local gateway page and the gateway's status in the web app say which way it
runs: **Offline: enforced** or **Online lookups allowed**. To allow online
lookups, in the gateway's install dir:

```
gateway jellyfin offline off
```

`gateway jellyfin offline on` turns the jail back on. Both restart Jellyfin and
change only the lines between the `# streamiq:jail` / `# streamiq:online`
markers in `jellyfin-compose.yml`; keep those marker lines if you edit the file.
A file from before the jail gets it from `gateway jellyfin upgrade` (see
[Update](#update)); one it can't read is left alone, and the command prints what
to change by hand (copy the `forwarder` service and the `networks:` block from
the release's `jellyfin-compose.yml`, and replace the jellyfin service's `ports:`
with `networks: [jail]`). Only this Jellyfin is covered: one you installed
yourself or run natively reaches the internet as you set it up.

### Libraries: Offline and Extras

On a Jellyfin the gateway set up, the local gateway page links to **Libraries**:
each library with two states, read from Jellyfin every time you open it (the
gateway stores nothing about libraries, and changes one only when you press its
button):

- **Offline**: Jellyfin looks nothing up online for that library: every metadata
  and image fetcher is off, *Screen Grabber* too (a grabbed frame can show the
  content itself). **Online (set in Jellyfin)** means at least one is on, or the
  library never got explicit settings (Jellyfin then runs every fetcher).
  **Make offline** turns them all off. In the jail the lookups fail anyway; this
  stops the errors and keeps the library offline if you ever turn the jail off.
  There is no "make online" button: online lookups stay possible in Jellyfin's
  own **Dashboard → Libraries** (library → *Manage library*).
- **Extras**: seek thumbnails (trickplay), chapter images and audio
  normalization (LUFS). StreamIQ doesn't show them, and they cost CPU and disk.
  **On** / **Off** turns all of them on or off together; **Custom (set in
  Jellyfin)** means you set a mix in the Dashboard.

The gateway also turns TMDb off for people (*Refresh People* looks up cast
names server-wide, whatever the libraries say) and empties Jellyfin's plugin
repository list, once per Jellyfin: a later change in the Dashboard stays.

## GPU transcoding (optional)

Most files play as-is (stream copy). Jellyfin re-encodes the video when a
device can't play it that way (some older TVs fall back to this automatically).
On the CPU that can max out a small NAS; a GPU does it almost for free.

**NVIDIA, with the Jellyfin the gateway set up** (`gateway jellyfin up`): one
command, run next to the gateway binary:

```
gateway jellyfin gpu nvidia
```

It switches on the NVIDIA block in `jellyfin-compose.yml`, sets
`STREAMIQ_JELLYFIN_HWACCEL=nvenc` in `gateway.env`, restarts Jellyfin, checks
that the container sees the GPU (`nvidia-smi`) and restarts the gateway (a gateway
you started by hand on Windows: close its window and start it again). If the
check fails it puts both files back and says why: on Windows you need Docker
Desktop with the WSL 2 backend and a current NVIDIA driver, on Linux the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
`gateway jellyfin gpu off` goes back to the CPU. A `jellyfin-compose.yml` from
an older release needs `gateway jellyfin upgrade` first. Then check it works
(step 3).

Otherwise, by hand:

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

## What the gateway keeps, what StreamIQ sees

StreamIQ keeps only that the gateway is alive (its name, version and LAN address, every
30 s) and, for relayed connections, the bytes Cloudflare relayed per gateway and month.
Setting up each connection passes through StreamIQ (who connects to which gateway, when,
and both sides' network addresses, so the two can find each other), but none of it is
stored. Everything else stays on the gateway, in `state/history/`, shown only to a paired browser
while the gateway is online: its health (**Gateways**, the card's "Health, last 7 days":
Jellyfin reachable and its version, hardware acceleration, the offline jail, active
tunnels and transcodes, CPU % and memory %; a file per day, the last 7 days) and
**Activity**'s list of connections (who used the gateway, when and for what, direct or
relayed, data and throughput; 30 days, `tunnels-*.jsonl`). Never names, media titles,
file names or paths. `gateway backup` carries both. There is nothing to switch: the old
`gateway telemetry` command is gone, and a `state/telemetry` file left from it is ignored.

### Direct connections only

A browser that can't reach the gateway directly (most cellular networks, a strict NAT)
streams through a relay (TURN, run by Cloudflare). The relay sees only encrypted
traffic, but if the stream shouldn't pass through it at all, turn it off for this
gateway: on the gateway's card in the web app (**Allow the relay**, an admin on a paired
browser), or with the gateway stopped, in its install dir:

```
gateway relay off
```

Then such a browser can't connect at all; it says "This gateway allows direct
connections only". `gateway relay on` allows the relay again.

## A second gateway on the same machine

To keep libraries apart (say private media and shared media), install a second
gateway with its own Jellyfin on the same machine: run a new install command
(**Add gateway**) with `STREAMIQ_DIR` set to another folder, e.g.

- Linux / macOS: `curl -fsSL …/install.sh | STREAMIQ_DIR=~/.local/share/streamiq-kids STREAMIQ_API_URL=… STREAMIQ_ENROLL_TOKEN=… sh`
- Windows: `$env:STREAMIQ_DIR="$env:LOCALAPPDATA\streamiq-kids"; $env:STREAMIQ_API_URL='…'; …`

Then, in that folder, `gateway jellyfin up` as in step 1 (its own
`jellyfin-compose.yml`, media folders and `jellyfin-config`).

The folder is the gateway's identity on the machine: everything run from it
(`gateway update`, `rollback`, `backup`, `jellyfin …`, `service …`) acts on that
gateway only. Its Windows logon task is `streamiq-gateway-<folder name>` and its
Docker Compose project `streamiq-jellyfin-<folder name>` (the default folder,
`streamiq`, keeps the plain names), so give each install a folder with its own
name. On a fresh install the installer takes the first free pair of ports from
8096/8097 on (Jellyfin, local gateway page; the second gateway usually gets
8098/8099) and writes them into `gateway.env` as `STREAMIQ_ORIGIN` and
`STREAMIQ_PAGE_PORT`; set either on the install command to choose it, or edit
`gateway.env` later (`jellyfin-compose.yml` only takes the port when
`gateway jellyfin up` first downloads it). Updates never change them.

Each gateway pairs and shows up in the web app like a gateway on its own machine.

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
| Autostart | scheduled task `streamiq-gateway` (`gateway service install`; [another folder's](#a-second-gateway-on-the-same-machine): `streamiq-gateway-<folder name>`) | your crontab line |
| Running gateway's process id (an update, `rollback` and `jellyfin gpu` stop the copy it names) | — | `gateway.pid` |
| Previous binaries + their state, for [`gateway rollback`](#roll-back-an-update) | `backups\` (the last 3 updates) | `backups/` |

`STREAMIQ_DIR` overrides the install dir ([a second gateway](#a-second-gateway-on-the-same-machine)). Set `STREAMIQ_NAME`, `STREAMIQ_ORIGIN` and `STREAMIQ_PAGE_PORT` on
the first install to change the gateway's name, Jellyfin address or page port. `STREAMIQ_NAME` sets only the
first name: later, a household admin renames the gateway on the web app's Gateways page
(**Rename**, while it is online), and the gateway keeps that name in `state/gateway.json`.

## gateway.env

The gateway reads its settings from the environment, or from `gateway.env` next to the
binary (or in the working dir); a real environment variable wins over the file. The
installer writes `STREAMIQ_API_URL`, `STREAMIQ_STATE_DIR`, `STREAMIQ_ORIGIN` and `STREAMIQ_PAGE_PORT`
there on the first install (the ports: the first free pair from 8096/8097 on, unless set on
the install command; plus `STREAMIQ_NAME` when set).
Installer-only variables are set on the install command, not in `gateway.env`.

| Variable | Default | What it does |
|---|---|---|
| `STREAMIQ_API_URL` | — (required) | The StreamIQ web app's address; the gateway connects to it. |
| `STREAMIQ_ENROLL_TOKEN` | — | One-time token from **Gateways → Add gateway**; used only on the first start, before the gateway has its credential. |
| `STREAMIQ_NAME` | the computer's name | The gateway's first name; later renames happen in the web app. |
| `STREAMIQ_STATE_DIR` | `streamiq-state` (installer: `<install dir>/state`; Docker image: `/state`) | Where identity, paired browsers and tokens live. |
| `STREAMIQ_PAGE_PORT` | `8097` | Port of the local gateway page. |
| `STREAMIQ_LAN_URL` | first private IPv4 + page port | The local gateway page's address on your LAN; needed in Docker, where the container's IP is useless. |
| `STREAMIQ_ORIGIN` | `http://localhost:8096` | Your Jellyfin's address (another machine: its LAN address). |
| `STREAMIQ_JELLYFIN_HWACCEL` | unset (CPU) | `nvenc` = NVIDIA GPU transcoding on a Jellyfin the gateway set up ([GPU transcoding](#gpu-transcoding-optional)). |
| `STREAMIQ_ICE_URLS` | — (STUN only) | Comma-separated TURN URLs for the gateway's side of the tunnel; unused with the relay off ([Direct connections only](#direct-connections-only)). |
| `STREAMIQ_ICE_USERNAME` | — | TURN username for `STREAMIQ_ICE_URLS`. |
| `STREAMIQ_ICE_CREDENTIAL` | — | TURN credential for `STREAMIQ_ICE_URLS`. |
| `STREAMIQ_ICE_PORT` | — (any port) | Pins WebRTC to one UDP port and advertises the `STREAMIQ_LAN_URL` host if it is an IP address (a hostname is ignored); for Docker (the image sets `8098`). |
| `STREAMIQ_DOWNLOAD` | GitHub's latest release | Where the installer, `gateway update` and `gateway jellyfin up` download release files. |
| `STREAMIQ_LATEST` | GitHub's latest-release API | Where the gateway checks for a newer release; tests only. |
| `STREAMIQ_DIR` | `%LOCALAPPDATA%\streamiq` / `~/.local/share/streamiq` | Installer only: the install dir. |
| `STREAMIQ_RESTORE` | — | Installer only: a `gateway backup` zip to restore instead of enrolling ([Back up and restore](#back-up-and-restore-the-gateway)). |

## Command line

Run `gateway` from the install dir (Linux / macOS: `./gateway`). `gateway -h` lists the commands, and
`gateway <command> -h` (or `gateway help <command>`) explains one, with examples.

Tab completion for your shell (commands, `on|off`, `nvidia|off`, `off|full`, backup files):

- PowerShell: add `& "$env:LOCALAPPDATA\streamiq\gateway.exe" completion powershell | Out-String | Invoke-Expression`
  to your profile (`notepad $PROFILE`).
- bash: add `source <(~/.local/share/streamiq/gateway completion bash)` to `~/.bashrc`.
- zsh: add `source <(~/.local/share/streamiq/gateway completion zsh)` to `~/.zshrc`
  (after `compinit`).
- fish: `~/.local/share/streamiq/gateway completion fish > ~/.config/fish/completions/gateway.fish`

Completion works for the name `gateway`: put the install dir on your `PATH` (or
call it through an alias named `gateway`).

## Update

The gateway checks GitHub once a day. When a newer release exists, it logs
`update available vA → vB. Run: …` and shows the same on its local gateway page. Run
that command:

- Windows: `%LOCALAPPDATA%\streamiq\gateway.exe update` (cmd) or
  `& "$env:LOCALAPPDATA\streamiq\gateway.exe" update` (PowerShell). It downloads
  the release, checks it against `SHA256SUMS` (a mismatch installs nothing),
  swaps the binary and restarts the `streamiq-gateway` task. Without the task it
  tells you to restart the gateway yourself.
- Linux / macOS: `curl -fsSL https://github.com/bifi627/streamiq/releases/latest/download/install.sh | STREAMIQ_DIR='<install dir>' sh`
  stops the running gateway, swaps the binary and starts it again. The printed command
  names this gateway's install dir, so it updates only that one
  ([a second gateway](#a-second-gateway-on-the-same-machine)).

**From the web app (Windows, with the logon task):** a household admin whose browser is
paired sees **Update to v…** on the gateway's card on the Gateways page. It runs the same
update as above, started by the gateway itself; the card shows *Updating* until the gateway
is back on the new version (its output is in `update.log` in the install dir). Without the
logon task (`gateway service install`, once at home) the card says so instead: nothing would
start the gateway again. If after about 2 minutes the gateway still runs the old version, the
update failed (or is still backing up): `update.log` says which; don't roll back, nothing
changed; **Try again** on the card starts it once more. If it isn't back at all, check `update.log` at home and run
[`gateway rollback`](#roll-back-an-update).
Linux / macOS: by hand as above for now.

Your settings and paired browsers stay. Nothing updates without you (or an admin in the web app) starting it.
Before it replaces anything, an update backs up the gateway with the installed
version and keeps that version's binary: see [Roll back an update](#roll-back-an-update).
If that backup fails, the update stops and nothing changes.

**Jellyfin (Docker):** when the page warns that Jellyfin runs a version the
gateway wasn't tested with, run `gateway jellyfin upgrade`. It changes only the
`image:` line in `jellyfin-compose.yml` to the tested version and restarts
Jellyfin; your media folders and everything else in the file stay. A file from
before the [offline jail](#offline-jellyfin) is also moved into it: the jellyfin
service's `ports:` become the jail network and the forwarder service and the
`networks:` block are added (nothing else changes). A jail you turned off stays off.

## Roll back an update

If a new version misbehaves, go back to the one before it:

- Windows: `%LOCALAPPDATA%\streamiq\gateway.exe rollback`
- Linux / macOS: `~/.local/share/streamiq/gateway rollback`

It stops the gateway, puts the previous binary back, restores the state that
version had (`gateway restore --force` with that binary), starts it again and
prints the version it went back to. Paired browsers keep working: same gateway,
same identity. The state is the one from the moment of the update: a browser
paired since then pairs again. Run it again to go back one more update.

Every update (`gateway update`, or the installer run over an install) leaves one
folder in `backups/` next to the binary, `<date>-<time>-<version>`, with the
replaced binary and a [`gateway backup`](#back-up-and-restore-the-gateway) zip
(`state.zip`). The last 3 are kept; an update removes older ones. **These are
unencrypted secrets, like any gateway backup**: whoever has `backups/` can pose as
your gateway. Rollback restores the gateway's state only, not Jellyfin's data
(that stays in `state.zip`: `gateway jellyfin restore`). A version older than
`gateway backup` can't back itself up: updating from it leaves no rollback point.
Neither does an installer run over a gateway without identity (removed or never
enrolled) or over the same release.

## Start on boot

- Windows: the installer runs `gateway service install`, which creates the
  scheduled task `streamiq-gateway` (another install folder's: `streamiq-gateway-<folder name>`):
  the gateway starts at your logon in its own
  console window (closing it stops the gateway until the next logon). Start it
  again now with `schtasks /Run /TN streamiq-gateway`. `gateway service uninstall`
  stops it and removes the task; `state\` and `gateway.env` stay.
- Linux / macOS (manual for now): `crontab -e`, add `@reboot cd ~/.local/share/streamiq && ./gateway >> gateway.log 2>&1`

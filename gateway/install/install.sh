#!/bin/sh
# StreamIQ gateway: install, or update in place (item 4). The web app's
# Gateways -> Add gateway shows the first-run command (it sets STREAMIQ_API_URL +
# STREAMIQ_ENROLL_TOKEN); later, updating is just:
#   curl -fsSL https://github.com/bifi627/streamiq/releases/latest/download/install.sh | sh
# The state dir (cert, credential, paired browsers) is never touched.
set -eu
umask 077 # state, gateway.env and the log are for this user only
DIR="${STREAMIQ_DIR:-$HOME/.local/share/streamiq}"
DL="${STREAMIQ_DOWNLOAD:-https://github.com/bifi627/streamiq/releases/latest/download}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "StreamIQ: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
bin="streamiq-gateway-$os-$arch"

if [ ! -f "$DIR/gateway.env" ] && [ -z "${STREAMIQ_API_URL:-}" ]; then
  echo "StreamIQ: first install needs the command from the web app (Gateways -> Add gateway)" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$bin" "$DL/$bin"
curl -fsSL -o "$tmp/SHA256SUMS" "$DL/SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then sum="sha256sum"; else sum="shasum -a 256"; fi
(cd "$tmp" && grep "[ *]$bin$" SHA256SUMS | $sum -c - >/dev/null) || {
  echo "StreamIQ: checksum mismatch for $bin, not installing" >&2
  exit 1
}

mkdir -p "$DIR/state"
# Update: the installed (old) binary backs up its own state first, and is kept
# next to it, for `gateway rollback` (#296). No backup, no update. A gateway
# older than `gateway backup` (#52) can't: it's replaced without one.
keep=
chmod +x "$tmp/$bin"
if [ ! -f "$DIR/state/cert.pem" ] || [ ! -f "$DIR/state/gateway.json" ]; then
  : # no gateway identity (fresh install, failed enrollment, removed gateway): nothing to roll back to
elif [ -x "$DIR/gateway" ] && "$DIR/gateway" -h 2>/dev/null | grep -q '^  backup '; then
  ver=$("$DIR/gateway" version 2>/dev/null) || ver=unknown
  # A re-run of the installed release keeps no copy (it would push the real previous one out).
  if ! cmp -s "$DIR/gateway" "$tmp/$bin"; then
    keep="$DIR/backups/$(date +%Y%m%d-%H%M%S)-$ver"
    mkdir -p "$keep" # umask 077: 0700
    "$DIR/gateway" backup "$keep/state.zip" >/dev/null || {
      rm -rf "$keep"
      echo "StreamIQ: backing up the installed gateway failed, nothing changed" >&2
      exit 1
    }
  fi
elif [ -f "$DIR/gateway" ]; then
  echo "StreamIQ: the installed gateway can't back itself up; updating without a rollback point" >&2
fi
# Running copy (update), as the gateway's own stop does: gateway.pid names one
# started any way (./gateway, gateway run) while its process is still a gateway;
# pkill, one older than the pid file (started by its full path).
stopped=
pid=$(cat "$DIR/gateway.pid" 2>/dev/null) &&
  [ "$(basename "$(ps -p "$pid" -o comm= 2>/dev/null)" 2>/dev/null)" = gateway ] &&
  kill "$pid" 2>/dev/null && stopped=1
pkill -f "^$DIR/gateway$" 2>/dev/null && stopped=1
[ -n "$stopped" ] && sleep 1
[ -n "$keep" ] && mv "$DIR/gateway" "$keep/gateway"
mv "$tmp/$bin" "$DIR/gateway" || {
  [ -n "$keep" ] && mv "$keep/gateway" "$DIR/gateway"
  exit 1
}
# The last 3 updates' backups stay (as gateway update keeps them).
# shellcheck disable=SC2012 # backup dirs are timestamps the gateway names; ls | sort is the newest-first order
[ -d "$DIR/backups" ] && ls -1 "$DIR/backups" | sort -r | tail -n +4 | while read -r d; do rm -rf "${DIR:?}/backups/$d"; done

if [ ! -f "$DIR/gateway.env" ]; then
  {
    echo "STREAMIQ_API_URL=$STREAMIQ_API_URL"
    echo "STREAMIQ_STATE_DIR=$DIR/state"
    # Optional first-install settings persist, so updates keep them.
    [ -n "${STREAMIQ_NAME:-}" ] && echo "STREAMIQ_NAME=$STREAMIQ_NAME"
    [ -n "${STREAMIQ_PAGE_PORT:-}" ] && echo "STREAMIQ_PAGE_PORT=$STREAMIQ_PAGE_PORT"
    true
  } > "$DIR/gateway.env"
fi

# The enrollment token only matters on the first start; it is never stored.
rm -f "$DIR/state/page-link" # the installer waits for this start's fresh link
# A backup onto this machine (#52): restored before the first start, so it doesn't enroll a new gateway.
if [ -n "${STREAMIQ_RESTORE:-}" ]; then
  "$DIR/gateway" restore "$STREAMIQ_RESTORE" || exit 1
fi
cd "$DIR" && nohup "$DIR/gateway" >> "$DIR/gateway.log" 2>&1 &
sleep 2
echo "StreamIQ gateway started"
echo "  installed:  $DIR"
port=$(sed -n 's/^STREAMIQ_PAGE_PORT=//p' "$DIR/gateway.env")
echo "  local page: http://localhost:${port:-8097}"
# The gateway writes its LAN login link once enrolled (page token, item 6 / #42).
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$DIR/state/page-link" ] && break; sleep 1; done
[ -f "$DIR/state/page-link" ] && echo "  from another device: $(cat "$DIR/state/page-link")"
echo "  log:        $DIR/gateway.log"
echo "  autostart (not set up for you): crontab -e, add"
echo "    @reboot cd $DIR && ./gateway >> gateway.log 2>&1"

#!/bin/sh
# StreamIQ gateway: install, or update in place (item 4). The web app's
# Gateways -> Add gateway shows the first-run command (it sets STREAMIQ_API_URL +
# STREAMIQ_ENROLL_TOKEN); later, updating is just:
#   curl -fsSL https://github.com/bifi627/streamiq/releases/latest/download/install.sh | sh
# The state dir (cert, credential, paired browsers) is never touched.
set -eu
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
pkill -f "^$DIR/gateway$" 2>/dev/null && sleep 1 || true # running copy (update)
chmod +x "$tmp/$bin"
mv "$tmp/$bin" "$DIR/gateway"

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
# Full path on purpose: pkill above matches it on the next update.
rm -f "$DIR/state/page-link" # the installer waits for this start's fresh link
cd "$DIR" && nohup "$DIR/gateway" >> "$DIR/gateway.log" 2>&1 &
sleep 2
echo "StreamIQ gateway started"
port=$(sed -n 's/^STREAMIQ_PAGE_PORT=//p' "$DIR/gateway.env")
echo "  local page: http://localhost:${port:-8097}"
# The gateway writes its LAN login link once enrolled (page token, item 6 / #42).
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$DIR/state/page-link" ] && break; sleep 1; done
[ -f "$DIR/state/page-link" ] && echo "  from another device: $(cat "$DIR/state/page-link")"
echo "  log:        $DIR/gateway.log"
echo "  autostart (not set up for you): crontab -e, add"
echo "    @reboot cd $DIR && $DIR/gateway >> $DIR/gateway.log 2>&1"

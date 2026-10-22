#!/bin/bash
# If macOS says this file is "damaged", ignore that dialog and use Terminal:
#   xattr -cr .
#   chmod +x start.sh
#   bash ./start.sh
set -e
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
LOG="$APP_DIR/.viewer-setup.log"

notify() {
  osascript -e "display notification \"$1\" with title \"Live Workspace Viewer\"" >/dev/null 2>&1 || true
}

# Clear Gatekeeper quarantine from WhatsApp / AirDrop / zip
xattr -cr "$APP_DIR" 2>/dev/null || true

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js is required once. Install LTS from nodejs.org, then run again." buttons {"OK"} default button 1' >/dev/null 2>&1 || true
  open "https://nodejs.org"
  exit 1
fi

export npm_config_fund=false
export npm_config_audit=false
export CSC_IDENTITY_AUTO_DISCOVERY=false

{
  echo "Live Workspace Viewer setup — $(date)"
  echo "Node: $(node -v)  npm: $(npm -v)"
} > "$LOG"

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/electron ]; then
  notify "First launch: installing (a few minutes)…"
  npm ci >> "$LOG" 2>&1 || npm install >> "$LOG" 2>&1
fi

find_built_app() {
  for candidate in \
    "dist/mac-arm64/Live Workspace Viewer.app" \
    "dist/mac/Live Workspace Viewer.app" \
    "dist/mac-x64/Live Workspace Viewer.app"
  do
    if [ -d "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

BUILT_APP="$(find_built_app || true)"

if [ -z "$BUILT_APP" ]; then
  notify "Building Mac app (one-time)…"
  npm run pack:mac >> "$LOG" 2>&1 || true
  BUILT_APP="$(find_built_app || true)"
fi

if [ -n "$BUILT_APP" ]; then
  xattr -dr com.apple.quarantine "$BUILT_APP" 2>/dev/null || true
  notify "Opening Live Workspace Viewer…"
  open "$BUILT_APP"
  exit 0
fi

notify "Opening from source…"
npx --no-install electron . >> "$LOG" 2>&1

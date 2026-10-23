#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Install Node.js from https://nodejs.org, then run this launcher again.\n'
  exit 1
fi
if [ ! -x node_modules/.bin/electron ]; then
  npm ci
fi
exec npm start

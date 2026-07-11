#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm install --omit=dev
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3456}"
export ROOM_START="${ROOM_START:-1}"
export DATA_DIR="${DATA_DIR:-$(pwd)/.data}"

exec node server.js

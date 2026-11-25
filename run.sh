#!/bin/bash
# Starts the Stealther server, launches the scanner app and opens the UI.
#   ./run.sh          real scanning
#   ./run.sh --demo   simulated devices, no scanner app
set -euo pipefail
cd "$(dirname "$0")"
PORT=8765
APP=build/StealtherScanner.app

if [[ "${1:-}" != "--demo" ]]; then
  if [[ ! -x "$APP/Contents/MacOS/StealtherScanner" || scanner/main.swift -nt "$APP/Contents/MacOS/StealtherScanner" ]]; then
    ./build.sh
  fi
fi

python3 server.py --port "$PORT" "$@" &
SERVER=$!
cleanup() {
  kill "$SERVER" 2>/dev/null || true
  pkill -x StealtherScanner 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 1

if [[ "${1:-}" != "--demo" ]]; then
  # Launch through LaunchServices so macOS attributes permissions to the app.
  open "$APP" --args --url "http://127.0.0.1:$PORT/ingest"
fi
open "http://127.0.0.1:$PORT"
echo "Press Ctrl-C to stop."
wait "$SERVER"

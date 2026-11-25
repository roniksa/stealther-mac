#!/bin/bash
# Builds build/StealtherScanner.app (ad-hoc signed so macOS can grant it
# Location + Bluetooth permissions). Re-signing changes the code hash, so
# macOS may ask for permissions again after a rebuild.
set -euo pipefail
cd "$(dirname "$0")"
APP=build/StealtherScanner.app
mkdir -p "$APP/Contents/MacOS"
cp scanner/Info.plist "$APP/Contents/Info.plist"
swiftc -O scanner/main.swift -o "$APP/Contents/MacOS/StealtherScanner" \
  -framework AppKit -framework CoreBluetooth -framework CoreLocation -framework CoreWLAN
codesign --force --sign - "$APP"
echo "Built $APP"

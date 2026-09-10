#!/bin/sh
# Rebuild the bundled IOKit HID helper into assets/.
# Requires Xcode command line tools (swiftc). The helper is committed so
# installs do not need a toolchain; rerun this only after changing the source.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets
swiftc -O -o assets/chromecast-hid-helper native/chromecast-hid-helper.swift
chmod +x assets/chromecast-hid-helper
echo "built assets/chromecast-hid-helper"
assets/chromecast-hid-helper --observe </dev/null &
pid=$!
sleep 0.3
if kill -0 "$pid" 2>/dev/null; then
  echo "smoke test: helper started (no device events expected)"
  kill "$pid" 2>/dev/null || true
else
  echo "smoke test: helper exited early (check output above)" >&2
  exit 1
fi

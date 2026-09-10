#!/bin/sh
# Rebuild the bundled IOKit HID helper into assets/.
# Requires Xcode command line tools (swiftc). The helper is committed so
# installs do not need a toolchain; rerun this only after changing the source.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets
swiftc -O -o assets/chromecast-hid-helper native/chromecast-hid-helper.swift native/HidBridge.swift native/HIDDiagnostics.swift native/HIDReport.swift
chmod +x assets/chromecast-hid-helper
echo "built assets/chromecast-hid-helper"
# Verify the executable without opening devices or triggering permission UI.
# stdin EOF is a normal exit, so /dev/null cannot test a long-lived helper.
assets/chromecast-hid-helper --help

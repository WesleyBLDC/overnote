#!/bin/bash
# Runs the swift-testing suite.
#
# With only the Xcode Command Line Tools installed, SwiftPM builds the test runner without
# the Testing framework on its search path, so the runner silently finds zero tests.
# Passing the framework directory to every target (and as an rpath) fixes discovery.
# With full Xcode selected, plain `swift test` works and these flags are harmless.
set -euo pipefail
cd "$(dirname "$0")"

# Generate HelperVersion.current from helper/VERSION before SwiftPM compiles anything, so a fresh checkout can run these tests before any build.
bash ../scripts/generate-helper-version.sh

DEV_DIR="$(xcode-select -p 2>/dev/null || echo /Library/Developer/CommandLineTools)"
FLAGS=()
for base in "$DEV_DIR/Library/Developer" "$DEV_DIR/Platforms/MacOSX.platform/Developer/Library"; do
  if [[ -d "$base/Frameworks/Testing.framework" ]]; then
    FLAGS+=(-Xswiftc -F -Xswiftc "$base/Frameworks" -Xlinker -rpath -Xlinker "$base/Frameworks")
    if [[ -d "$base/usr/lib" ]]; then
      FLAGS+=(-Xlinker -rpath -Xlinker "$base/usr/lib")
    fi
    if [[ -d "$DEV_DIR/usr/lib/swift/host/plugins/testing" ]]; then
      FLAGS+=(-Xswiftc -plugin-path -Xswiftc "$DEV_DIR/usr/lib/swift/host/plugins/testing")
    fi
    break
  fi
done

exec swift test "${FLAGS[@]}" "$@"

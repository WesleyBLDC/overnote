#!/bin/bash
# The full local suite, in the same order as CI (.github/workflows/ci.yml).
#
#   npm run verify
#
# Stops at the first failing step and names it. Needs macOS with the Xcode Command Line
# Tools, Node 22+, the Playwright browsers (npx playwright install webkit chromium), and a
# logged in GUI session for the window check.
#
# Environment:
#   OVERNOTE_SKIP_WINDOW_E2E=1  skip scripts/e2e-window.sh (it shows the panel briefly)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RAY_OUT="$(mktemp -d /tmp/overnote-raybuild.XXXXXX)"

STEPS=()
started=$SECONDS
current=""
on_exit_status() {
  local status=$?
  if [[ $status -ne 0 && -n "$current" ]]; then
    printf '\n[verify] FAILED: %s\n' "$current" >&2
  fi
}
trap 'on_exit_status; rm -rf "$RAY_OUT"' EXIT

step() {
  current="$1"
  shift
  printf '\n[verify] ==> %s\n' "$current"
  local t0=$SECONDS
  "$@"
  STEPS+=("$(printf '%4ss  %s' $((SECONDS - t0)) "$current")")
}

step "Typecheck: extension" npx tsc --noEmit
step "Typecheck: editor" npx tsc --noEmit -p editor
step "Typecheck: core" npx tsc --noEmit -p packages/core
step "Lint: ESLint" npx eslint src
step "Lint: Prettier" npx prettier --check src
step "Build: editor" npm run build:editor
step "Build: helper" bash scripts/build-helper.sh
step "Unit: extension and helper socket" npm test
step "Unit: core" npm test -w packages/core
step "Unit: editor" npm test -w editor
step "Unit: helper" bash helper/test.sh
step "End to end: editor (Playwright)" npm run test:e2e -w editor
step "End to end: helper smoke" bash scripts/smoke-helper.sh
if [[ "${OVERNOTE_SKIP_WINDOW_E2E:-0}" == "1" ]]; then
  printf '\n[verify] skipped: End to end: panel window (OVERNOTE_SKIP_WINDOW_E2E=1)\n'
  STEPS+=("   -   End to end: panel window (skipped)")
else
  step "End to end: panel window" bash scripts/e2e-window.sh
fi
step "Build: Raycast extension (ray build -e dist)" npx ray build -e dist -o "$RAY_OUT"
current=""

printf '\n[verify] all steps passed in %ss\n' $((SECONDS - started))
printf '[verify] %s\n' "${STEPS[@]}"

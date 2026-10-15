#!/bin/bash
# The full local suite, in the same order as CI (.github/workflows/ci.yml).
#
#   npm run verify
#
# Stops at the first failing step and names it. Needs macOS with the Xcode Command Line
# Tools, Node 22+, and the Playwright browsers (npx playwright install webkit chromium).
#
# The panel window check (scripts/e2e-window.sh) shows the panel on screen and needs a logged
# in GUI session, so it is opt in on a workstation and on by default in CI.
#
# Environment:
#   OVERNOTE_WINDOW_E2E=1  run scripts/e2e-window.sh (the default when CI=true)
#   OVERNOTE_WINDOW_E2E=0  skip it, even in CI
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
step "Lint: ESLint, extension" npx eslint src
step "Lint: ESLint, editor and core" npx eslint --max-warnings 0 editor packages/core
step "Lint: Prettier" npx prettier --check src editor packages/core
step "Build: editor" npm run build:editor
step "Build: helper" bash scripts/build-helper.sh
step "Unit: extension and helper socket" npm test
step "Unit: core" npm test -w packages/core
step "Unit: editor" npm test -w editor
step "Unit: helper" bash helper/test.sh
step "End to end: editor (Playwright)" npm run test:e2e -w editor
step "End to end: helper smoke" bash scripts/smoke-helper.sh
step "End to end: install, update, backups, and restore" bash scripts/e2e-update.sh
window_e2e="${OVERNOTE_WINDOW_E2E:-}"
if [[ -z "$window_e2e" ]]; then
  [[ "${CI:-}" == "true" ]] && window_e2e=1 || window_e2e=0
fi
if [[ "$window_e2e" == "1" ]]; then
  step "End to end: panel window" bash scripts/e2e-window.sh
else
  printf '\n[verify] skipped: End to end: panel window (shows the panel; set OVERNOTE_WINDOW_E2E=1 to run it)\n'
  STEPS+=("   -   End to end: panel window (skipped)")
fi
step "Build: Raycast extension (ray build -e dist)" npx ray build -e dist -o "$RAY_OUT"
current=""

printf '\n[verify] all steps passed in %ss\n' $((SECONDS - started))
printf '[verify] %s\n' "${STEPS[@]}"

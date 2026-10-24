#!/bin/bash
# The full suite, and the only gate: checks run locally on macOS with Apple silicon.
#
#   npm run verify
#   VERIFY_MODE=fast npm run verify
#   npm run verify:fast
#   bash scripts/verify.sh fast
#
# The full mode is the single full gate and keeps the original step names and order.
# The fast mode is a strict subset of the full gate by construction. Every step is defined
# once in step_body below, the full gate lists every step name once in ALL_STEPS, and the
# fast gate lists only names drawn from that same list in FAST_STEPS. Fast mode runs the
# three typechecks, ESLint, Prettier, the core fixtures, the editor unit tests, and the
# helper unit tests. Independent read only checks (the typechecks, then the lints) run
# concurrently in fast mode and their output is replayed in step order.
#
# Stops at the first failing step and names it. Needs macOS with the Xcode Command Line
# Tools, Node 22+, and the Playwright browsers (npx playwright install webkit).
#
# The panel window check (scripts/e2e-window.sh) shows the panel on screen and needs a logged
# in GUI session, so it is skipped unless OVERNOTE_WINDOW_E2E=1.
#
# Environment:
#   VERIFY_MODE=fast       run the fast subset described above (default is full)
#   OVERNOTE_WINDOW_E2E=1  run scripts/e2e-window.sh (off by default)
#   OVERNOTE_HARNESS_PORT  dev server port for the editor Playwright step; the preview port is
#                          OVERNOTE_PREVIEW_PORT, default one lower. When unset, each run picks
#                          a free pair, so worktrees can run verify at the same time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERIFY_MODE="${VERIFY_MODE:-full}"
if [[ $# -gt 0 ]]; then
  case "$1" in
    fast | full) VERIFY_MODE="$1"; shift ;;
    --fast) VERIFY_MODE=fast; shift ;;
    --full) VERIFY_MODE=full; shift ;;
    *)
      printf 'usage: scripts/verify.sh [fast|full]\n' >&2
      exit 2
      ;;
  esac
fi
if [[ $# -gt 0 ]]; then
  printf 'usage: scripts/verify.sh [fast|full]\n' >&2
  exit 2
fi
case "$VERIFY_MODE" in
  fast | full) ;;
  *)
    printf '[verify] unknown VERIFY_MODE: %s (expected fast or full)\n' "$VERIFY_MODE" >&2
    exit 2
    ;;
esac

# A free port pair for the browser harness, unless the caller chose one. Playwright starts its
# servers with --strictPort and never reuses one, so a pair taken after this probe fails loudly.
if [[ -z "${OVERNOTE_HARNESS_PORT:-}" ]]; then
  ports="$(node -e '
    const net = require("node:net");
    const take = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    (async () => { const a = await take(); let b = await take(); while (b === a) b = await take(); console.log(a + " " + b); })();
  ')"
  export OVERNOTE_HARNESS_PORT="${ports% *}"
  export OVERNOTE_PREVIEW_PORT="${ports#* }"
fi

RAY_OUT="$(mktemp -d /tmp/overnote-raybuild.XXXXXX)"
PARALLEL_TMP="$(mktemp -d /tmp/overnote-verify-parallel.XXXXXX)"

# Every step the full gate runs, in the original order. This is the single registry that
# both modes draw from, so fast mode cannot drift away from the full gate.
ALL_STEPS=(
  "Check: version"
  "Typecheck: extension"
  "Typecheck: editor"
  "Typecheck: core"
  "Lint: Raycast lint, extension"
  "Lint: ESLint, editor and core"
  "Lint: Prettier"
  "Build: editor"
  "Build: helper"
  "Unit: extension and helper socket"
  "Unit: core"
  "Unit: editor"
  "Unit: helper"
  "End to end: editor (Playwright)"
  "End to end: helper smoke"
  "End to end: install, update, backups, and restore"
  "End to end: panel window"
  "Build: Raycast extension (ray build -e dist)"
)

# Names only, never commands. Each entry must appear in ALL_STEPS (checked below), which
# is what makes fast mode a strict subset of the full gate by construction.
FAST_STEPS=(
  "Typecheck: extension"
  "Typecheck: editor"
  "Typecheck: core"
  "Lint: ESLint, editor and core"
  "Lint: Prettier"
  "Unit: core"
  "Unit: editor"
  "Unit: helper"
)

# The one place each step name maps to its command.
step_body() {
  case "$1" in
    "Check: version") bash scripts/check-version.sh "$(tr -d '[:space:]' <helper/VERSION)" ;;
    "Typecheck: extension") npx tsc --noEmit ;;
    "Typecheck: editor") npx tsc --noEmit -p editor ;;
    "Typecheck: core") npx tsc --noEmit -p packages/core ;;
    "Lint: Raycast lint, extension") npx ray lint ;;
    "Lint: ESLint, editor and core") npx eslint --max-warnings 0 editor packages/core ;;
    "Lint: Prettier") npx prettier --check src editor packages/core ;;
    "Build: editor") npm run build:editor ;;
    "Build: helper") bash scripts/build-helper.sh ;;
    "Unit: extension and helper socket") npm test ;;
    "Unit: core") npm test -w packages/core ;;
    "Unit: editor") npm test -w editor ;;
    "Unit: helper") bash helper/test.sh ;;
    "End to end: editor (Playwright)") npm run test:e2e -w editor ;;
    "End to end: helper smoke") bash scripts/smoke-helper.sh ;;
    "End to end: install, update, backups, and restore") bash scripts/e2e-update.sh ;;
    "End to end: panel window") bash scripts/e2e-window.sh ;;
    "Build: Raycast extension (ray build -e dist)") npx ray build -e dist -o "$RAY_OUT/raybuild" ;;
    *)
      printf '[verify] unknown step: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

# Fail closed before doing any work if a fast step is not part of the full gate.
for fast_step in "${FAST_STEPS[@]}"; do
  found=0
  for full_step in "${ALL_STEPS[@]}"; do
    if [[ "$full_step" == "$fast_step" ]]; then
      found=1
      break
    fi
  done
  if [[ "$found" != "1" ]]; then
    printf '[verify] fast step is not in the full gate: %s\n' "$fast_step" >&2
    exit 2
  fi
done

STEPS=()
started=$SECONDS
current=""
on_exit_status() {
  local status=$?
  if [[ $status -ne 0 && -n "$current" ]]; then
    printf '\n[verify] FAILED: %s\n' "$current" >&2
  fi
}
trap 'on_exit_status; rm -rf "$RAY_OUT" "$PARALLEL_TMP"' EXIT

# On GitHub Actions each step is a collapsible group in the log.
GROUPS_ON=0
[[ "${GITHUB_ACTIONS:-}" == "true" ]] && GROUPS_ON=1

step() {
  current="$1"
  ((GROUPS_ON)) && printf '::group::%s\n' "$current"
  printf '\n[verify] ==> %s\n' "$current"
  local t0=$SECONDS
  step_body "$current"
  ((GROUPS_ON)) && printf '::endgroup::\n'
  STEPS+=("$(printf '%4ss  %s' $((SECONDS - t0)) "$current")")
  current=""
}

# Runs the given steps at the same time, capturing each output and replaying it in the
# order the steps were listed. Only used for the read only typecheck and lint groups in
# fast mode, which write no shared build output.
step_parallel() {
  local names=("$@")
  local t0=$SECONDS
  local dir
  dir="$(mktemp -d "$PARALLEL_TMP/steps.XXXXXX")"
  local pids=()
  local i=0
  local name
  for name in "${names[@]}"; do
    (step_body "$name") >"$dir/$i.out" 2>&1 &
    pids+=($!)
    i=$((i + 1))
  done
  local statuses=()
  local pid
  for pid in "${pids[@]}"; do
    local status=0
    wait "$pid" || status=$?
    statuses+=($status)
  done
  local failed=""
  local failed_status=0
  i=0
  for name in "${names[@]}"; do
    ((GROUPS_ON)) && printf '::group::%s\n' "$name"
    printf '\n[verify] ==> %s\n' "$name"
    cat "$dir/$i.out"
    ((GROUPS_ON)) && printf '::endgroup::\n'
    STEPS+=("$(printf '%4ss  %s' $((SECONDS - t0)) "$name")")
    if [[ "${statuses[$i]}" != "0" && -z "$failed" ]]; then
      failed="$name"
      failed_status="${statuses[$i]}"
    fi
    i=$((i + 1))
  done
  if [[ -n "$failed" ]]; then
    current="$failed"
    return "$failed_status"
  fi
  current=""
}

run_full() {
  local window_e2e="${OVERNOTE_WINDOW_E2E:-0}"
  local name
  for name in "${ALL_STEPS[@]}"; do
    if [[ "$name" == "End to end: panel window" ]]; then
      if [[ "$window_e2e" == "1" ]]; then
        step "$name"
      else
        printf '\n[verify] skipped: End to end: panel window (shows the panel; set OVERNOTE_WINDOW_E2E=1 to run it)\n'
        STEPS+=("   -   End to end: panel window (skipped)")
      fi
    else
      step "$name"
    fi
  done
}

run_fast() {
  printf '\n[verify] mode: fast (a strict subset of the full gate)\n'
  local i=0
  local name
  while [[ $i -lt ${#FAST_STEPS[@]} ]]; do
    name="${FAST_STEPS[$i]}"
    case "$name" in
      Typecheck:* | Lint:*)
        # A run of checks sharing a prefix (all typechecks, then all lints) runs together.
        local prefix="${name%%:*}"
        local group=()
        while [[ $i -lt ${#FAST_STEPS[@]} && "${FAST_STEPS[$i]}" == "$prefix:"* ]]; do
          group+=("${FAST_STEPS[$i]}")
          i=$((i + 1))
        done
        if [[ ${#group[@]} -gt 1 ]]; then
          step_parallel "${group[@]}"
        else
          step "${group[0]}"
        fi
        ;;
      *)
        step "$name"
        i=$((i + 1))
        ;;
    esac
  done
}

# The helper version constant is generated from helper/VERSION. Generate it up front so
# the helper unit tests in fast mode, which run no build step first, can compile.
if [[ -f helper/VERSION && -d helper/Sources/OvernoteCore ]]; then
  bash scripts/generate-helper-version.sh
fi

if [[ "$VERIFY_MODE" == "fast" ]]; then
  run_fast
else
  run_full
fi
current=""

printf '\n[verify] all steps passed in %ss\n' $((SECONDS - started))
printf '[verify] %s\n' "${STEPS[@]}"

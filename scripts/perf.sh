#!/bin/bash
# Perf harness: deterministic fixtures, the real helper headless, socket timings.
#
# Usage:
#   bash scripts/perf.sh [--scales 100,1000,10000] [--large 1024,51200,512000]
#                        [--helper assets/bin/OvernoteHelper] [--strict]
#                        [--out scripts/perf/results] [--keep-fixtures]
#
# Every run writes one JSON file per scale plus a combined summary into the out folder.
# Budgets warn by default: a WARN or FAIL comparison still exits 0 unless --strict is given.
# This script is not wired into verify or CI.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/assets/bin/OvernoteHelper"
SCALES="100,1000,10000"
LARGE="1024,51200,512000"
OUT="$ROOT/scripts/perf/results"
STRICT=""
KEEP_FIXTURES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scales) SCALES="$2"; shift 2 ;;
    --large) LARGE="$2"; shift 2 ;;
    --helper) HELPER="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --strict) STRICT="--strict"; shift ;;
    --keep-fixtures) KEEP_FIXTURES=1; shift ;;
    *) echo "perf: unknown argument $1" >&2; exit 64 ;;
  esac
done

[[ -x "$HELPER" ]] || { echo "perf: helper not executable: $HELPER (build it first, or pass --helper)" >&2; exit 1; }
command -v node >/dev/null || { echo "perf: node is required" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "perf: sqlite3 is required for fixture generation" >&2; exit 1; }

mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d /tmp/overnote-perf-run.XXXXXX)"
cleanup() { [[ "$KEEP_FIXTURES" == "1" ]] || rm -rf "$WORK"; [[ "$KEEP_FIXTURES" == "1" ]] && echo "[perf] kept fixtures in $WORK" >&2; }
trap cleanup EXIT

SUMMARY="$OUT/perf-$STAMP-summary.json"
RESULT_FILES=()
OVERALL=0

run_one() {
  local label="$1"; shift
  local fixture="$WORK/fixture-$label"
  node "$ROOT/scripts/perf/generate-fixture.mjs" --out "$fixture" "$@" >&2 || { OVERALL=1; return; }
  local result="$OUT/perf-$STAMP-$label.json"
  if node "$ROOT/scripts/perf/driver.mjs" --fixture "$fixture" --helper "$HELPER" --label "$label" \
      --budgets "$ROOT/scripts/perf/budgets.json" $STRICT > "$result"; then
    echo "[perf] $label done: $result" >&2
  else
    # In strict mode a FAIL budget comparison lands here too. Keep the JSON either way.
    echo "[perf] $label driver exited nonzero (see $result and stderr above)" >&2
    [[ -n "$STRICT" ]] && OVERALL=1
    [[ -s "$result" ]] || rm -f "$result"
    return
  fi
  [[ -s "$result" ]] && RESULT_FILES+=("$result")
}

IFS=',' read -ra SCALE_LIST <<< "$SCALES"
for scale in "${SCALE_LIST[@]}"; do
  [[ -n "$scale" ]] && run_one "$scale" --notes "$scale"
done

if [[ -n "$LARGE" ]]; then
  IFS=',' read -ra LARGE_LIST <<< "$LARGE"
  for bytes in "${LARGE_LIST[@]}"; do
    [[ -n "$bytes" ]] && run_one "large-$bytes" --bytes "$bytes"
  done
fi

# Core serializer bench at the same large sizes. A skip (no esbuild yet) is not a failure.
if [[ -n "$LARGE" ]]; then
  SERIALIZER_OUT="$OUT/perf-$STAMP-serializer.json"
  if node "$ROOT/scripts/perf/serializer-bench.mjs" --sizes "$LARGE" > "$SERIALIZER_OUT" 2>/tmp/overnote-serializer-bench.log; then
    echo "[perf] serializer bench: $SERIALIZER_OUT" >&2
    RESULT_FILES+=("$SERIALIZER_OUT")
  else
    echo "[perf] serializer bench failed (see /tmp/overnote-serializer-bench.log); continuing" >&2
    rm -f "$SERIALIZER_OUT"
  fi
fi

RESULT_FILES_JSON="${RESULT_FILES[*]:-}" STAMP="$STAMP" node -e '
  const fs = require("node:fs");
  const files = (process.env.RESULT_FILES_JSON || "").split(" ").filter(Boolean);
  const runs = files.map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }).filter(Boolean);
  const summary = {
    stamp: process.env.STAMP,
    runs: runs.map((r) => r.kind === "serializer"
      ? { label: "serializer", results: r.results }
      : { label: r.label, helperVersion: r.helper.version, helperSha256: r.helper.sha256, fixture: r.fixture, budgetVerdict: r.budgetVerdict ?? null, ops: r.ops }),
    files,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
' > "$SUMMARY"

echo "[perf] summary: $SUMMARY" >&2
echo "[perf] helper measured: $HELPER" >&2
exit "$OVERALL"

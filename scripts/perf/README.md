# Perf harness

This folder holds a measurement harness for the real helper binary.
It is not wired into `npm run verify` or CI.
Budgets warn by default on a local run.

## What it measures

The driver (`driver.mjs`) starts the helper with `--headless --test-hooks` against a copied fixture database.
It times startup to the first `system.ping`, browse, filtered browse, list, filtered list, list paging per page and as a full walk, count, single note reads, create, a debounced style save, and the deleted list over the socket protocol in `docs/architecture.md`.
The debounced save waits 300 ms before its `notes.update`, matching `SAVE_DEBOUNCE_MS` in `editor/src/session/session.ts`.
The results report the socket round trip and the debounce inclusive wall time separately.
Large fixtures also time reading and updating the large note itself.
The driver also checks what it times: the helper's count matches the fixture, a paging walk sees every note once, and a filtered browse puts a title match first.

The concurrent probe (`concurrent-probe.mjs`) keeps a second socket connection busy with short folded term scans and paging walks, and times 20 saves on the first connection while those reads run.
It reports the baseline save, the concurrent save, the reads completed, and the read latency as JSON, which shows whether a save waits behind a long read.
`perf.sh` runs it once against the largest note count fixture.
To run it alone, generate a fixture and point the probe at it:

```sh
node scripts/perf/generate-fixture.mjs --notes 10000 --out /tmp/overnote-fixture
node scripts/perf/concurrent-probe.mjs --fixture /tmp/overnote-fixture --helper assets/bin/OvernoteHelper
```

The serializer bench (`serializer-bench.mjs`) times the `@overnote/core` serializers on large documents, bundled with the esbuild binary already in `node_modules`.

## Fixtures

The generator (`generate-fixture.mjs`) builds databases of 100, 1,000, and 10,000 notes, plus single notes of about 1 KB, 50 KB, and 500 KB.
No larger fixture is generated.
Every fixture uses one fixed seed, so timestamps, ids, titles, and bodies are identical on every run.
Sparse needle words and diacritic titles sit at known positions, so a filtered search has a truthful target.
Fixtures are at schema version 2: the generated sort columns, the paging indexes, the FTS5 trigram table, and its triggers, as `docs/architecture.md` section 6 states them.
A helper that only knows schema version 1 refuses them, by design.
The driver copies the fixture into a temporary support folder before the helper starts, so creates and saves during a run never change the fixture.
`OVERNOTE_BACKUP_DIR` always points inside that temporary folder.

## Usage

Build the helper first (`bash scripts/build-helper.sh`), then run every scale with `bash scripts/perf.sh`.
Run a subset with `bash scripts/perf.sh --scales 100,1000 --large 1024`.
Pass `--no-probe` to skip the concurrent probe.
Pass `--strict` when a budget failure should change the exit code.
Pass `--helper <path>` to measure a different already built binary.
Results land as one JSON file per scale, the probe result, the serializer result, and a combined summary in `scripts/perf/results/`, which git ignores.
Regenerate results on the branch you measure, and never commit them.

## Budgets

`budgets.json` holds a median and a p95 budget per operation and scale, with `default` for scales that name none.
A result over budget prints WARN.
A result over budget times `failMultiplier` prints FAIL.
Either outcome still exits 0 without `--strict`; with it, a FAIL exits 1.
A harness or helper failure exits nonzero in every mode.
Read the JSON results for the full distribution, because the console lines only compare median and p95 against budget.

## What this does not measure

This harness never shows the panel.
Hotkey to caret timing needs the window suite, which runs in CI only and is never measured locally.
The design for that collection lives in `hotkey-caret.md` in this folder.
The concurrent probe has no budget: it reports, and the reader judges.

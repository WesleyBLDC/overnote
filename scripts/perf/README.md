# Perf harness

This folder holds a measurement harness for the real helper binary.
It is not wired into `verify` or CI.
Budgets warn by default on a local run.

## What it measures

The driver starts the helper with `--headless --test-hooks` against a copied fixture database.
It times startup to the first `system.ping`, browse, filtered browse, list, filtered list, list paging, count, single note reads, create, and a debounced style save over the socket protocol in `docs/architecture.md`.
The debounced save waits 300 ms before its `notes.update`, matching `SAVE_DEBOUNCE_MS` in `editor/src/session/session.ts`.
The results report the socket round trip and the debounce inclusive wall time separately.
Large fixtures also time reading and updating the large note itself.

## Fixtures

The generator builds databases of 100, 1000, and 10000 notes, plus single notes of roughly 1 KB, 50 KB, and 500 KB.
Every fixture uses one fixed seed, so timestamps, ids, titles, and bodies are identical on every run.
Sparse needle words and diacritic titles sit at known positions, so a filtered search has a truthful target.
The driver copies the fixture into a temporary support folder before the helper starts.
Creates and saves during a run therefore never change the fixture.
`OVERNOTE_BACKUP_DIR` always points inside that temporary folder.

## Usage

Run every scale with `bash scripts/perf.sh`.
Run a subset with `bash scripts/perf.sh --scales 100,1000 --large 1024`.
Pass `--strict` when a budget failure should change the exit code.
Pass `--helper <path>` to measure a different already built binary.
Results land as one JSON file per scale plus a combined summary in `scripts/perf/results/`.

## Budgets

`budgets.json` holds a median and a p95 budget per operation and scale.
A result over budget prints WARN.
A result over budget times `failMultiplier` prints FAIL.
Either outcome still exits 0 without `--strict`.
Read the JSON results for the full distribution, because the console lines only compare median and p95 against budget.

## What this does not measure

This harness never shows the panel.
Hotkey to caret timing needs the window suite, which runs in CI only.
The exact design for that collection lives in `hotkey-caret.md` in this folder.

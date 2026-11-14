---
name: ui-change
description: Change the Overnote editor or panel UI and prove it visually. Use for any styling, layout, toolbar, ⌘K, theme, or icon change in editor/ or the helper's window chrome.
---

# UI change

1. Run the browser harness: `npm run dev -w editor -- --port 5299 --strictPort --host 127.0.0.1`, save its PID, and stop only that process.
   Never drive the Raycast GUI or show the helper panel on screen; `scripts/e2e-window.sh` runs only when the maintainer asks.
2. Colours and type come only from the Graphite tokens in `editor/src/styles/theme.css`.
   No hex values in components, and no new token names without a reason in the PR.
   Text keeps 4.5:1 contrast on its surface in both modes.
3. Icons: 17 pt on a 24 grid, stroke 1.6, round caps and joins, in `editor/src/ui/icons.tsx`.
4. Check dark and light at 2x with Playwright WebKit, and look at every screenshot yourself before claiming the change works.
5. Update the visual baselines for `editor/tests/visual.spec.ts` (run only that spec with `--update-snapshots`), and refresh README shots with `npm run shots:readme` when the README shows the changed chrome.
   Never copy Playwright baselines into `media/`.
6. Keep anything the change displaces reachable from ⌘K, and say in the PR what moved.
7. Finish with the `ship-feature` skill.

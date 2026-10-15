# Clean-room process

Overnote reproduces the behavior of Raycast Notes without copying its code.
It is inspired by Raycast Notes and is not affiliated with Raycast.

## Two teams

**Spec team**
- Studied how Raycast Notes behaves, through its public documentation, hands-on use, and static study of the shipped app.
- Wrote the behavior specs in `spec/` in plain language: behavior, data shapes, keyboard maps, and measurements.
  The specs contain no code, no internal identifiers, and no copied styling.
- A separate reviewer checked every spec for leaked implementation detail before it was accepted.
- Spec-team working notes are kept privately by the maintainer and are not part of this repository.

**Build team**
- Implements Overnote only from `PLAN.md`, `docs/`, `spec/`, the public research notes in `research/`, and public library documentation (Tiptap, ProseMirror, AppKit, the Raycast extension API).
- Never reads reverse-engineering output or the Raycast app bundle.
- Questions about behavior go back to the spec team, who answer by updating `spec/`.

## Always

- Never decrypt or read Raycast's databases or keys.
- Never use the Raycast name, icon, colors, or branding in the product.
- Overnote has its own visual design; it matches Raycast Notes in behavior and layout only.

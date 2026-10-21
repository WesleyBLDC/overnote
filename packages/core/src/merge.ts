/**
 * Three-way merge of note documents by top-level block (one list item is one block), for when
 * the editor's unsaved edits meet a newer stored version that another writer saved.
 */
import type { JSONContent } from "@tiptap/core";
import { emptyDoc, normalizeDoc } from "./load";

export interface DocMerge {
  /** The merged document: every block either side added or changed is in it. */
  doc: JSONContent;
  /**
   * Both sides changed the same blocks into different, non-empty versions, so both were kept, local
   * first. An edit against a delete keeps the edit and is not a conflict: only one version exists.
   */
  conflicted: boolean;
  /** The merged document is exactly `remote`, so there is nothing left to save. */
  matchesRemote: boolean;
}

/** Past this many compared block pairs, a changed middle counts as one replaced range. */
const MAX_LCS_CELLS = 4_000_000;

type Side = "local" | "remote";

/** One side replaced base blocks [start, end) with `blocks`; start === end is an insertion. */
interface Hunk {
  side: Side;
  start: number;
  end: number;
  blocks: JSONContent[];
}

function blocksOf(doc: JSONContent): JSONContent[] {
  return normalizeDoc(doc).content ?? [];
}

function keysOf(blocks: JSONContent[]): string[] {
  return blocks.map((block) => JSON.stringify(block));
}

/** Pairs of equal block indices [base, other], in order, from a longest common subsequence. */
function matches(base: string[], other: string[]): [number, number][] {
  let head = 0;
  while (head < base.length && head < other.length && base[head] === other[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < other.length - head &&
    base[base.length - 1 - tail] === other[other.length - 1 - tail]
  ) {
    tail++;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);
  const n = base.length - head - tail;
  const m = other.length - head - tail;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
    // lengths[i * (m + 1) + j] is the LCS length of base[head + i..] and other[head + j..].
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i * width + j] =
          base[head + i] === other[head + j]
            ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (base[head + i] === other[head + j]) {
        pairs.push([head + i, head + j]);
        i++;
        j++;
      } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let k = tail; k > 0; k--) pairs.push([base.length - k, other.length - k]);
  return pairs;
}

/** The changes that turn `base` into `other`, as hunks over base indices. */
function hunks(side: Side, base: string[], other: string[], otherBlocks: JSONContent[]): Hunk[] {
  const out: Hunk[] = [];
  let b = 0;
  let o = 0;
  for (const [mb, mo] of [...matches(base, other), [base.length, other.length] as [number, number]]) {
    if (mb > b || mo > o) out.push({ side, start: b, end: mb, blocks: otherBlocks.slice(o, mo) });
    b = mb + 1;
    o = mo + 1;
  }
  return out;
}

/**
 * Whether hunk `h` touches the range [start, end): the ranges overlap, an insertion lands strictly
 * inside the other range, or both are insertions at the same place (their order is unknown).
 */
function touches(start: number, end: number, h: Hunk): boolean {
  if (h.start < end && start < h.end) return true;
  return start === end && h.start === h.end && h.start === start;
}

/** Base blocks [start, end) with one side's hunks (all inside the range, in order) applied. */
function applyHunks(base: JSONContent[], start: number, end: number, side: Hunk[]): JSONContent[] {
  const out: JSONContent[] = [];
  let at = start;
  for (const hunk of side) {
    out.push(...base.slice(at, hunk.start), ...hunk.blocks);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

/**
 * Merges `local` (the editor) and `remote` (the stored note) that both started from `base`.
 * Changes to different blocks all apply; where both sides changed the same blocks differently,
 * the local version comes first and the remote version right after it, so nothing is lost. Where
 * one side deleted blocks the other changed (or inserted into), the changed version wins.
 */
export function mergeDocs(base: JSONContent, local: JSONContent, remote: JSONContent): DocMerge {
  const baseBlocks = blocksOf(base);
  const localBlocks = blocksOf(local);
  const remoteBlocks = blocksOf(remote);
  const baseKeys = keysOf(baseBlocks);
  const remoteKeys = keysOf(remoteBlocks);
  const all = [
    ...hunks("local", baseKeys, keysOf(localBlocks), localBlocks),
    ...hunks("remote", baseKeys, remoteKeys, remoteBlocks),
  ].sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));

  const merged: JSONContent[] = [];
  let conflicted = false;
  let at = 0;
  let index = 0;
  while (index < all.length) {
    const first = all[index] as Hunk;
    const group = [first];
    let start = first.start;
    let end = first.end;
    for (index++; index < all.length && touches(start, end, all[index] as Hunk); index++) {
      const next = all[index] as Hunk;
      group.push(next);
      start = Math.min(start, next.start);
      end = Math.max(end, next.end);
    }
    merged.push(...baseBlocks.slice(at, start));
    at = end;
    const ours = group.filter((h) => h.side === "local");
    const theirs = group.filter((h) => h.side === "remote");
    const localVersion = applyHunks(baseBlocks, start, end, ours);
    if (!theirs.length) {
      merged.push(...localVersion);
      continue;
    }
    const remoteVersion = applyHunks(baseBlocks, start, end, theirs);
    if (!ours.length || keysOf(localVersion).join("\n") === keysOf(remoteVersion).join("\n")) {
      merged.push(...remoteVersion);
      continue;
    }
    // One side deleted what the other changed: the change wins, and there is only one version.
    if (localVersion.length && remoteVersion.length) conflicted = true;
    merged.push(...localVersion, ...remoteVersion);
  }
  merged.push(...baseBlocks.slice(at));

  const doc: JSONContent = merged.length ? { type: "doc", content: merged } : emptyDoc();
  const matchesRemote = keysOf(doc.content ?? []).join("\n") === remoteKeys.join("\n");
  return { doc, conflicted, matchesRemote };
}

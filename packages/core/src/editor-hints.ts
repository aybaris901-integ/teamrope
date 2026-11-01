// What the editor shows over a file: one hint per spot where teammates changed
// the same lines as me. Plain data from overlapsWithMe; no Git here.
import type { FileOverlap, LineRange, OverlapWithMe } from "./overlaps.js";

export interface OverlapHint {
  /** Lines in my working-tree file (1-based, inclusive). */
  range: LineRange;
  /** Teammates who changed these lines, each once. */
  names: string[];
  /** Oldest commit involved. */
  since: Date;
  /** The first teammate's overlap, for Compare / Copy message. */
  overlap: OverlapWithMe;
  file: FileOverlap;
}

/** Who to name for a file: the commit authors on their branch, else the branch owner. */
export function overlapNames(overlap: OverlapWithMe, file: FileOverlap): string[] {
  return file.authors.length > 0 ? file.authors : [overlap.owner];
}

/**
 * Hints for one file (path relative to the repo root). Ranges that touch or
 * intersect are merged, so each spot gets one hint even when several
 * teammates changed it.
 */
export function overlapHints(overlaps: OverlapWithMe[], filePath: string): OverlapHint[] {
  const spots = overlaps.flatMap((overlap) =>
    overlap.files
      .filter((file) => file.path === filePath)
      .flatMap((file) => file.ranges.map((r) => ({ range: r.mine, overlap, file }))),
  );
  spots.sort((a, b) => a.range.start - b.range.start);

  const hints: OverlapHint[] = [];
  for (const spot of spots) {
    const last = hints.at(-1);
    const names = overlapNames(spot.overlap, spot.file);
    if (last && spot.range.start <= last.range.end + 1) {
      last.range = { start: last.range.start, end: Math.max(last.range.end, spot.range.end) };
      last.names = [...new Set([...last.names, ...names])];
      if (spot.file.since < last.since) last.since = spot.file.since;
      continue;
    }
    hints.push({ range: { ...spot.range }, names, since: spot.file.since, overlap: spot.overlap, file: spot.file });
  }
  return hints;
}

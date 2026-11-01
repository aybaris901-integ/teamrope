import { describe, expect, test } from "vitest";
import { overlapHints } from "./editor-hints.js";
import { conflictLineHint, conflictNotice, overlapHintTitle } from "./explain.js";
import type { FileOverlap, OverlapWithMe } from "./overlaps.js";

const file = (path: string, mine: Array<[number, number]>, authors: string[], since: string): FileOverlap => ({
  path,
  ranges: mine.map(([start, end]) => ({ mine: { start, end }, theirs: { start, end } })),
  authors,
  since: new Date(since),
});
const overlap = (owner: string, files: FileOverlap[]): OverlapWithMe => ({ branch: `${owner}/feature`, owner, files });

describe("overlapHints", () => {
  test("one hint per spot: touching ranges from two teammates merge, names once, oldest time", () => {
    const alice = overlap("alice", [file("src/app.js", [[2, 3], [10, 10]], ["alice"], "2026-11-01T10:00:00Z")]);
    const frank = overlap("frank", [file("src/app.js", [[4, 4]], [], "2026-11-01T09:00:00Z")]);
    const other = overlap("olive", [file("src/other.js", [[2, 3]], ["olive"], "2026-11-01T08:00:00Z")]);
    const hints = overlapHints([alice, frank, other], "src/app.js");
    expect(hints.map((h) => [h.range, h.names, h.since.toISOString(), h.overlap.owner])).toEqual([
      [{ start: 2, end: 4 }, ["alice", "frank"], "2026-11-01T09:00:00.000Z", "alice"],
      [{ start: 10, end: 10 }, ["alice"], "2026-11-01T10:00:00.000Z", "alice"],
    ]);
  });

  test("a file overlap without line ranges gives no hint", () => {
    expect(overlapHints([overlap("alice", [file("logo.png", [], ["alice"], "2026-11-01T10:00:00Z")])], "logo.png")).toEqual([]);
  });
});

describe("editor hint texts", () => {
  const conflict = {
    path: "src/config.js",
    authors: ["alice"],
    hunks: [{ yours: ["  retries: 3,"], theirs: ["", "  apiUrl: 'https://api.example.com',"] }],
    since: new Date("2026-11-01T10:00:00Z"),
    commits: { mine: "a", main: "b" },
  };
  test("CodeLens title names everyone once with an age", () => {
    const [hint] = overlapHints(
      [overlap("alice", [file("src/app.js", [[2, 2]], ["alice"], "2026-11-01T10:00:00Z")])],
      "src/app.js",
    );
    expect(hint && overlapHintTitle(hint, new Date("2026-11-01T10:20:00Z"))).toBe("alice also changed this · ~20m");
  });
  test("conflict notification and line hint", () => {
    expect(conflictNotice(conflict)).toBe(
      "Syncing would conflict in src/config.js (alice). Talk before your work goes into main.",
    );
    expect(conflictLineHint(conflict, conflict.hunks[0]!)).toBe("alice: apiUrl: 'https://api.example.com',");
    expect(conflictLineHint({ ...conflict, authors: [] }, { yours: ["x"], theirs: [] })).toBe("Removed on main");
  });
});

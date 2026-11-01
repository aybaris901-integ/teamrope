import { describe, expect, test } from "vitest";
import type { Diagnosis } from "./diagnose.js";
import {
  ago,
  approxAge,
  explainDiagnosis,
  explainMyProblem,
  explainSyncRefusal,
  headline,
  overlapMessage,
  problemMessage,
  shortDuration,
  shortProblemLabel,
} from "./explain.js";
import type { MyProblem } from "./my-problems.js";
import type { OverlapWithMe } from "./overlaps.js";
import type { SyncPlan } from "./sync.js";

const base: Diagnosis = {
  gitVersion: "2.56.0",
  supportsMergeTree: true,
  currentBranch: "carol/feature",
  onMain: false,
  detached: false,
  inProgress: null,
  dirtyFiles: [],
  conflictedFiles: [],
  aheadOfUpstream: 0,
  behindUpstream: 0,
  behindMain: 0,
  unpushedCommitsOnMain: 0,
  canReachRemote: true,
  remoteProblem: null,
  nextAction: null,
};

const BUTTON_ADVICE = /Start task|Start a task|Save will|Sync will/;

describe("explainDiagnosis", () => {
  test("mid-rebase (detached HEAD) leads with the rebase and names no branch", () => {
    const { summary, next } = explainDiagnosis({
      ...base,
      currentBranch: null,
      detached: true,
      inProgress: "rebase",
      nextAction: "finishOperation",
    });
    const text = summary.join(" ");
    expect(text).toMatch(/^You're in the middle of a rebase/);
    expect(text).toContain("I won't change anything until it's done.");
    expect(text).not.toContain("null");
    expect(text).not.toContain("detached HEAD");
    expect(next).toBe("Next: finish or cancel the rebase (ask your captain if you're stuck)");
  });

  test("the summary never gives button advice; next is the only suggestion", () => {
    const { summary, next } = explainDiagnosis({
      ...base,
      currentBranch: "main",
      onMain: true,
      dirtyFiles: ["src/app.js"],
      behindMain: 2,
      unpushedCommitsOnMain: 1,
      aheadOfUpstream: null,
      nextAction: "startTask",
    });
    expect(summary.join(" ")).not.toMatch(BUTTON_ADVICE);
    expect(next).toBe("Next: Start task");
  });

  test("access advice only when fixing access is the next step", () => {
    const remoteProblem = { kind: "network", detail: "Connection refused" } as const;
    const fixAccess = explainDiagnosis({
      ...base,
      canReachRemote: false,
      remoteProblem,
      nextAction: "fixAccess",
    });
    expect(fixAccess.summary.join(" ")).toContain("Check your internet connection");
    expect(fixAccess.next).toBe("Next: fix access to the team repo (see above)");

    const midMerge = explainDiagnosis({
      ...base,
      inProgress: "merge",
      canReachRemote: false,
      remoteProblem,
      nextAction: "finishOperation",
    });
    expect(midMerge.summary.join(" ")).not.toContain("Check your internet connection");
  });

  test("unreachable remote: nothing about being behind or up to date with main", () => {
    const remoteProblem = { kind: "timeout", detail: "No answer" } as const;
    for (const behindMain of [0, 2, null]) {
      const { summary } = explainDiagnosis({
        ...base,
        behindMain,
        canReachRemote: false,
        remoteProblem,
        nextAction: "fixAccess",
      });
      expect(summary.join(" ")).not.toMatch(/up to date with main|new commit|compare with/);
    }
  });

  test("mid-merge: names conflicted files and skips 'up to date with main'", () => {
    const { summary } = explainDiagnosis({
      ...base,
      inProgress: "merge",
      dirtyFiles: ["src/app.js", "README.md"],
      conflictedFiles: ["src/app.js"],
      nextAction: "finishOperation",
    });
    const text = summary.join(" ");
    expect(text).toContain("You have 1 file with conflicts: src/app.js.");
    expect(text).toContain("You also have 1 other changed file: README.md.");
    expect(text).not.toContain("unsaved");
    expect(text).not.toContain("up to date with main");
  });

  test("detached HEAD: ask the captain, with the rescue command for the captain", () => {
    const { summary, next } = explainDiagnosis({
      ...base,
      currentBranch: null,
      detached: true,
      dirtyFiles: ["src/app.js"],
      nextAction: "askCaptain",
    });
    expect(summary.join(" ")).toContain("detached HEAD");
    expect(next).toMatch(/^Next: ask your captain/);
    expect(next).toMatch(
      /If you're the captain: `git switch -c rescue\/<name>` keeps everything you have\.$/,
    );
  });

  test("nothing to do", () => {
    expect(explainDiagnosis(base).next).toBe("Nothing to do, keep coding.");
  });
});

describe("explainSyncRefusal with conflicts", () => {
  const hunk = (n: number) => ({ yours: [`mine ${n}`], theirs: [`main ${n}`] });
  const plan = {
    mainBranch: "main",
    upToDate: false,
    conflicts: [
      { path: "src/app.js", authors: ["alice", "bob"], hunks: [1, 2, 3, 4, 5].map(hunk) },
      {
        path: "src/long.js",
        authors: [],
        hunks: [{ yours: Array.from({ length: 9 }, (_, i) => `line ${i}`), theirs: [] }],
      },
    ],
  } as unknown as SyncPlan; // only the fields the explanation reads

  test("at most 3 hunks per file, then 'and N more'", () => {
    const text = explainSyncRefusal(plan);
    expect(text.filter((line) => line === "  Your version:")).toHaveLength(4);
    expect(text).toContain("    mine 3");
    expect(text).not.toContain("    mine 4");
    expect(text).toContain("  and 2 more");
    expect(text).toContain("  alice and bob's version on main:");
  });

  test("long and empty sides are shortened and labeled", () => {
    const text = explainSyncRefusal(plan);
    expect(text).toContain("    … and 3 more lines");
    expect(text).toContain("  The version on main:");
    expect(text).toContain("    (nothing: these lines were removed)");
    expect(text.at(-1)).toBe(
      "Next: agree with alice and bob on one version, edit your files to match it exactly, share your changes, then Sync.",
    );
  });
});

describe("panel text", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const overlap: OverlapWithMe = {
    branch: "alice/feature",
    owner: "alice",
    files: [
      {
        path: "src/app.js",
        ranges: [{ mine: { start: 2, end: 3 }, theirs: { start: 2, end: 2 } }],
        authors: ["alice"],
        since: minutesAgo(20),
      },
    ],
  };
  const overlapProblem: MyProblem = { kind: "overlapWithMe", overlap, file: overlap.files[0]! };

  test.each([
    [30_000, "<1m"],
    [15 * 60_000, "15m"],
    [2 * 60 * 60_000, "2h"],
    [50 * 60 * 60_000, "2d"],
  ])("shortDuration(%d) = %s", (ms, text) => {
    expect(shortDuration(ms)).toBe(text);
  });

  test("under a minute is 'just now', never '~<1m'", () => {
    expect(approxAge(new Date(now.getTime() - 30_000), now)).toBe("just now");
    expect(approxAge(minutesAgo(20), now)).toBe("~20m");
    expect(ago(new Date(now.getTime() - 5_000), now)).toBe("just now");
    expect(ago(minutesAgo(5), now)).toBe("5m ago");
    const fresh = { ...overlapProblem, file: { ...overlap.files[0]!, since: new Date(now.getTime() - 10_000) } } as MyProblem;
    expect(explainMyProblem(fresh, now)).toBe("alice also changed src/app.js (lines 2–3) · just now");
  });

  test("overlap line and ready message", () => {
    expect(explainMyProblem(overlapProblem, now)).toBe("alice also changed src/app.js (lines 2–3) · ~20m");
    expect(overlapMessage(overlap, overlap.files[0]!, "carol/feature")).toBe(
      "Hi alice, I'm also changing src/app.js (lines 2–3) on carol/feature, and you changed it on alice/feature. Can we agree who keeps what before either of us merges?",
    );
  });

  test("headline explains the primary button, then the problem about me", () => {
    const conflict: MyProblem = {
      kind: "mainConflict",
      conflict: { path: "src/config.js", authors: ["alice"], hunks: [], since: minutesAgo(60) },
    };
    const shareNext = { ...base, dirtyFiles: ["src/app.js"], nextAction: "save" as const };
    expect(headline(shareNext, [overlapProblem])).toEqual({
      severity: "warning",
      sentence: "You have 1 file not shared. alice changed the same lines — talk before merging.",
    });
    expect(headline({ ...base, behindMain: 1, nextAction: "sync" }, [conflict])).toEqual({
      severity: "error",
      sentence: "Main has 1 new commit for you. src/config.js would conflict with main — talk to alice before syncing.",
    });
    expect(headline({ ...base, onMain: true, dirtyFiles: ["a.js"], nextAction: "startTask" }, [])).toEqual({
      severity: "info",
      sentence: "You're on main with 1 file not shared.",
    });
    expect(headline(shareNext, [])).toEqual({ severity: "info", sentence: "You have 1 file not shared." });
    expect(headline(base, [])).toEqual({ severity: "ok", sentence: "You're in sync." });
  });

  test("headline says 'the same line' for a single-line overlap", () => {
    const oneLine: MyProblem = {
      ...overlapProblem,
      file: { ...overlap.files[0]!, ranges: [{ mine: { start: 2, end: 2 }, theirs: { start: 2, end: 2 } }] },
    } as MyProblem;
    expect(headline({ ...base, dirtyFiles: ["src/app.js"], nextAction: "save" }, [oneLine]).sentence).toBe(
      "You have 1 file not shared. alice changed the same line — talk before merging.",
    );
  });

  test("short labels fit a narrow sidebar", () => {
    const team = (problem: Extract<MyProblem, { kind: "team" }>["problem"]): MyProblem => ({ kind: "team", problem });
    expect(shortProblemLabel(team({ kind: "conflictWithMain", branch: "hank/feature", owner: "hank", conflicts: [] }))).toBe(
      "hank: conflict with main",
    );
    expect(
      shortProblemLabel(
        team({ kind: "overlap", overlap: { branches: ["alice/feature", "frank/feature"], owners: ["alice", "frank"], files: ["src/app.js"] } }),
      ),
    ).toBe("alice + frank: same code in app.js");
    expect(shortProblemLabel(team({ kind: "farBehind", branch: "olive/idea", owner: "olive", behind: 6 }))).toBe(
      "olive: 6 behind main",
    );
    expect(shortProblemLabel(overlapProblem)).toBe("alice + you: same code in app.js");
  });

  test("messages for team problems address the owner without pronouns", () => {
    const text = problemMessage(
      { kind: "team", problem: { kind: "farBehind", branch: "olive/idea", owner: "olive", behind: 6 } },
      "carol/feature",
    );
    expect(text).toBe(
      "Hi olive, olive/idea is 6 commits behind main. Could you Sync soon, while it's still easy?",
    );
  });
});

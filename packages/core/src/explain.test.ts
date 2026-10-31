import { describe, expect, test } from "vitest";
import type { Diagnosis } from "./diagnose.js";
import { explainDiagnosis } from "./explain.js";

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

  test("nothing to do", () => {
    expect(explainDiagnosis(base).next).toBe("Nothing to do, keep coding.");
  });
});

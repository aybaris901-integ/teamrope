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
  aheadOfUpstream: 0,
  behindUpstream: 0,
  behindMain: 0,
  unpushedCommitsOnMain: 0,
  canReachRemote: true,
  remoteProblem: null,
};

describe("explainDiagnosis", () => {
  test("mid-rebase (detached HEAD) leads with the rebase and names no branch", () => {
    const text = explainDiagnosis({
      ...base,
      currentBranch: null,
      detached: true,
      inProgress: "rebase",
    }).join(" ");
    expect(text).toMatch(/^You're in the middle of a rebase/);
    expect(text).toContain("I won't change anything until it's done.");
    expect(text).not.toContain("null");
    expect(text).not.toContain("detached HEAD");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { diagnose, pickNextAction, type Diagnosis } from "./diagnose.js";
import { NotAGitRepoError } from "./git.js";

const PLAYGROUND = fileURLToPath(new URL("../../../playground", import.meta.url));
const clone = (name: string): string => path.join(PLAYGROUND, name);

describe("diagnose", () => {
  test("alice: own branch, clean, up to date with main", async () => {
    const d = await diagnose(clone("alice"));
    expect(d.currentBranch).toBe("alice/feature");
    expect(d.onMain).toBe(false);
    expect(d.detached).toBe(false);
    expect(d.dirtyFiles).toEqual([]);
    expect(d.conflictedFiles).toEqual([]);
    expect(d.behindMain).toBe(0);
    expect(d.aheadOfUpstream).toBe(0);
    expect(d.behindUpstream).toBe(0);
    expect(d.canReachRemote).toBe(true);
    expect(d.remoteProblem).toBeNull();
    expect(d.supportsMergeTree).toBe(true);
    expect(d.inProgress).toBeNull();
    expect(d.nextAction).toBeNull();
  });

  test("bob: committed on main without pushing", async () => {
    const d = await diagnose(clone("bob"));
    expect(d.onMain).toBe(true);
    expect(d.currentBranch).toBe("main");
    expect(d.unpushedCommitsOnMain).toBe(1);
    expect(d.aheadOfUpstream).toBe(1);
    expect(d.nextAction).toBe("startTask");
  });

  test("carol: uncommitted change and behind main", async () => {
    const d = await diagnose(clone("carol"));
    expect(d.currentBranch).toBe("carol/feature");
    expect(d.dirtyFiles).toContain("src/app.js");
    expect(d.behindMain).toBe(1);
    expect(d.nextAction).toBe("save");
  });

  test("eve: remote unreachable, reported instead of thrown", async () => {
    const d = await diagnose(clone("eve"));
    expect(d.canReachRemote).toBe(false);
    expect(d.remoteProblem?.kind).toBe("notFoundOrNoAccess");
    expect(d.remoteProblem?.detail).toMatch(/missing-origin\.git/);
    expect(d.currentBranch).toBe("eve/feature");
    expect(d.nextAction).toBe("fixAccess");
  });

  test("frank: stuck in the middle of a merge with a conflict", async () => {
    const d = await diagnose(clone("frank"));
    expect(d.inProgress).toBe("merge");
    expect(d.nextAction).toBe("finishOperation");
    expect(d.currentBranch).toBe("frank/feature");
    expect(d.dirtyFiles).toContain("src/app.js");
    expect(d.conflictedFiles).toEqual(["src/app.js"]);
  });

  describe("outside a repo", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("throws a clear error for a folder that isn't a Git repo", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "branchguard-not-a-repo-"));
      await expect(diagnose(dir)).rejects.toThrow(NotAGitRepoError);
      await expect(diagnose(dir)).rejects.toThrow(/is not a Git repository/);
    });
  });
});

describe("pickNextAction", () => {
  const clean: Omit<Diagnosis, "nextAction"> = {
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
  };

  test("picks one action, most urgent first", () => {
    const everything = {
      ...clean,
      inProgress: "merge" as const,
      canReachRemote: false,
      onMain: true,
      dirtyFiles: ["a.js"],
      behindMain: 3,
    };
    expect(pickNextAction(everything)).toBe("finishOperation");
    expect(pickNextAction({ ...everything, inProgress: null })).toBe("fixAccess");
    expect(pickNextAction({ ...everything, inProgress: null, canReachRemote: true })).toBe(
      "startTask",
    );
    expect(pickNextAction({ ...clean, dirtyFiles: ["a.js"], behindMain: 3 })).toBe("save");
    expect(pickNextAction({ ...clean, behindMain: 3 })).toBe("sync");
    expect(pickNextAction(clean)).toBeNull();
  });
});

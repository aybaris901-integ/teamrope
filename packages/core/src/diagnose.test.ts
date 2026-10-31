import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { diagnose } from "./diagnose.js";
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
    expect(d.behindMain).toBe(0);
    expect(d.aheadOfUpstream).toBe(0);
    expect(d.behindUpstream).toBe(0);
    expect(d.canReachRemote).toBe(true);
    expect(d.remoteError).toBeNull();
    expect(d.supportsMergeTree).toBe(true);
  });

  test("bob: committed on main without pushing", async () => {
    const d = await diagnose(clone("bob"));
    expect(d.onMain).toBe(true);
    expect(d.currentBranch).toBe("main");
    expect(d.unpushedCommitsOnMain).toBe(1);
    expect(d.aheadOfUpstream).toBe(1);
  });

  test("carol: uncommitted change and behind main", async () => {
    const d = await diagnose(clone("carol"));
    expect(d.currentBranch).toBe("carol/feature");
    expect(d.dirtyFiles).toContain("src/app.js");
    expect(d.behindMain).toBe(1);
  });

  test("eve: remote unreachable, reported instead of thrown", async () => {
    const d = await diagnose(clone("eve"));
    expect(d.canReachRemote).toBe(false);
    expect(d.remoteError).toMatch(/missing-origin\.git/);
    expect(d.currentBranch).toBe("eve/feature");
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

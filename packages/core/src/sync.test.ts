import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { explainSyncRefusal, explainSyncResult } from "./explain.js";
import { executeSave, planSave } from "./save.js";
import { executeSync, planSync, type SyncPlan } from "./sync.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const remote = (ref: string): string => git(pg.root, "--git-dir=origin.git", "rev-parse", ref);

/** carol with her edit saved: clean, 1 behind main, no conflict with main. */
async function savedCarol(): Promise<string> {
  const dir = pg.clone("carol");
  const result = await executeSave(await planSave(dir));
  expect(result.ok).toBe(true);
  return dir;
}

function expectUntouched(dir: string, head: string): void {
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
}

function expectNoScratchWorktree(dir: string): void {
  expect(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  const scratch = path.join(dir, ".git", "teamrope");
  expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
}

describe("planSync + executeSync", () => {
  test("carol after a save: merges main cleanly and uploads", async () => {
    const dir = await savedCarol();
    const before = git(dir, "rev-parse", "HEAD");
    const originMain = git(dir, "rev-parse", "origin/main");

    const plan = await planSync(dir);
    expect(plan.canRun).toBe(true);
    expect(plan.dryRunMethod).toBe("mergeTree");
    expect(plan.steps.map((step) => step.kind)).toEqual(["merge", "upload"]);

    const result = await executeSync(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "rev-parse", "HEAD^1")).toBe(before);
    expect(git(dir, "rev-parse", "HEAD^2")).toBe(originMain);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Merge main into carol/feature");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(remote("carol/feature")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(dir, "rev-parse", result.backups[0]?.ref ?? "")).toBe(before);
    expect(explainSyncResult(plan, result).join(" ")).toContain("merged 1 new commit from main");
  });

  test("carol with unsaved changes: refused, save first", async () => {
    const plan = await planSync(pg.clone("carol"));
    expect(plan.refusal).toBe("saveFirst");
    expect(explainSyncRefusal(plan)).toEqual(["You have changes that aren't shared yet. Share your changes first, then Sync."]);
  });

  test("hank: conflict predicted, nothing changed, names who changed the file", async () => {
    const dir = pg.clone("hank");
    const head = git(dir, "rev-parse", "HEAD");

    const plan = await planSync(dir);
    expect(plan.canRun).toBe(false);
    expect(plan.conflicts).toEqual([
      {
        path: "src/config.js",
        authors: ["alice"],
        hunks: [
          {
            yours: ['  apiUrl: "https://hank.example.com",'],
            theirs: ['  apiUrl: "http://localhost:3000",'],
          },
        ],
      },
    ]);
    expectUntouched(dir, head);
    expect(plan.diagnosis.nextAction).toBe("sync");
    const text = explainSyncRefusal(plan);
    expect(text).toContain("alice changed the same part of src/config.js. Talk to them before syncing.");
    expect(text).toContain("  Your version:");
    expect(text).toContain('      apiUrl: "https://hank.example.com",');
    expect(text).toContain("  alice's version on main:");
    expect(text).toContain('      apiUrl: "http://localhost:3000",');
    expect(text.at(-1)).toBe(
      "Next: agree with alice on one version, edit your file to match it exactly, share your changes, then Sync.",
    );
  });

  test("alice: already up to date", async () => {
    const plan = await planSync(pg.clone("alice"));
    expect(plan.upToDate).toBe(true);
    expect(explainSyncRefusal(plan)).toEqual(["You already have everything from main."]);
  });

  test("dave: refused, start a task first", async () => {
    const plan = await planSync(pg.clone("dave"));
    expect(plan.refusal).toBe("startTask");
    expect(explainSyncRefusal(plan).join(" ")).toContain("Next: Start task");
  });

  test("worktree fallback (Git < 2.38): same predictions, scratch worktree always removed", async () => {
    const carol = await savedCarol();
    const clean = await planSync(carol, { dryRunMethod: "worktree" });
    expect(clean.dryRunMethod).toBe("worktree");
    expect(clean.canRun).toBe(true);
    expectNoScratchWorktree(carol);

    const hank = pg.clone("hank");
    const head = git(hank, "rev-parse", "HEAD");
    const conflicted = await planSync(hank, { dryRunMethod: "worktree" });
    expect(conflicted.conflicts).toEqual([
      {
        path: "src/config.js",
        authors: ["alice"],
        hunks: [
          {
            yours: ['  apiUrl: "https://hank.example.com",'],
            theirs: ['  apiUrl: "http://localhost:3000",'],
          },
        ],
      },
    ]);
    expectNoScratchWorktree(hank);
    expectUntouched(hank, head);
  });

  test("merge fails anyway: aborted and the branch restored from the backup", async () => {
    const dir = await savedCarol();
    const before = git(dir, "rev-parse", "HEAD");
    const plan = await planSync(dir);

    // Make the dry run "wrong": point the merge at a commit that conflicts
    // with carol's saved edit to the same line of src/app.js.
    git(dir, "switch", "--quiet", "--detach", "origin/main");
    writeFileSync(
      path.join(dir, "src", "app.js"),
      'function greeting() {\n  return "Howdy";\n}\n\nconsole.log(greeting());\n',
    );
    git(dir, "commit", "--quiet", "-am", "Conflicting greeting");
    const conflicting = git(dir, "rev-parse", "HEAD");
    git(dir, "switch", "--quiet", "carol/feature");
    const wrongPlan: SyncPlan = {
      ...plan,
      target: conflicting,
      steps: plan.steps.map((step) =>
        step.kind === "merge" ? { ...step, target: conflicting } : step,
      ),
    };

    const result = await executeSync(wrongPlan);
    expect(result.ok).toBe(false);
    expect(result.failedStep?.kind).toBe("merge");
    expect(result.restored).toBe(true);
    expectUntouched(dir, before);
    expect(explainSyncResult(wrongPlan, result).join(" ")).toContain(
      "put carol/feature back exactly as it was",
    );
  });
});

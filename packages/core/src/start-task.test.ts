import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { explainStartTaskRefusal } from "./explain.js";
import { executeStartTask, planStartTask, slugify } from "./start-task.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const kinds = (plan: { steps: Array<{ kind: string }> }): string[] =>
  plan.steps.map((step) => step.kind);

describe("planStartTask + executeStartTask", () => {
  test("alice: clean on her branch, gets a new branch from origin/main", async () => {
    const dir = pg.clone("alice");
    const featureBefore = git(dir, "rev-parse", "alice/feature");

    const plan = await planStartTask(dir);
    expect(plan.canRun).toBe(true);
    expect(plan.branch).toBe("alice/work");
    expect(plan.nameIsNew).toBe(true);
    expect(kinds(plan)).toEqual(["saveName", "createBranch", "push"]);
    // Planning changes nothing.
    expect(git(dir, "branch", "--show-current")).toBe("alice/feature");

    const result = await executeStartTask(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "branch", "--show-current")).toBe("alice/work");
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", "origin/main"));
    expect(git(dir, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/alice/work");
    expect(git(dir, "config", "--local", "branchguard.name")).toBe("alice");
    expect(git(dir, "rev-parse", "alice/feature")).toBe(featureBefore);

    // Name is saved now, and alice/work is taken.
    const again = await planStartTask(dir);
    expect(again.nameIsNew).toBe(false);
    expect(again.branch).toBe("alice/work-2");
  });

  test("bob: his unpushed commit moves to his branch, local main goes back to origin/main", async () => {
    const dir = pg.clone("bob");
    const oldMain = git(dir, "rev-parse", "main");
    const originMain = git(dir, "rev-parse", "origin/main");
    const remoteMainBefore = git(pg.root, "--git-dir=origin.git", "rev-parse", "main");

    const plan = await planStartTask(dir, { taskName: "Login Page" });
    expect(plan.branch).toBe("bob/login-page");
    expect(kinds(plan)).toEqual(["saveName", "createBranch", "moveMain", "push"]);

    const result = await executeStartTask(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "branch", "--show-current")).toBe("bob/login-page");
    expect(git(dir, "rev-parse", "HEAD")).toBe(oldMain);
    expect(git(dir, "rev-parse", "main")).toBe(originMain);

    expect(result.backups).toHaveLength(1);
    const backup = result.backups[0]?.ref ?? "";
    expect(backup).toMatch(/^refs\/branchguard\/backup\/\d{8}-\d{6}-\d{3}-main$/);
    expect(git(dir, "rev-parse", backup)).toBe(oldMain);

    // Pushed his branch, never main.
    expect(git(pg.root, "--git-dir=origin.git", "rev-parse", "bob/login-page")).toBe(oldMain);
    expect(git(pg.root, "--git-dir=origin.git", "rev-parse", "main")).toBe(remoteMainBefore);
  });

  test("dave: unsaved changes move to the new branch, main stays clean", async () => {
    const dir = pg.clone("dave");
    const originMain = git(dir, "rev-parse", "origin/main");

    const plan = await planStartTask(dir);
    expect(plan.branch).toBe("dave/work");
    expect(kinds(plan)).toEqual(["saveName", "createBranch", "push"]);

    const result = await executeStartTask(plan);
    expect(result.ok).toBe(true);
    expect(result.backups).toEqual([]);
    expect(git(dir, "branch", "--show-current")).toBe("dave/work");
    expect(git(dir, "status", "--porcelain")).toBe("M src/app.js");
    expect(git(dir, "rev-parse", "main")).toBe(originMain);
    expect(git(dir, "rev-parse", "HEAD")).toBe(originMain);
  });

  test("carol: refused, save first", async () => {
    const plan = await planStartTask(pg.clone("carol"));
    expect(plan.canRun).toBe(false);
    expect(plan.refusal).toBe("saveFirst");
    expect(plan.steps).toEqual([]);
    expect(explainStartTaskRefusal(plan).join(" ")).toContain("Save first");
  });

  test("eve: refused, fix access", async () => {
    const plan = await planStartTask(pg.clone("eve"));
    expect(plan.canRun).toBe(false);
    expect(plan.refusal).toBe("fixAccess");
  });

  test("frank: refused, finish the merge", async () => {
    const plan = await planStartTask(pg.clone("frank"));
    expect(plan.canRun).toBe(false);
    expect(plan.refusal).toBe("finishOperation");
  });

  test("detached HEAD: refused, ask the captain", async () => {
    const dir = pg.clone("alice");
    git(dir, "switch", "--quiet", "--detach", "HEAD~1");
    const plan = await planStartTask(dir);
    expect(plan.refusal).toBe("askCaptain");
  });

  test("push fails: the local branch is kept and the problem explained", async () => {
    const dir = pg.clone("alice");
    const plan = await planStartTask(dir);
    git(dir, "remote", "set-url", "origin", path.join(pg.root, "gone.git"));

    const result = await executeStartTask(plan);
    expect(result.ok).toBe(false);
    expect(result.failedStep?.kind).toBe("push");
    expect(result.pushProblem?.kind).toBe("notFoundOrNoAccess");
    expect(git(dir, "branch", "--show-current")).toBe("alice/work");
  });

  test("repo changed after planning: nothing runs", async () => {
    const dir = pg.clone("dave");
    const plan = await planStartTask(dir);
    writeFileSync(path.join(dir, "NEW.md"), "new\n");
    git(dir, "add", "NEW.md");
    git(dir, "commit", "--quiet", "-m", "Sneak in a commit");

    const result = await executeStartTask(plan);
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.error).toMatch(/changed since the plan/);
    expect(git(dir, "branch", "--show-current")).toBe("main");
  });
});

describe("slugify", () => {
  test.each([
    ["Alice Smith", "alice-smith"],
    ["  Login Page!! ", "login-page"],
    ["Zoë Ñúñez", "zoe-nunez"],
    ["日本語", ""],
  ])("%s -> %s", (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });
});

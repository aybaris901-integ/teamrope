import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { explainSavePlan, explainSaveRefusal, explainSaveResult } from "./explain.js";
import { applySaveChoices, commitMessageFor, executeSave, planSave } from "./save.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const kinds = (plan: { steps: Array<{ kind: string }> }): string[] =>
  plan.steps.map((step) => step.kind);
const remote = (ref: string): string => git(pg.root, "--git-dir=origin.git", "rev-parse", ref);

describe("planSave + executeSave", () => {
  test("carol: commits her edit and uploads it to her own branch", async () => {
    const dir = pg.clone("carol");
    const plan = await planSave(dir);
    expect(plan.canRun).toBe(true);
    expect(kinds(plan)).toEqual(["commit", "upload"]);
    expect(plan.steps[0]).toMatchObject({ files: ["src/app.js"], message: "Update src/app.js" });

    const result = await executeSave(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Update src/app.js");
    expect(remote("carol/feature")).toBe(git(dir, "rev-parse", "HEAD"));
  });

  test("-m overrides the generated message", async () => {
    const plan = await planSave(pg.clone("carol"), { message: "Say hi to the team" });
    expect(plan.steps[0]).toMatchObject({ message: "Say hi to the team" });
  });

  test("dave: saving on main moves the work to a new branch, then commits", async () => {
    const dir = pg.clone("dave");
    const originMain = git(dir, "rev-parse", "origin/main");
    const remoteMainBefore = remote("main");

    const plan = await planSave(dir);
    expect(kinds(plan)).toEqual(["saveName", "createBranch", "commit", "upload"]);
    expect(plan.branch).toBe("dave/work");

    const result = await executeSave(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "branch", "--show-current")).toBe("dave/work");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "rev-parse", "HEAD~1")).toBe(originMain);
    expect(git(dir, "rev-parse", "main")).toBe(originMain);
    expect(remote("dave/work")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(remote("main")).toBe(remoteMainBefore);
  });

  test("gina: the secret and node_modules are found and left out by default (--yes)", async () => {
    const dir = pg.clone("gina");
    const plan = await planSave(dir);
    expect(plan.risky).toEqual([
      { kind: "secret", path: ".env", reason: "apiKey", tracked: false },
      { kind: "generated", path: "node_modules/", fileCount: 2 },
    ]);
    // Defaults = what --yes does.
    expect(kinds(plan)).toEqual(["ignore", "commit", "upload"]);
    expect(plan.steps[1]).toMatchObject({ files: ["README.md", ".gitignore"] });

    const result = await executeSave(plan);
    expect(result.ok).toBe(true);
    expect(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      ".gitignore",
      "README.md",
    ]);
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".env\nnode_modules/\n");
    // .env is still on disk, but both are ignored now.
    expect(existsSync(path.join(dir, ".env"))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(explainSaveResult(plan, result).join(" ")).toContain("Uploaded your work to gina/feature");
  });

  test("gina: leaving the secret out but not ignoring it", async () => {
    const plan = applySaveChoices(await planSave(pg.clone("gina")), {}, { ".env": false });
    expect(plan.steps[0]).toMatchObject({ kind: "ignore", entries: ["node_modules/"] });
  });

  test("an already-ignored secret isn't offered for .gitignore", async () => {
    const dir = pg.clone("gina");
    writeFileSync(path.join(dir, ".git", "info", "exclude"), ".env\n");
    writeFileSync(path.join(dir, "deploy.key"), "x\n");
    const plan = await planSave(dir);
    expect(plan.risky.map((r) => r.path)).toContain("deploy.key");
    expect(plan.ignorableSecrets).toEqual(["deploy.key"]);
  });

  test("gina: answering yes to the secret question includes it", async () => {
    const plan = applySaveChoices(await planSave(pg.clone("gina")), {
      ".env": true,
      "node_modules/": false,
    });
    expect(plan.steps.find((step) => step.kind === "commit")).toMatchObject({
      files: ["README.md", ".env", ".gitignore"],
    });
  });

  test("a secret staged earlier still stays out of the commit", async () => {
    const dir = pg.clone("gina");
    git(dir, "add", "--force", ".env");
    const result = await executeSave(await planSave(dir));
    expect(result.ok).toBe(true);
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).not.toContain(".env");
  });

  test("a secret committed before: warned about, not offered for .gitignore, not blocked", async () => {
    const dir = pg.clone("gina");
    git(dir, "add", "--force", ".env");
    git(dir, "commit", "--quiet", "-m", "Oops, add .env");
    writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-test-ffffffffffffffffffffffffffff\n");

    const plan = await planSave(dir);
    expect(plan.canRun).toBe(true);
    expect(plan.risky).toContainEqual({ kind: "secret", path: ".env", reason: "apiKey", tracked: true });
    expect(plan.ignorableSecrets).toEqual([]);
    const notes = explainSavePlan(plan).join(" ");
    expect(notes).toContain(".env is already in the repo history");
    expect(notes).toContain("Replace the key");
    expect(notes).toContain("Removing the file isn't enough.");

    const result = await executeSave(plan);
    expect(result.ok).toBe(true);
    // Left out by default: the new key isn't committed.
    expect(git(dir, "status", "--porcelain")).toBe("M .env");
  });

  test("alice: nothing to save", async () => {
    const plan = await planSave(pg.clone("alice"));
    expect(plan.nothingToSave).toBe(true);
    expect(plan.canRun).toBe(false);
    expect(explainSaveRefusal(plan)).toEqual(["Nothing to save, you're all set."]);
  });

  test("frank: refused while the merge is unfinished", async () => {
    const plan = await planSave(pg.clone("frank"));
    expect(plan.canRun).toBe(false);
    expect(plan.refusal).toBe("finishOperation");
  });

  test("push rejected because the remote branch moved: commit kept, Sync suggested", async () => {
    const dir = pg.clone("carol");
    const plan = await planSave(dir);

    // Someone else pushes to carol/feature after the plan was made.
    const other = path.join(pg.root, "other");
    execFileSync("git", ["clone", "--quiet", "-b", "carol/feature", "origin.git", other], {
      cwd: pg.root,
    });
    writeFileSync(path.join(other, "OTHER.md"), "from another computer\n");
    git(other, "add", "OTHER.md");
    git(other, "-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "-qm", "Other");
    git(other, "push", "--quiet");
    const remoteBranch = remote("carol/feature");

    const result = await executeSave(plan);
    expect(result.ok).toBe(false);
    expect(result.pushRejected).toBe(true);
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Update src/app.js");
    expect(remote("carol/feature")).toBe(remoteBranch);
    expect(explainSaveResult(plan, result).join(" ")).toContain("Sync");
  });

  test("remote branch already ahead when planning: commit only, no upload", async () => {
    const dir = pg.clone("carol");
    const other = path.join(pg.root, "other");
    execFileSync("git", ["clone", "--quiet", "-b", "carol/feature", "origin.git", other], {
      cwd: pg.root,
    });
    git(other, "-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "--allow-empty", "-qm", "Other");
    git(other, "push", "--quiet");

    const plan = await planSave(dir);
    expect(plan.uploadBlocked).toBe(true);
    expect(kinds(plan)).toEqual(["commit"]);
  });

  test("eve: no access, so the work is committed locally and the upload fails", async () => {
    const dir = pg.clone("eve");
    writeFileSync(path.join(dir, "notes.txt"), "offline work\n");
    const plan = await planSave(dir);
    expect(plan.canRun).toBe(true);

    const result = await executeSave(plan);
    expect(result.ok).toBe(false);
    expect(result.pushProblem?.kind).toBe("notFoundOrNoAccess");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("Update notes.txt");
    expect(explainSaveResult(plan, result).join(" ")).toContain("saved only on this computer");
  });
});

describe("commitMessageFor", () => {
  test.each([
    [["a.js"], "Update a.js"],
    [["a.js", "b.js"], "Update a.js and b.js"],
    [["src/app.js", "b", "c"], "Update src/app.js and 2 other files"],
  ])("%j -> %s", (files, message) => {
    expect(commitMessageFor(files)).toBe(message);
  });
});

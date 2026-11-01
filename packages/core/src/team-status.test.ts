import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { explainTeamStatus, timeAgo } from "./explain.js";
import { executeSave, planSave } from "./save.js";
import { teamStatus, type TeamProblem } from "./team-status.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const HOUR = 60 * 60 * 1000;
const kinds = (problems: TeamProblem[]): string[] => problems.map((p) => p.kind);

/** Clones the copied origin into `name`, for pushing test branches. */
function helperClone(name: string, from = "origin.git"): string {
  const dir = path.join(pg.root, name);
  execFileSync("git", ["clone", "--quiet", from, dir], { cwd: pg.root });
  git(dir, "config", "user.name", name);
  git(dir, "config", "user.email", `${name}@example.com`);
  return dir;
}

/** Pushes a new branch with one commit dated `hoursAgo` hours ago. */
function pushBranchAt(dir: string, branch: string, hoursAgo: number): void {
  const date = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  git(dir, "switch", "--quiet", "-c", branch, "origin/main");
  writeFileSync(path.join(dir, `${branch.replace("/", "-")}.md`), "idea\n");
  git(dir, "add", ".");
  execFileSync("git", ["commit", "--quiet", "-m", "Idea"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  git(dir, "push", "--quiet", "origin", branch);
}

describe("teamStatus", () => {
  test("playground: hank conflicts with main, alice and frank overlap", async () => {
    const status = await teamStatus(pg.clone("alice"));
    expect(status.canReachRemote).toBe(true);
    expect(status.branches.map((b) => b.branch)).toEqual([
      "alice/feature",
      "carol/feature",
      "eve/feature",
      "frank/feature",
      "gina/feature",
      "hank/feature",
    ]);
    expect(status.problems[0]).toEqual({
      kind: "conflictWithMain",
      branch: "hank/feature",
      owner: "hank",
      conflicts: [{ path: "src/config.js", mainAuthors: ["alice"] }],
    });
    // hank vs alice also clashes in src/config.js, but that's main's change:
    // reported once, as hank's conflict with main.
    expect(status.overlaps).toEqual([
      { branches: ["alice/feature", "frank/feature"], owners: ["alice", "frank"], files: ["src/app.js"] },
    ]);
    const hank = status.branches.find((b) => b.branch === "hank/feature");
    expect(hank).toMatchObject({ owner: "hank", ahead: 1, behind: 1 });
  });

  test("carol after a save overlaps alice in src/app.js", async () => {
    expect((await executeSave(await planSave(pg.clone("carol")))).ok).toBe(true);
    const status = await teamStatus(pg.clone("alice"));
    expect(status.overlaps).toContainEqual({
      branches: ["alice/feature", "carol/feature"],
      owners: ["alice", "carol"],
      files: ["src/app.js"],
    });
  });

  test("a quiet branch is not a problem; a day-old one is collapsed", async () => {
    const helper = helperClone("helper");
    pushBranchAt(helper, "olive/idea", 3);
    pushBranchAt(helper, "pat/old-idea", 50);

    const status = await teamStatus(pg.clone("alice"));
    expect(status.problems.some((p) => p.kind !== "overlap" && p.branch === "olive/idea")).toBe(false);
    expect(status.oldBranches.map((b) => b.branch)).toEqual(["pat/old-idea"]);
    expect(status.branches.map((b) => b.branch)).not.toContain("pat/old-idea");
    const text = explainTeamStatus(status);
    expect(text).toContain("and 1 old branch (not shared for over a day)");
    expect(text.join("\n")).toMatch(/olive\s+olive\/idea\s+3 h ago/);
  });

  test("a branch far behind main is flagged", async () => {
    const helper = helperClone("helper");
    for (let i = 0; i < 5; i++) git(helper, "commit", "--quiet", "--allow-empty", "-m", `Main ${i}`);
    git(helper, "push", "--quiet", "origin", "main");

    const status = await teamStatus(pg.clone("alice"));
    expect(status.problems).toContainEqual({
      kind: "farBehind",
      branch: "alice/feature",
      owner: "alice",
      behind: 5,
    });
  });

  test("problems come most urgent first", async () => {
    const helper = helperClone("helper");
    for (let i = 0; i < 5; i++) git(helper, "commit", "--quiet", "--allow-empty", "-m", `Main ${i}`);
    git(helper, "push", "--quiet", "origin", "main");
    const status = await teamStatus(pg.clone("alice"));
    expect(kinds(status.problems).slice(0, 2)).toEqual(["conflictWithMain", "overlap"]);
    expect(kinds(status.problems).at(-1)).toBe("farBehind");
  });

  test("a fresh repo with clean branches: no problems", async () => {
    git(pg.root, "init", "--quiet", "--bare", "--initial-branch=main", "fresh.git");
    git(pg.root, "--git-dir=origin.git", "push", "--quiet", path.join(pg.root, "fresh.git"), "main");
    const solo = helperClone("solo", "fresh.git");
    pushBranchAt(solo, "solo/idea", 0);

    const status = await teamStatus(solo);
    expect(status.problems).toEqual([]);
    const text = explainTeamStatus(status);
    expect(text[0]).toBe("No problems. Everyone's work combines cleanly.");
    expect(text.join("\n")).toMatch(/solo\s+solo\/idea\s+just now\s+\+1 \/ -0\s+ok/);
    expect(text.at(-1)).toBe("This only shows shared work. Ask everyone to share changes often.");
  });

  test("the worktree fallback finds the same conflicts", async () => {
    const status = await teamStatus(pg.clone("alice"), { dryRunMethod: "worktree" });
    expect(kinds(status.problems)).toEqual(["conflictWithMain", "overlap"]);
  });

  test("read-only: local branches, files and backups are untouched", async () => {
    const dir = pg.clone("carol");
    const refsBefore = git(dir, "for-each-ref", "refs/heads", "refs/branchguard");
    const statusBefore = git(dir, "status", "--porcelain");
    const headBefore = git(dir, "rev-parse", "HEAD");

    await teamStatus(dir);
    expect(git(dir, "for-each-ref", "refs/heads", "refs/branchguard")).toBe(refsBefore);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(git(dir, "rev-parse", "HEAD")).toBe(headBefore);
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  test.each([
    [20_000, "just now"],
    [25 * 60_000, "25 min ago"],
    [3 * HOUR, "3 h ago"],
    [26 * HOUR, "1 day ago"],
    [50 * HOUR, "2 days ago"],
  ])("%d ms -> %s", (ms, text) => {
    expect(timeAgo(new Date(now.getTime() - ms), now)).toBe(text);
  });
});

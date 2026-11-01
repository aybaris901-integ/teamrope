import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { problemsForMe } from "./my-problems.js";
import {
  fileAtRef,
  notSharedSince,
  overlapsWithMe,
  parseDiffHunks,
  predictMainConflicts,
  recentActivity,
  type TheirSide,
} from "./overlaps.js";
import { executeSave, planSave } from "./save.js";
import { teamStatus } from "./team-status.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const branches = (o: Array<{ branch: string }>): string[] => o.map((x) => x.branch);

/** Clones the copied origin on `branch`, commits `file` = `content`, pushes. */
function pushFrom(name: string, branch: string, file: string, content: string): void {
  const dir = path.join(pg.root, name);
  execFileSync("git", ["clone", "--quiet", "-b", branch, "origin.git", dir], { cwd: pg.root });
  writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "-c", `user.name=${name}`, "-c", `user.email=${name}@example.com`, "commit", "--quiet", "-m", "More");
  git(dir, "push", "--quiet");
}

/** A Map that counts how often their side had to be computed. */
class CountingCache extends Map<string, TheirSide> {
  sets = 0;
  override set(key: string, value: TheirSide): this {
    this.sets++;
    return super.set(key, value);
  }
}

describe("overlapsWithMe", () => {
  test("carol's unshared edit overlaps alice and frank on the same line", async () => {
    const overlaps = await overlapsWithMe(pg.clone("carol"));
    expect(branches(overlaps)).toEqual(["alice/feature", "frank/feature"]);
    const alice = overlaps[0];
    expect(alice).toMatchObject({
      owner: "alice",
      files: [
        {
          path: "src/app.js",
          ranges: [{ mine: { start: 2, end: 2 }, theirs: { start: 2, end: 2 } }],
          authors: ["alice"],
        },
      ],
    });
    expect(alice?.files[0]?.since).toBeInstanceOf(Date);
  });

  test("carol after Share: overlap with alice still reported", async () => {
    const dir = pg.clone("carol");
    expect((await executeSave(await planSave(dir))).ok).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
    const overlaps = await overlapsWithMe(dir);
    expect(branches(overlaps)).toContain("alice/feature");
    expect(overlaps.find((o) => o.branch === "alice/feature")?.files[0]?.path).toBe("src/app.js");
  });

  test("a branch I own (carol/login for carol) is skipped, and so is my upstream", async () => {
    const dir = pg.clone("carol");
    git(dir, "switch", "--quiet", "-c", "carol/login");
    git(dir, "commit", "--quiet", "-am", "Login greeting");
    git(dir, "push", "--quiet", "-u", "origin", "carol/login");
    git(dir, "switch", "--quiet", "carol/feature");
    writeFileSync(path.join(dir, "src", "app.js"), 'function greeting() {\n  return "Hi team";\n}\n');

    const found = branches(await overlapsWithMe(dir));
    expect(found).not.toContain("carol/login");
    expect(found).not.toContain("carol/feature");
  });

  test("a new untracked file that a teammate also added overlaps", async () => {
    const dir = pg.clone("carol");
    writeFileSync(path.join(dir, "NOTES.md"), "my notes\n"); // eve/feature added NOTES.md too
    const eve = (await overlapsWithMe(dir)).find((o) => o.branch === "eve/feature");
    expect(eve?.files.map((f) => f.path)).toEqual(["NOTES.md"]);
    expect(eve?.files[0]?.ranges).toHaveLength(1);
  });

  test("no overlap when we change different files (hank only touched src/config.js)", async () => {
    expect(branches(await overlapsWithMe(pg.clone("carol")))).not.toContain("hank/feature");
  });

  test("their side is cached by ref SHA: recomputed only after their branch moves", async () => {
    const dir = pg.clone("carol");
    const cache = new CountingCache();
    await overlapsWithMe(dir, { cache });
    const first = cache.sets;
    expect(first).toBeGreaterThan(0);

    // Editing my file again: only my side changes.
    writeFileSync(path.join(dir, "src", "app.js"), 'function greeting() {\n  return "Hey all";\n}\n');
    await overlapsWithMe(dir, { cache });
    expect(cache.sets).toBe(first);

    pushFrom("alice2", "alice/feature", "README.md", "# Changed by alice\n");
    git(dir, "fetch", "--quiet");
    await overlapsWithMe(dir, { cache });
    expect(cache.sets).toBe(first + 1);
  });
});

describe("problemsForMe", () => {
  test("drops Team status' carol/alice pair in favour of the local overlap", async () => {
    const dir = pg.clone("carol");
    expect((await executeSave(await planSave(dir))).ok).toBe(true);
    const team = await teamStatus(dir);
    expect(team.overlaps.map((o) => o.branches)).toContainEqual(["alice/feature", "carol/feature"]);

    const problems = problemsForMe(team, await overlapsWithMe(dir), [], "carol/feature");
    const teamPairs = problems.flatMap((p) =>
      p.kind === "team" && p.problem.kind === "overlap" ? [p.problem.overlap.branches.join(" + ")] : [],
    );
    expect(teamPairs).not.toContain("alice/feature + carol/feature");
    expect(teamPairs).toContain("alice/feature + frank/feature"); // not mine: kept
    expect(problems.filter((p) => p.kind === "overlapWithMe").map((p) => p.overlap.branch)).toEqual([
      "alice/feature",
      "frank/feature",
    ]);
    expect(problems.some((p) => p.kind === "team" && p.problem.kind === "conflictWithMain")).toBe(true); // hank's
  });
});

describe("predictMainConflicts", () => {
  test("hank: src/config.js would conflict with alice's change on main", async () => {
    const dir = pg.clone("hank");
    git(dir, "fetch", "--quiet");
    const conflicts = await predictMainConflicts(dir);
    expect(conflicts.map((c) => [c.path, c.authors])).toEqual([["src/config.js", ["alice"]]]);
    expect(conflicts[0]?.hunks[0]?.yours).toEqual(['  apiUrl: "https://hank.example.com",']);
    expect(conflicts[0]?.since).toBeInstanceOf(Date);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("carol: nothing would conflict", async () => {
    expect(await predictMainConflicts(pg.clone("carol"))).toEqual([]);
  });
});

describe("helpers", () => {
  test("notSharedSince: the oldest changed file's time, null when clean", async () => {
    const since = await notSharedSince(pg.clone("carol"));
    expect(since).toBeInstanceOf(Date);
    expect(Date.now() - (since?.getTime() ?? 0)).toBeLessThan(10 * 60 * 1000);
    expect(await notSharedSince(pg.clone("alice"))).toBeNull();
  });

  test("recentActivity: latest commits across the team repo", async () => {
    const activity = await recentActivity(pg.clone("carol"));
    expect(activity).toHaveLength(5);
    expect(activity).toContainEqual(
      expect.objectContaining({ branch: "main", author: "alice", subject: "Add API URL to config" }),
    );
    expect(activity.map((a) => a.branch)).not.toContain("HEAD");
  });

  test("fileAtRef: a teammate's version, or null if the file isn't there", async () => {
    const dir = pg.clone("carol");
    expect(await fileAtRef(dir, "refs/remotes/origin/alice/feature", "src/app.js")).toContain("Hello, hackers!");
    expect(await fileAtRef(dir, "refs/remotes/origin/alice/feature", "nope.txt")).toBeNull();
  });

  test("parseDiffHunks: counts default to 1; insertions and deletions", () => {
    const diff = [
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -2 +2 @@ function greeting() {",
      "@@ -5,0 +6,2 @@",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
    ].join("\n");
    expect(Object.fromEntries(parseDiffHunks(diff))).toEqual({
      "src/app.js": [
        { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
        { oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 },
      ],
      "old.txt": [{ oldStart: 1, oldCount: 3, newStart: 0, newCount: 0 }],
    });
  });
});

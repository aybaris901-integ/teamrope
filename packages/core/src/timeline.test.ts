import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { timelineAxis, timelineDuration, timelineRowSummary } from "./explain.js";
import { problemsForMe } from "./my-problems.js";
import { overlapsWithMe, predictMainConflicts } from "./overlaps.js";
import { teamStatus } from "./team-status.js";
import { buildTimeline, sharedCommits, TIMELINE_WINDOW_MS } from "./timeline.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => pg.cleanup());

const HOUR = 60 * 60 * 1000;

/** Pushes olive/idea with one commit dated `hoursAgo` hours ago, from a helper clone. */
function pushOliveAt(hoursAgo: number): void {
  const dir = path.join(pg.root, "helper");
  execFileSync("git", ["clone", "--quiet", "origin.git", dir], { cwd: pg.root });
  git(dir, "config", "user.name", "olive");
  git(dir, "config", "user.email", "olive@example.com");
  git(dir, "switch", "--quiet", "-c", "olive/idea", "origin/main");
  writeFileSync(path.join(dir, "idea.md"), "idea\n");
  git(dir, "add", ".");
  const date = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  execFileSync("git", ["commit", "--quiet", "-m", "Idea"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  git(dir, "push", "--quiet", "origin", "olive/idea");
}

describe("sharedCommits", () => {
  test("teammates' commits in the window, owner from the branch name; main and old commits left out", async () => {
    pushOliveAt(3);
    const dir = pg.clone("carol");
    git(dir, "fetch", "--quiet");
    const commits = await sharedCommits(dir, { since: new Date(Date.now() - TIMELINE_WINDOW_MS) });
    expect(commits).toContainEqual(expect.objectContaining({ branch: "alice/feature", owner: "alice" }));
    expect(commits.map((c) => c.branch)).not.toContain("main");
    expect(commits.map((c) => c.branch)).not.toContain("olive/idea");
  });
});

describe("buildTimeline", () => {
  test("carol: me first with the overlap, then conflicts, overlaps, quiet teammates", async () => {
    pushOliveAt(3);
    const dir = pg.clone("carol");
    git(dir, "fetch", "--quiet");
    const now = new Date();
    const team = await teamStatus(dir, { fetch: false });
    const overlaps = await overlapsWithMe(dir);
    const problems = problemsForMe(team, overlaps, await predictMainConflicts(dir), "carol/feature");
    const commits = await sharedCommits(dir, { since: new Date(now.getTime() - TIMELINE_WINDOW_MS) });
    const timeline = buildTimeline({ now, me: "carol", commits, team, problems, notSharedSince: new Date(now.getTime() - 5 * 60_000) });

    const people = timeline.rows.map((r) => r.person);
    expect(people[0]).toBe("carol");
    expect(people[1]).toBe("hank");
    expect(people.indexOf("alice")).toBeLessThan(people.indexOf("olive"));

    const carol = timeline.rows[0]!;
    expect(carol.isMe).toBe(true);
    expect(carol.problems.map((p) => p.kind)).toEqual(["overlap"]);
    expect(carol.notSharedSince).not.toBeNull();

    const hank = timeline.rows.find((r) => r.person === "hank")!;
    expect(hank.problems).toEqual([expect.objectContaining({ kind: "conflict", since: null })]);
    const alice = timeline.rows.find((r) => r.person === "alice")!;
    expect(alice.problems.map((p) => p.kind)).toEqual(["overlap"]);
    expect(alice.commits.length).toBeGreaterThan(0);

    // A quiet teammate is not a problem: no shape, just no dots.
    const olive = timeline.rows.find((r) => r.person === "olive")!;
    expect(olive.problems).toEqual([]);
    expect(olive.commits).toEqual([]);
    expect(timelineRowSummary(olive, now, TIMELINE_WINDOW_MS)).toBe("olive · last shared 3h ago");
  });

  test("texts: axis, durations say just now under a minute", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(timelineAxis(TIMELINE_WINDOW_MS)).toEqual(["−2h", "−1h", "now"]);
    expect(timelineDuration({ kind: "overlap", since: new Date(now.getTime() - 20_000), problemIndexes: [] }, now)).toBe("just now");
    expect(timelineDuration({ kind: "overlap", since: new Date(now.getTime() - 20 * 60_000), problemIndexes: [] }, now)).toBe("~20m");
    expect(timelineDuration({ kind: "conflict", since: null, problemIndexes: [] }, now)).toBe("");
  });
});

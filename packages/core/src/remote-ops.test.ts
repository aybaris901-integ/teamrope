import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { copyPlayground, git, type PlaygroundCopy } from "../test/playground-copy.js";
import { diagnose } from "./diagnose.js";
import { configureGit } from "./git.js";
import type { RemoteOps } from "./remote-ops.js";
import { executeSave, planSave } from "./save.js";
import { teamStatus } from "./team-status.js";

let pg: PlaygroundCopy;
beforeEach(() => {
  pg = copyPlayground();
});
afterEach(() => {
  configureGit({}); // back to "git" from PATH
  pg.cleanup();
});

/** RemoteOps that records calls; push fails with `pushError` if given. */
function fakeOps(pushError?: string): RemoteOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch({ prune }) {
      calls.push(`fetch prune=${String(prune)}`);
    },
    async push(branch, { setUpstream }) {
      calls.push(`push ${branch} upstream=${String(setUpstream)}`);
      if (pushError) throw new Error(pushError);
    },
  };
}

describe("diagnose without fetching", () => {
  test("uses the known remote state, so an unreachable remote still means fixAccess", async () => {
    const d = await diagnose(pg.clone("alice"), "main", {
      fetch: false,
      knownRemote: { canReachRemote: false, remoteProblem: { kind: "network", detail: "offline" } },
    });
    expect(d.canReachRemote).toBe(false);
    expect(d.nextAction).toBe("fixAccess");
  });

  test("doesn't touch the network (eve's broken remote isn't even tried)", async () => {
    const d = await diagnose(pg.clone("eve"), "main", { fetch: false });
    expect(d.canReachRemote).toBe(true);
    expect(d.remoteProblem).toBeNull();
  });

  test("injected RemoteOps are used for the fetch", async () => {
    const ops = fakeOps();
    await diagnose(pg.clone("alice"), "main", { remoteOps: ops });
    expect(ops.calls).toEqual(["fetch prune=false"]);
  });
});

describe("teamStatus without fetching", () => {
  test("only sees branches from the last fetch", async () => {
    const helper = path.join(pg.root, "helper");
    execFileSync("git", ["clone", "--quiet", "origin.git", helper], { cwd: pg.root });
    git(helper, "switch", "--quiet", "-c", "zed/new");
    git(helper, "-c", "user.name=zed", "-c", "user.email=z@example.com", "commit", "--quiet", "--allow-empty", "-m", "New");
    git(helper, "push", "--quiet", "origin", "zed/new");

    const dir = pg.clone("alice");
    const stale = await teamStatus(dir, { fetch: false });
    expect(stale.branches.map((b) => b.branch)).not.toContain("zed/new");
    const fresh = await teamStatus(dir);
    expect(fresh.branches.map((b) => b.branch)).toContain("zed/new");
  });
});

describe("Save with injected RemoteOps", () => {
  test("pushes through them", async () => {
    const ops = fakeOps();
    const dir = pg.clone("carol");
    const result = await executeSave(await planSave(dir, { remoteOps: ops }), { remoteOps: ops });
    expect(result.ok).toBe(true);
    expect(ops.calls).toEqual(["fetch prune=false", "push carol/feature upstream=true"]);
  });

  test("an auth error from them becomes an auth problem", async () => {
    const ops = fakeOps(
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/team/app.git/'",
    );
    const dir = pg.clone("carol");
    const result = await executeSave(await planSave(dir, { remoteOps: ops }), { remoteOps: ops });
    expect(result.pushProblem?.kind).toBe("auth");
  });

  test("a rejection from them is reported as rejected", async () => {
    const ops = fakeOps(" ! [rejected]        carol/feature -> carol/feature (fetch first)");
    const dir = pg.clone("carol");
    const result = await executeSave(await planSave(dir, { remoteOps: ops }), { remoteOps: ops });
    expect(result.pushRejected).toBe(true);
  });
});

describe("configureGit", () => {
  test("accepts an absolute path to an existing git and uses it", async () => {
    const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    expect(configureGit({ binary: gitPath })).toEqual({ binary: gitPath });
    expect((await diagnose(pg.clone("alice"), "main", { fetch: false })).currentBranch).toBe(
      "alice/feature",
    );
  });

  test.each([["git"], ["relative/git"], ["/no/such/git"], [undefined]])(
    "falls back to git from PATH for %s",
    (binary) => {
      expect(configureGit({ binary })).toEqual({ binary: "git" });
    },
  );
});

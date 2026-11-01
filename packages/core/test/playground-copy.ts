// A private copy of ./playground for tests that change repos, so they don't
// affect each other or the read-only tests that share ./playground.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAYGROUND = fileURLToPath(new URL("../../../playground", import.meta.url));

export interface PlaygroundCopy {
  root: string;
  clone(name: string): string;
  cleanup(): void;
}

/** Runs git in `dir` and returns trimmed stdout. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

export function copyPlayground(): PlaygroundCopy {
  const root = mkdtempSync(path.join(tmpdir(), "teamrope-playground-"));
  execFileSync("cp", ["-a", `${PLAYGROUND}/.`, root]);

  // Point each clone at the copied origin (eve's broken URL stays broken).
  const originalOrigin = path.join(PLAYGROUND, "origin.git");
  for (const name of readdirSync(root)) {
    if (name === "origin.git") continue;
    const dir = path.join(root, name);
    if (git(dir, "remote", "get-url", "origin") === originalOrigin) {
      git(dir, "remote", "set-url", "origin", path.join(root, "origin.git"));
    }
  }

  return {
    root,
    clone: (name) => path.join(root, name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

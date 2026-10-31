// Dry-run merges: predict conflicts between two commits without touching the
// user's branch or files. Used by Sync and Team status.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { openRepo } from "./git.js";

/** mergeTree: `git merge-tree --write-tree` (Git 2.38+). worktree: older Git. */
export type DryRunMethod = "mergeTree" | "worktree";

/** One conflicting spot in a file: the lines on each side. */
export interface ConflictHunk {
  /** Lines from the first commit ("ours"). */
  yours: string[];
  /** Lines from the second commit ("theirs"). */
  theirs: string[];
}

export interface PredictedConflict {
  path: string;
  /** Empty when there are no conflict markers (e.g. changed vs deleted). */
  hunks: ConflictHunk[];
}

/**
 * Reads conflict markers. Handles the diff3 style too, where a
 * "|||||||" section with the original lines sits between the two sides.
 */
export function parseConflictHunks(text: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  let section: "outside" | "yours" | "base" | "theirs" = "outside";
  let hunk: ConflictHunk = { yours: [], theirs: [] };
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ") || line === "<<<<<<<") {
      section = "yours";
      hunk = { yours: [], theirs: [] };
    } else if (section === "yours" && line.startsWith("|||||||")) {
      section = "base";
    } else if ((section === "yours" || section === "base") && line === "=======") {
      section = "theirs";
    } else if (section === "theirs" && (line.startsWith(">>>>>>> ") || line === ">>>>>>>")) {
      hunks.push(hunk);
      section = "outside";
    } else if (section === "yours") {
      hunk.yours.push(line);
    } else if (section === "theirs") {
      hunk.theirs.push(line);
    }
  }
  return hunks;
}

async function mergeTreeConflicts(
  git: SimpleGit,
  ours: string,
  theirs: string,
): Promise<PredictedConflict[]> {
  // Exit 1 on conflict still resolves here (no stderr).
  const output = await git.raw(["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs]);
  const [tree, ...paths] = output.split("\n").filter(Boolean);
  const conflicts: PredictedConflict[] = [];
  for (const file of paths) {
    // The merged tree holds the file with conflict markers in it.
    const content = await git.raw(["cat-file", "-p", `${tree}:${file}`]).catch(() => "");
    conflicts.push({ path: file, hunks: parseConflictHunks(content) });
  }
  return conflicts;
}

/**
 * Older Git: try the merge in a throwaway worktree inside .git, so the
 * user's files are never touched. The worktree is always removed.
 */
async function worktreeConflicts(
  git: SimpleGit,
  dir: string,
  ours: string,
  theirs: string,
): Promise<PredictedConflict[]> {
  const gitDir = path.resolve(dir, (await git.revparse(["--git-common-dir"])).trim());
  const tmp = path.join(gitDir, "branchguard", `dry-run-${Date.now()}-${process.pid}`);
  mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    await git.raw(["worktree", "add", "--detach", "--quiet", tmp, ours]);
    const scratch = await openRepo(tmp);
    try {
      await scratch.raw(["merge", "--no-commit", "--no-ff", "--no-edit", theirs]);
    } catch {
      // A conflict may end up here or not; the unmerged list below decides.
    }
    const unmerged = (await scratch.raw(["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter(Boolean);
    return unmerged.map((file) => {
      const full = path.join(tmp, file);
      const content = existsSync(full) ? readFileSync(full, "utf8") : "";
      return { path: file, hunks: parseConflictHunks(content) };
    });
  } finally {
    // --force: it's our own scratch worktree, possibly mid-merge.
    await git.raw(["worktree", "remove", "--force", tmp]).catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
    await git.raw(["worktree", "prune"]).catch(() => undefined);
  }
}

/** Files that would conflict if `theirs` were merged into `ours`. Changes nothing. */
export async function predictConflicts(
  git: SimpleGit,
  dir: string,
  ours: string,
  theirs: string,
  method: DryRunMethod,
): Promise<PredictedConflict[]> {
  return method === "mergeTree"
    ? mergeTreeConflicts(git, ours, theirs)
    : worktreeConflicts(git, dir, ours, theirs);
}

/** Authors of commits on `theirs` (since it split from `ours`) that touched `file`. */
export async function authorsSinceSplit(
  git: SimpleGit,
  ours: string,
  theirs: string,
  file: string,
): Promise<string[]> {
  const base = (await git.raw(["merge-base", ours, theirs])).trim();
  const log = await git.raw(["log", "--format=%an", `${base}..${theirs}`, "--", `:(top,literal)${file}`]);
  return [...new Set(log.split("\n").filter(Boolean))];
}

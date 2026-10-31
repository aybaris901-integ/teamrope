// Shared helpers for running Git through simple-git.
import { existsSync, statSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";

/** Any Git command that stays silent this long is killed (e.g. a hanging fetch). */
export const GIT_TIMEOUT_MS = 15_000;

/** Thrown when a folder is not inside a Git working tree. */
export class NotAGitRepoError extends Error {
  constructor(dir: string) {
    super(
      `"${dir}" is not a Git repository. Open the folder of your project (the one that contains the .git folder).`,
    );
    this.name = "NotAGitRepoError";
  }
}

/**
 * Variables removed from the env of every Git call. Editors, pagers and
 * password pop-ups (e.g. VS Code's GIT_ASKPASS) all wait for a person, and
 * simple-git's safety checks reject them anyway.
 */
const INTERACTIVE_ENV_VARS = [
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "GIT_PAGER",
  "PAGER",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];

/**
 * The user's environment, made non-interactive: Git must fail fast instead of
 * waiting for a password nobody will type.
 */
export function cleanGitEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !INTERACTIVE_ENV_VARS.includes(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * Opens a simple-git instance for `dir`. Throws NotAGitRepoError if the
 * folder is missing or not inside a Git working tree.
 */
export async function openRepo(dir: string): Promise<SimpleGit> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new NotAGitRepoError(dir);
  }
  const git = simpleGit({ baseDir: dir, timeout: { block: GIT_TIMEOUT_MS } }).env(cleanGitEnv());

  let insideWorkTree = false;
  try {
    insideWorkTree = (await git.revparse(["--is-inside-work-tree"])) === "true";
  } catch {
    // "fatal: not a git repository" - handled below.
  }
  if (!insideWorkTree) throw new NotAGitRepoError(dir);
  return git;
}

/** Counts commits in a range like "HEAD..origin/main". Null if a ref is missing. */
export async function countCommits(git: SimpleGit, range: string): Promise<number | null> {
  try {
    return Number((await git.raw(["rev-list", "--count", range])).trim());
  } catch {
    return null;
  }
}

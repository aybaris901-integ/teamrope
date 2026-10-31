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
 * SSH that gives up on its own: never asks for a passphrase or host
 * confirmation, and drops dead connections within ~10 seconds.
 */
export const DEFAULT_SSH_COMMAND =
  "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2";

/**
 * The user's environment, made non-interactive: Git must fail fast instead of
 * waiting for a password nobody will type. Uses DEFAULT_SSH_COMMAND unless
 * the user set their own (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand).
 */
export function cleanGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  sshCommandInConfig = false,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !INTERACTIVE_ENV_VARS.includes(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !sshCommandInConfig) {
    env.GIT_SSH_COMMAND = DEFAULT_SSH_COMMAND;
  }
  return env;
}

async function hasSshCommandConfig(git: SimpleGit): Promise<boolean> {
  try {
    return (await git.raw(["config", "--get", "core.sshCommand"])).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Opens a simple-git instance for `dir`. Throws NotAGitRepoError if the
 * folder is missing or not inside a Git working tree.
 */
export async function openRepo(dir: string): Promise<SimpleGit> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new NotAGitRepoError(dir);
  }
  const git = simpleGit({
    baseDir: dir,
    // Backstop for anything that still hangs.
    timeout: { block: GIT_TIMEOUT_MS },
    // All of simple-git's safety checks stay on except this one: it rejects
    // any GIT_SSH_COMMAND, including our own DEFAULT_SSH_COMMAND and the
    // user's own setting.
    unsafe: { allowUnsafeSshCommand: true },
  }).env(cleanGitEnv());

  let insideWorkTree = false;
  try {
    insideWorkTree = (await git.revparse(["--is-inside-work-tree"])) === "true";
  } catch {
    // "fatal: not a git repository" - handled below.
  }
  if (!insideWorkTree) throw new NotAGitRepoError(dir);

  // GIT_SSH_COMMAND beats core.sshCommand, so drop our default if the repo
  // or the user's config already sets one.
  if (await hasSshCommandConfig(git)) git.env(cleanGitEnv(process.env, true));
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

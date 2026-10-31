// Shared helpers for running Git through simple-git.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { GitPluginError, simpleGit, type SimpleGit } from "simple-git";
import { classifyRemoteProblem, type RemoteProblem } from "./remote-problem.js";

/**
 * Any Git command that stays silent this long is killed (e.g. a hanging fetch).
 *
 * This is only a backstop. Killing Git does not kill the SSH process Git
 * started, so if the user's own SSH command (GIT_SSH_COMMAND, GIT_SSH or
 * core.sshCommand) hangs, that process is left running until it gives up by
 * itself. DEFAULT_SSH_COMMAND avoids this by timing out on its own.
 */
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

/** Thrown when the user's env has a variable simple-git refuses to pass to Git. */
export class BlockedEnvVarError extends Error {
  /** The variable's name, if simple-git's message names one. */
  readonly variable: string | null;

  constructor(simpleGitMessage: string) {
    const variable = /Use of "([^"]+)"/.exec(simpleGitMessage)?.[1] ?? null;
    super(
      variable
        ? `Your environment sets ${variable}, which can change what Git runs, so branchguard won't pass it to Git. Unset it in this terminal (\`unset ${variable}\`) and try again.`
        : `Your environment has a Git setting branchguard won't pass to Git (${simpleGitMessage}). Remove it and try again.`,
    );
    this.name = "BlockedEnvVarError";
    this.variable = variable;
  }
}

/**
 * Variables removed from the env of every Git call, all rejected by
 * simple-git's safety checks:
 * - editors, pagers and password pop-ups (e.g. VS Code's GIT_ASKPASS) wait
 *   for a person;
 * - PREFIX, GIT_EXTERNAL_DIFF and GIT_TEMPLATE_DIR are harmless to drop for
 *   the commands we run. Some setups (e.g. Termux) set PREFIX globally.
 * Anything else simple-git rejects becomes a BlockedEnvVarError.
 */
const STRIPPED_ENV_VARS = [
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "EDITOR",
  "GIT_PAGER",
  "PAGER",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "PREFIX",
  "GIT_EXTERNAL_DIFF",
  "GIT_TEMPLATE_DIR",
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
    if (value !== undefined && !STRIPPED_ENV_VARS.includes(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !sshCommandInConfig) {
    env.GIT_SSH_COMMAND = DEFAULT_SSH_COMMAND;
  }
  return env;
}

async function hasSshCommandConfig(git: SimpleGit): Promise<boolean> {
  return (await readConfig(git, "core.sshCommand")) !== null;
}

let gitBinary = "git";

/**
 * Chooses the git program core runs, e.g. the one VS Code uses. Only an
 * absolute path to an existing file is accepted; anything else means "git"
 * from PATH. Returns the binary that will be used.
 */
export function configureGit(options: { binary?: string }): { binary: string } {
  const candidate = options.binary;
  const usable =
    candidate !== undefined &&
    path.isAbsolute(candidate) &&
    existsSync(candidate) &&
    statSync(candidate).isFile();
  gitBinary = usable ? candidate : "git";
  return { binary: gitBinary };
}

/**
 * Opens a simple-git instance for `dir`. Throws NotAGitRepoError if the
 * folder is missing or not inside a Git working tree, and BlockedEnvVarError
 * if the env has a variable simple-git refuses.
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
    unsafe: {
      allowUnsafeSshCommand: true,
      // simple-git rejects paths with spaces (C:\Program Files\Git\...).
      // A configured binary was checked by configureGit and comes from the
      // UI's own Git integration, not from repo files.
      allowUnsafeCustomBinary: gitBinary !== "git",
    },
    binary: gitBinary,
  }).env(cleanGitEnv());

  let insideWorkTree = false;
  try {
    insideWorkTree = (await git.revparse(["--is-inside-work-tree"])) === "true";
  } catch (error) {
    // The first Git call, so an env simple-git refuses shows up here.
    if (error instanceof GitPluginError && error.plugin === "unsafe") {
      throw new BlockedEnvVarError(error.message);
    }
    // Otherwise "fatal: not a git repository" - handled below.
  }
  if (!insideWorkTree) throw new NotAGitRepoError(dir);

  // GIT_SSH_COMMAND beats core.sshCommand, so drop our default if the repo
  // or the user's config already sets one.
  if (await hasSshCommandConfig(git)) git.env(cleanGitEnv(process.env, true));
  return git;
}

/** Reads one Git config value (any scope). Null if it isn't set. */
export async function readConfig(git: SimpleGit, key: string): Promise<string | null> {
  try {
    const value = (await git.raw(["config", "--get", key])).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Name of the checked-out branch, or null if HEAD is detached. */
export async function currentBranch(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.raw(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** First line of a Git error, without "fatal: " / "error: ". */
export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "Unknown error.";
  return line.replace(/^(fatal|error):\s*/, "");
}

/** Full commit id of a ref, or null if the ref doesn't exist. */
export async function resolveRef(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    return (await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

/** e.g. 20261101-142305-123 (UTC), sortable and safe in a ref name. */
function backupTimestamp(date = new Date()): string {
  const iso = date.toISOString(); // 2026-11-01T14:23:05.123Z
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${iso.slice(20, 23)}`;
}

/**
 * Saves `commit` as refs/branchguard/backup/<timestamp>-<what> before a ref
 * is moved, so the old position can always be restored. Never overwrites an
 * existing backup. Returns the backup ref's name.
 */
export async function createBackupRef(
  git: SimpleGit,
  what: string,
  commit: string,
): Promise<string> {
  const ref = `refs/branchguard/backup/${backupTimestamp()}-${what.replaceAll("/", "-")}`;
  // An empty old value makes update-ref fail if the ref already exists.
  await git.raw(["update-ref", "-m", "branchguard backup", ref, commit, ""]);
  return ref;
}

/** True if a push was rejected because the remote branch has commits we don't have. */
export function isPushRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(message);
}

/** Turns an error from a fetch or push into a RemoteProblem. */
export function remoteProblemFromError(error: unknown): RemoteProblem {
  if (error instanceof GitPluginError && error.plugin === "timeout") {
    return {
      kind: "timeout",
      detail: `No answer from the remote after ${GIT_TIMEOUT_MS / 1000} seconds.`,
    };
  }
  return classifyRemoteProblem(error instanceof Error ? error.message : String(error));
}

/** Git's version, and whether it has `merge-tree --write-tree` (2.38+). */
export async function gitVersion(
  git: SimpleGit,
): Promise<{ text: string; supportsMergeTree: boolean }> {
  const { major, minor, patch } = await git.version();
  return {
    text: `${major}.${minor}.${patch}`,
    supportsMergeTree: major > 2 || (major === 2 && minor >= 38),
  };
}

/** Counts commits in a range like "HEAD..origin/main". Null if a ref is missing. */
export async function countCommits(git: SimpleGit, range: string): Promise<number | null> {
  try {
    return Number((await git.raw(["rev-list", "--count", range])).trim());
  } catch {
    return null;
  }
}

// Sync: bring the latest main into the member's branch, but only after a
// dry run shows it merges cleanly. planSync() only looks; executeSync() merges.
import type { SimpleGit } from "simple-git";
import { diagnose, type Diagnosis } from "./diagnose.js";
import {
  authorsSinceSplit,
  predictConflicts,
  type ConflictHunk,
  type DryRunMethod,
} from "./dry-run.js";
import { describeSyncStep } from "./explain.js";
import {
  createBackupRef,
  currentBranch,
  isPushRejected,
  openRepo,
  readConfig,
  remoteProblemFromError,
  resolveRef,
  shortError,
} from "./git.js";
import type { RemoteProblem } from "./remote-problem.js";
import { cliRemoteOps, type RemoteOps, type RemoteOptions } from "./remote-ops.js";
import type { BackupRef } from "./start-task.js";

export type SyncRefusal =
  | "finishOperation"
  | "askCaptain"
  | "fixAccess"
  | "startTask"
  | "saveFirst"
  | "noIdentity"
  | "noMainOnRemote";

/** A file the dry run says would conflict, and who changed it on main. */
export interface SyncConflict {
  path: string;
  /** Authors of main's commits touching the file since the branch split. */
  authors: string[];
  /** The conflicting lines: yours = the branch, theirs = main. */
  hunks: ConflictHunk[];
}

export type { DryRunMethod };

export type SyncStep = { description: string } & (
  | { kind: "merge"; branch: string; target: string; commits: number }
  | { kind: "upload"; branch: string }
);

/** A Sync step before its description is added. */
export type SyncStepData = SyncStep extends infer S
  ? S extends SyncStep
    ? Omit<S, "description">
    : never
  : never;

export interface SyncOptions {
  mainBranch?: string;
  /** Force a dry-run method (tests); by default picked from the Git version. */
  dryRunMethod?: DryRunMethod;
  remoteOps?: RemoteOps;
}

export interface SyncPlan {
  dir: string;
  mainBranch: string;
  canRun: boolean;
  refusal?: SyncRefusal;
  /** Already has everything from origin/<main>. */
  upToDate: boolean;
  /** Non-empty when the dry run predicts conflicts; nothing will be merged. */
  conflicts: SyncConflict[];
  diagnosis: Diagnosis;
  branch: string;
  /** HEAD when planned; executeSync refuses to run if it moved. */
  head: string | null;
  /** The origin/<main> commit that was dry-run merged. */
  target: string | null;
  dryRunMethod: DryRunMethod | null;
  steps: SyncStep[];
}

export interface SyncResult {
  ok: boolean;
  completed: SyncStep[];
  failedStep?: SyncStep;
  error?: string;
  /** After a failed merge: true if the branch is back exactly where it was. */
  restored?: boolean;
  backups: BackupRef[];
  pushProblem?: RemoteProblem;
  pushRejected?: boolean;
}

function withDescription(data: SyncStepData): SyncStep {
  return { ...data, description: describeSyncStep(data) } as SyncStep;
}

function refusalFor(d: Diagnosis): SyncRefusal | null {
  switch (d.nextAction) {
    case "finishOperation":
    case "askCaptain":
    case "fixAccess":
    case "startTask":
      return d.nextAction;
  }
  if (d.dirtyFiles.length > 0) return "saveFirst";
  if (d.behindMain === null) return "noMainOnRemote";
  return null;
}

export async function planSync(dir: string, options: SyncOptions = {}): Promise<SyncPlan> {
  const mainBranch = options.mainBranch ?? "main";
  // Fetches, so origin/<main> is fresh.
  const diagnosis = await diagnose(dir, mainBranch, { remoteOps: options.remoteOps });
  const git = await openRepo(dir);
  const base: SyncPlan = {
    dir,
    mainBranch,
    canRun: false,
    upToDate: false,
    conflicts: [],
    diagnosis,
    branch: diagnosis.currentBranch ?? "",
    head: await resolveRef(git, "HEAD"),
    target: await resolveRef(git, `refs/remotes/origin/${mainBranch}`),
    dryRunMethod: null,
    steps: [],
  };

  const refusal = refusalFor(diagnosis);
  if (refusal) return { ...base, refusal };
  if (diagnosis.behindMain === 0) return { ...base, upToDate: true };
  if (!(await readConfig(git, "user.name")) || !(await readConfig(git, "user.email"))) {
    return { ...base, refusal: "noIdentity" };
  }
  const { head, target } = base;
  if (!head || !target) throw new Error("HEAD or origin/main disappeared while planning.");

  const dryRunMethod =
    options.dryRunMethod ?? (diagnosis.supportsMergeTree ? "mergeTree" : "worktree");
  const predicted = await predictConflicts(git, dir, head, target, dryRunMethod);
  if (predicted.length > 0) {
    const conflicts: SyncConflict[] = [];
    for (const { path, hunks } of predicted) {
      conflicts.push({ path, authors: await authorsSinceSplit(git, head, target, path), hunks });
    }
    return { ...base, dryRunMethod, conflicts };
  }

  const steps = [
    withDescription({
      kind: "merge",
      branch: base.branch,
      target,
      commits: diagnosis.behindMain ?? 0,
    }),
    withDescription({ kind: "upload", branch: base.branch }),
  ];
  return { ...base, canRun: true, dryRunMethod, steps };
}

/** True if `target` is now part of HEAD and no merge is left half-done. */
async function mergeFinished(git: SimpleGit, target: string): Promise<boolean> {
  if ((await resolveRef(git, "MERGE_HEAD")) !== null) return false;
  try {
    return (await git.raw(["merge-base", "HEAD", target])).trim() === target;
  } catch {
    return false;
  }
}

/** Undoes a failed merge: abort it, then put the branch back on the backup. */
async function restoreBranch(git: SimpleGit, backupCommit: string): Promise<boolean> {
  if ((await resolveRef(git, "MERGE_HEAD")) !== null) {
    await git.raw(["merge", "--abort"]).catch(() => undefined);
  }
  if ((await resolveRef(git, "HEAD")) !== backupCommit) {
    // --keep refuses to throw away local changes; the tree was clean before.
    await git.raw(["reset", "--keep", backupCommit]).catch(() => undefined);
  }
  return (
    (await resolveRef(git, "HEAD")) === backupCommit &&
    (await resolveRef(git, "MERGE_HEAD")) === null
  );
}

async function runMerge(
  git: SimpleGit,
  plan: SyncPlan,
  step: Extract<SyncStep, { kind: "merge" }>,
  result: SyncResult,
): Promise<void> {
  const before = plan.head ?? "";
  const ref = await createBackupRef(git, step.branch, before);
  result.backups.push({ ref, of: step.branch });

  let failure: unknown = null;
  try {
    await git.raw([
      "merge",
      "--no-edit",
      "-m",
      `Merge ${plan.mainBranch} into ${step.branch}`,
      step.target,
    ]);
  } catch (error) {
    failure = error;
  }
  // A conflict doesn't always reject, so check the outcome itself.
  if (failure === null && (await mergeFinished(git, step.target))) return;

  result.restored = await restoreBranch(git, before);
  throw failure ?? new Error("Git stopped the merge because of a conflict.");
}

export async function executeSync(
  plan: SyncPlan,
  options: RemoteOptions = {},
): Promise<SyncResult> {
  if (!plan.canRun) throw new Error("This plan was refused and can't be executed.");
  const git = await openRepo(plan.dir);
  const remoteOps = options.remoteOps ?? cliRemoteOps(git);
  const result: SyncResult = { ok: false, completed: [], backups: [] };

  const unchanged =
    (await resolveRef(git, "HEAD")) === plan.head &&
    (await currentBranch(git)) === plan.branch &&
    (await git.status()).isClean();
  if (!unchanged) {
    return {
      ...result,
      failedStep: plan.steps[0],
      error: "Your repo changed since the plan was made.",
    };
  }

  for (const step of plan.steps) {
    try {
      if (step.kind === "merge") {
        await runMerge(git, plan, step, result);
      } else {
        // Never main, never --force.
        if (step.branch === plan.mainBranch) throw new Error("Refusing to push to main.");
        await remoteOps.push(step.branch, { setUpstream: true });
      }
      result.completed.push(step);
    } catch (error) {
      result.failedStep = step;
      result.error = shortError(error);
      if (step.kind === "upload") {
        if (isPushRejected(error)) result.pushRejected = true;
        else result.pushProblem = remoteProblemFromError(error);
      }
      return result;
    }
  }
  return { ...result, ok: true };
}

// Start task: give the member their own branch for a new task.
// planStartTask() only looks; executeStartTask() makes the changes.
import type { SimpleGit } from "simple-git";
import { diagnose, type Diagnosis } from "./diagnose.js";
import {
  createBackupRef,
  currentBranch,
  openRepo,
  readConfig,
  remoteProblemFromError,
  resolveRef,
  shortError,
} from "./git.js";
import { describeStartTaskStep } from "./explain.js";
import type { RemoteProblem } from "./remote-problem.js";
import { cliRemoteOps, type RemoteOps, type RemoteOptions } from "./remote-ops.js";

/** Repo-local config key holding the member's name (the branch prefix). */
export const MEMBER_NAME_KEY = "branchguard.name";
const DEFAULT_TASK = "work";
const MAX_SLUG_LENGTH = 40;

export type StartTaskRefusal =
  | "finishOperation"
  | "askCaptain"
  | "fixAccess"
  | "saveFirst"
  | "noMainOnRemote";

export type StartTaskStep = { description: string } & (
  | { kind: "saveName"; name: string }
  | {
      kind: "createBranch";
      branch: string;
      /** Commit the branch starts at. */
      startPoint: string;
      /** True: start at HEAD and keep the member's work; false: fresh from origin/<main>. */
      carry: boolean;
      carriedFiles: number;
      carriedCommits: number;
    }
  | { kind: "moveMain"; from: string; to: string }
  /** Clean start only. Skipped silently if it can't be done when executing. */
  | { kind: "fastForwardMain"; from: string; to: string }
  | { kind: "push"; branch: string }
);

export interface StartTaskPlan {
  dir: string;
  mainBranch: string;
  canRun: boolean;
  refusal?: StartTaskRefusal;
  diagnosis: Diagnosis;
  /** Empty when refused. */
  memberName: string;
  /** True if the name isn't saved in the repo yet (the UI may ask for it). */
  nameIsNew: boolean;
  branch: string;
  steps: StartTaskStep[];
  /** HEAD when planned; executeStartTask refuses to run if it moved. */
  head: string | null;
}

export interface StartTaskOptions {
  taskName?: string;
  /** Overrides the saved/suggested member name. */
  memberName?: string;
  /** Plan even if the remote can't be reached (Save commits locally anyway). */
  allowUnreachableRemote?: boolean;
  remoteOps?: RemoteOps;
  mainBranch?: string;
}

export interface BackupRef {
  ref: string;
  /** What was backed up, e.g. "main". */
  of: string;
}

export interface StartTaskResult {
  /** True if every step ran (the push included). */
  ok: boolean;
  completed: StartTaskStep[];
  /** The step that failed, if any. Nothing after it ran. */
  failedStep?: StartTaskStep;
  /** Why it failed: Git's message, or the reason we stopped. */
  error?: string;
  /** Set when the push failed. The local branch is kept. */
  pushProblem?: RemoteProblem;
  backups: BackupRef[];
}

/** "Alice Smith" -> "alice-smith". Empty if nothing usable is left. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
}

/** The saved member name, and a suggestion (from user.name) if there is none. */
export async function readMemberName(
  dir: string,
): Promise<{ saved: string | null; suggestion: string }> {
  const git = await openRepo(dir);
  return readMemberNameWith(git);
}

async function readMemberNameWith(
  git: SimpleGit,
): Promise<{ saved: string | null; suggestion: string }> {
  const saved = slugify((await readConfig(git, MEMBER_NAME_KEY)) ?? "") || null;
  const suggestion = slugify((await readConfig(git, "user.name")) ?? "") || "me";
  return { saved, suggestion };
}

function refusalFor(d: Diagnosis, options: StartTaskOptions): StartTaskRefusal | null {
  if (d.nextAction === "finishOperation") return "finishOperation";
  if (d.nextAction === "askCaptain") return "askCaptain";
  if (!d.canReachRemote && !options.allowUnreachableRemote) return "fixAccess";
  if (!d.onMain && d.dirtyFiles.length > 0) return "saveFirst";
  if (d.behindMain === null) return "noMainOnRemote";
  return null;
}

async function branchExists(git: SimpleGit, branch: string): Promise<boolean> {
  return (
    (await resolveRef(git, `refs/heads/${branch}`)) !== null ||
    (await resolveRef(git, `refs/remotes/origin/${branch}`)) !== null
  );
}

/** True if `ancestor` can be fast-forwarded to `descendant` (and they differ). */
async function canFastForward(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return false;
  try {
    return (await git.raw(["merge-base", ancestor, descendant])).trim() === ancestor;
  } catch {
    return false;
  }
}

/** True if `branch` is checked out in a worktree other than `dir`'s. */
async function checkedOutElsewhere(git: SimpleGit, branch: string): Promise<boolean> {
  const top = (await git.revparse(["--show-toplevel"])).trim();
  const list = await git.raw(["worktree", "list", "--porcelain"]);
  let worktree = "";
  for (const line of list.split("\n")) {
    if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && worktree !== top) return true;
  }
  return false;
}

/** `base`, or `base-2`, `base-3`, ... whichever is free locally and on origin. */
async function freeBranchName(git: SimpleGit, base: string): Promise<string> {
  if (!(await branchExists(git, base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!(await branchExists(git, candidate))) return candidate;
  }
}

/** A step before its description is added. */
export type StartTaskStepData = StartTaskStep extends infer S
  ? S extends StartTaskStep
    ? Omit<S, "description">
    : never
  : never;

function withDescription(data: StartTaskStepData): StartTaskStep {
  return { ...data, description: describeStartTaskStep(data) };
}

export async function planStartTask(
  dir: string,
  options: StartTaskOptions = {},
): Promise<StartTaskPlan> {
  const mainBranch = options.mainBranch ?? "main";
  // Fetches, so origin/<main> is fresh.
  const diagnosis = await diagnose(dir, mainBranch, { remoteOps: options.remoteOps });
  const refusal = refusalFor(diagnosis, options);
  if (refusal) {
    return {
      dir,
      mainBranch,
      canRun: false,
      refusal,
      diagnosis,
      memberName: "",
      nameIsNew: false,
      branch: "",
      steps: [],
      head: null,
    };
  }

  const git = await openRepo(dir);
  const { saved, suggestion } = await readMemberNameWith(git);
  const memberName = slugify(options.memberName ?? "") || saved || suggestion;
  const task = slugify(options.taskName ?? "") || DEFAULT_TASK;
  const branch = await freeBranchName(git, `${memberName}/${task}`);

  const head = await resolveRef(git, "HEAD");
  const originMain = await resolveRef(git, `refs/remotes/origin/${mainBranch}`);
  const localMain = await resolveRef(git, `refs/heads/${mainBranch}`);
  if (!head || !originMain) throw new Error("HEAD or origin/main disappeared while planning.");

  const carriedCommits = diagnosis.onMain ? (diagnosis.unpushedCommitsOnMain ?? 0) : 0;
  const carriedFiles = diagnosis.onMain ? diagnosis.dirtyFiles.length : 0;
  const carry = carriedCommits > 0 || carriedFiles > 0;

  const steps: StartTaskStep[] = [];
  if (saved !== memberName) steps.push(withDescription({ kind: "saveName", name: memberName }));
  steps.push(
    withDescription({
      kind: "createBranch",
      branch,
      startPoint: carry ? head : originMain,
      carry,
      carriedFiles,
      carriedCommits,
    }),
  );
  if (carry && localMain && localMain !== originMain) {
    steps.push(withDescription({ kind: "moveMain", from: localMain, to: originMain }));
  }
  if (
    !carry &&
    localMain &&
    (await canFastForward(git, localMain, originMain)) &&
    !(await checkedOutElsewhere(git, mainBranch))
  ) {
    steps.push(withDescription({ kind: "fastForwardMain", from: localMain, to: originMain }));
  }
  steps.push(withDescription({ kind: "push", branch }));

  return {
    dir,
    mainBranch,
    canRun: true,
    diagnosis,
    memberName,
    nameIsNew: saved !== memberName,
    branch,
    steps,
    head,
  };
}

/** Throws if the repo changed since planning in a way that makes the plan unsafe. */
async function checkUnchanged(git: SimpleGit, plan: StartTaskPlan): Promise<void> {
  if ((await resolveRef(git, "HEAD")) !== plan.head) {
    throw new Error("Your repo changed since the plan was made (new commit or branch switch).");
  }
  if ((await currentBranch(git)) !== plan.diagnosis.currentBranch) {
    throw new Error("You switched branches since the plan was made.");
  }
  const create = plan.steps.find((step) => step.kind === "createBranch");
  if (create && !create.carry && !(await git.status()).isClean()) {
    throw new Error("You have new unsaved changes since the plan was made.");
  }
}

/** Runs one Start task step. Also used by Save when it starts from main. */
export async function runStartTaskStep(
  git: SimpleGit,
  plan: StartTaskPlan,
  step: StartTaskStep,
  backups: BackupRef[],
  remoteOps: RemoteOps,
): Promise<void> {
  switch (step.kind) {
    case "saveName":
      await git.raw(["config", "--local", MEMBER_NAME_KEY, step.name]);
      return;
    case "createBranch":
      // Carry: branch from HEAD, the working tree (unsaved changes) stays as is.
      // Fresh: the tree is clean, so switching can't lose anything.
      await git.raw(
        step.carry ? ["switch", "-c", step.branch] : ["switch", "-c", step.branch, step.startPoint],
      );
      return;
    case "moveMain":
    case "fastForwardMain": {
      const mainRef = `refs/heads/${plan.mainBranch}`;
      if ((await currentBranch(git)) === plan.mainBranch) {
        throw new Error(`Still on ${plan.mainBranch}, so it can't be moved safely.`);
      }
      const ref = await createBackupRef(git, plan.mainBranch, step.from);
      backups.push({ ref, of: plan.mainBranch });
      // The old value makes this fail if main moved since the plan was made.
      await git.raw(["update-ref", "-m", "branchguard: start task", mainRef, step.to, step.from]);
      return;
    }
    case "push":
      if (step.branch === plan.mainBranch) throw new Error("Refusing to push to main.");
      await remoteOps.push(step.branch, { setUpstream: true });
      return;
  }
}

export async function executeStartTask(
  plan: StartTaskPlan,
  options: RemoteOptions = {},
): Promise<StartTaskResult> {
  if (!plan.canRun) throw new Error("This plan was refused and can't be executed.");
  const git = await openRepo(plan.dir);
  const remoteOps = options.remoteOps ?? cliRemoteOps(git);
  const result: StartTaskResult = { ok: false, completed: [], backups: [] };

  try {
    await checkUnchanged(git, plan);
  } catch (error) {
    return { ...result, failedStep: plan.steps[0], error: shortError(error) };
  }

  for (const step of plan.steps) {
    try {
      await runStartTaskStep(git, plan, step, result.backups, remoteOps);
      result.completed.push(step);
    } catch (error) {
      // Updating main on a clean start is a bonus: skip it silently.
      if (step.kind === "fastForwardMain") continue;
      result.failedStep = step;
      if (step.kind === "push") {
        result.pushProblem = remoteProblemFromError(error);
        result.error = result.pushProblem.detail;
      } else {
        result.error = shortError(error);
      }
      return result;
    }
  }
  return { ...result, ok: true };
}

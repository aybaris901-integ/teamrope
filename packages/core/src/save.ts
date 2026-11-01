// Save: commit the member's work and upload it to their own branch.
// planSave() only looks; applySaveChoices() is pure; executeSave() changes things.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { diagnose, type Diagnosis } from "./diagnose.js";
import { describeSaveStep } from "./explain.js";
import {
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
import {
  findRiskyFiles,
  gitignoreEntry,
  isCoveredBy,
  type ChangedFile,
  type RiskyFile,
} from "./risky-files.js";
import {
  planStartTask,
  runStartTaskStep,
  type BackupRef,
  type StartTaskPlan,
  type StartTaskRefusal,
  type StartTaskStep,
} from "./start-task.js";

export type SaveRefusal = "finishOperation" | "askCaptain" | "noIdentity" | StartTaskRefusal;

/** Start task steps (when saving from main), then Save's own steps. */
export type SaveStep =
  | Exclude<StartTaskStep, { kind: "push" }>
  | ({ description: string } & (
      | { kind: "ignore"; entries: string[] }
      | {
          kind: "commit";
          /** Every path to stage, including old names of renamed files. */
          paths: string[];
          /** The files as shown to the user. */
          files: string[];
          message: string;
        }
      | { kind: "upload"; branch: string }
    ));

/** A Save step before its description is added. */
export type SaveStepData = SaveStep extends infer S
  ? S extends SaveStep
    ? Omit<S, "description">
    : never
  : never;

export interface SaveOptions {
  /** Commit message; generated from the file names if not given. */
  message?: string;
  /** Passed to Start task when saving from main. */
  memberName?: string;
  taskName?: string;
  mainBranch?: string;
  remoteOps?: RemoteOps;
}

export interface SavePlan {
  dir: string;
  repoRoot: string;
  mainBranch: string;
  canRun: boolean;
  refusal?: SaveRefusal;
  /** No changes and nothing waiting to be uploaded. */
  nothingToSave: boolean;
  diagnosis: Diagnosis;
  /** Set when saving from main: Save first moves the work to a new branch. */
  startTask: StartTaskPlan | null;
  /** The branch that gets the commit and the upload. */
  branch: string;
  files: ChangedFile[];
  risky: RiskyFile[];
  /** Per risky path: true to include it in the commit. Defaults to false. */
  choices: Record<string, boolean>;
  /** Left-out secrets that can go into .gitignore (untracked, not ignored yet). */
  ignorableSecrets: string[];
  /** Per ignorable secret: false to keep it out of .gitignore. Defaults to true. */
  ignoreChoices: Record<string, boolean>;
  /** The user's -m message, if any. */
  message: string | null;
  /** The team repo's copy of the branch has commits we don't have: no upload. */
  uploadBlocked: boolean;
  steps: SaveStep[];
  /** HEAD when planned; executeSave refuses to run if it moved. */
  head: string | null;
}

export interface SaveResult {
  ok: boolean;
  completed: SaveStep[];
  failedStep?: SaveStep;
  error?: string;
  /** The upload failed (e.g. no access). The commit is kept. */
  pushProblem?: RemoteProblem;
  /** The upload was rejected: the remote branch has commits we don't have. */
  pushRejected?: boolean;
  backups: BackupRef[];
}

const GITIGNORE = ".gitignore";
const PATHSPEC_CHUNK = 200;

/** "Update a", "Update a and b", "Update a and 3 other files". */
export function commitMessageFor(files: string[]): string {
  const [first, second] = files;
  if (first === undefined) return "Update files";
  if (files.length === 1) return `Update ${first}`;
  if (files.length === 2) return `Update ${first} and ${second}`;
  return `Update ${first} and ${files.length - 1} other files`;
}

function withDescription(data: SaveStepData): SaveStep {
  return { ...data, description: describeSaveStep(data) } as SaveStep;
}

function hasUnuploadedCommits(d: Diagnosis): boolean {
  if (d.onMain) return (d.unpushedCommitsOnMain ?? 0) > 0;
  // No upstream: the branch isn't on the team repo yet.
  return d.aheadOfUpstream === null || d.aheadOfUpstream > 0;
}

/** Rebuilds the steps from the plan's files, risky files and choices. */
function buildSteps(plan: SavePlan): SaveStep[] {
  const steps: SaveStep[] = (plan.startTask?.steps ?? [])
    .filter((step): step is Exclude<StartTaskStep, { kind: "push" }> => step.kind !== "push");

  const leftOut = plan.risky.filter((risky) => !plan.choices[risky.path]);
  const ignoreEntries = [
    ...new Set(leftOut.filter((risky) => willIgnore(plan, risky)).map(gitignoreEntry)),
  ];
  if (ignoreEntries.length > 0) {
    steps.push(withDescription({ kind: "ignore", entries: ignoreEntries }));
  }

  const kept = plan.files.filter((file) => !leftOut.some((risky) => isCoveredBy(file.path, risky)));
  const files = kept.map((file) => file.path);
  const paths = kept.flatMap((file) => (file.from ? [file.path, file.from] : [file.path]));
  if (ignoreEntries.length > 0 && !files.includes(GITIGNORE)) {
    files.push(GITIGNORE);
    paths.push(GITIGNORE);
  }
  if (files.length > 0) {
    const message = plan.message ?? commitMessageFor(files);
    steps.push(withDescription({ kind: "commit", paths, files, message }));
  }

  const somethingToUpload =
    files.length > 0 || plan.startTask !== null || hasUnuploadedCommits(plan.diagnosis);
  if (somethingToUpload && !plan.uploadBlocked) {
    steps.push(withDescription({ kind: "upload", branch: plan.branch }));
  }
  return steps;
}

/**
 * True for an everyday save a UI may run without asking: commit and upload to
 * the member's own branch that's already on the team repo, no risky files.
 * Anything else (first upload, new branch, risky files) should be confirmed.
 */
export function isPlainSave(plan: SavePlan): boolean {
  return (
    plan.canRun &&
    plan.startTask === null &&
    plan.risky.length === 0 &&
    plan.diagnosis.aheadOfUpstream !== null && // has an upstream: not a first upload
    plan.steps.every((step) => step.kind === "commit" || step.kind === "upload")
  );
}

/**
 * Applies the user's answers about risky files: `include` per risky path, and
 * `ignore` per left-out secret. Pure: changes nothing on disk.
 */
export function applySaveChoices(
  plan: SavePlan,
  include: Record<string, boolean>,
  ignore: Record<string, boolean> = {},
): SavePlan {
  const next = {
    ...plan,
    choices: { ...plan.choices, ...include },
    ignoreChoices: { ...plan.ignoreChoices, ...ignore },
  };
  return { ...next, steps: buildSteps(next) };
}

/** True if a left-out risky file goes into .gitignore. */
export function willIgnore(plan: SavePlan, risky: RiskyFile): boolean {
  if (risky.kind !== "secret") return true;
  return plan.ignorableSecrets.includes(risky.path) && plan.ignoreChoices[risky.path] !== false;
}

/**
 * Secrets that .gitignore can cover: untracked ones. They're never ignored
 * already, because `git status` doesn't list ignored untracked files.
 */
function ignorableSecrets(risky: RiskyFile[]): string[] {
  return risky.filter((file) => file.kind === "secret" && !file.tracked).map((file) => file.path);
}

async function changedFiles(git: SimpleGit, repoRoot: string): Promise<ChangedFile[]> {
  const status = await git.status();
  return status.files.map((file) => ({
    path: file.path,
    ...(file.from && file.from !== file.path ? { from: file.from } : {}),
    untracked: file.index === "?",
    deleted: !existsSync(path.join(repoRoot, file.path)),
  }));
}

export async function planSave(dir: string, options: SaveOptions = {}): Promise<SavePlan> {
  const mainBranch = options.mainBranch ?? "main";
  const diagnosis = await diagnose(dir, mainBranch, { remoteOps: options.remoteOps });
  const git = await openRepo(dir);
  const repoRoot = (await git.revparse(["--show-toplevel"])).trim();
  const files = await changedFiles(git, repoRoot);

  const base: SavePlan = {
    dir,
    repoRoot,
    mainBranch,
    canRun: false,
    nothingToSave: false,
    diagnosis,
    startTask: null,
    branch: diagnosis.currentBranch ?? "",
    files,
    risky: [],
    choices: {},
    ignorableSecrets: [],
    ignoreChoices: {},
    message: options.message?.trim() || null,
    uploadBlocked: false,
    steps: [],
    head: await resolveRef(git, "HEAD"),
  };

  if (diagnosis.nextAction === "finishOperation" || diagnosis.nextAction === "askCaptain") {
    return { ...base, refusal: diagnosis.nextAction };
  }
  if (files.length === 0 && !hasUnuploadedCommits(diagnosis)) {
    return { ...base, nothingToSave: true };
  }
  if (files.length > 0) {
    const identity = (await readConfig(git, "user.name")) && (await readConfig(git, "user.email"));
    if (!identity) return { ...base, refusal: "noIdentity" };
  }

  let startTask: StartTaskPlan | null = null;
  if (diagnosis.onMain) {
    startTask = await planStartTask(dir, {
      taskName: options.taskName,
      memberName: options.memberName,
      mainBranch,
      allowUnreachableRemote: true, // commit locally even without access
      remoteOps: options.remoteOps,
    });
    if (!startTask.canRun) return { ...base, refusal: startTask.refusal };
  }

  const risky = findRiskyFiles(repoRoot, files);
  const plan: SavePlan = {
    ...base,
    canRun: true,
    startTask,
    branch: startTask ? startTask.branch : base.branch,
    risky,
    ignorableSecrets: ignorableSecrets(risky),
    uploadBlocked: !diagnosis.onMain && (diagnosis.behindUpstream ?? 0) > 0,
  };
  return { ...plan, steps: buildSteps(plan) };
}

function appendToGitignore(repoRoot: string, entries: string[]): void {
  const file = path.join(repoRoot, GITIGNORE);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${existing}${separator}${missing.join("\n")}\n`);
}

/** Literal, repo-root-relative pathspecs: no globbing, works from any subfolder. */
function pathspecs(paths: string[]): string[] {
  return paths.map((p) => `:(top,literal)${p}`);
}

async function commitExactly(git: SimpleGit, paths: string[], message: string): Promise<void> {
  for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
    await git.raw(["add", "--all", "--", ...pathspecs(paths.slice(i, i + PATHSPEC_CHUNK))]);
  }
  // Unstage anything staged earlier that isn't in the plan (e.g. a secret).
  const staged = (await git.raw(["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean);
  const extra = staged.filter((file) => !paths.includes(file));
  if (extra.length > 0) {
    await git.raw(["restore", "--staged", "--", ...pathspecs(extra)]);
  }
  await git.raw(["commit", "--quiet", "-m", message]);
}

async function runSaveStep(
  git: SimpleGit,
  plan: SavePlan,
  step: SaveStep,
  backups: BackupRef[],
  remoteOps: RemoteOps,
): Promise<void> {
  switch (step.kind) {
    case "ignore":
      appendToGitignore(plan.repoRoot, step.entries);
      return;
    case "commit":
      await commitExactly(git, step.paths, step.message);
      return;
    case "upload":
      // Never main, never --force: a rejected push is reported, not overridden.
      if (step.branch === plan.mainBranch) throw new Error("Refusing to push to main.");
      await remoteOps.push(step.branch, { setUpstream: true });
      return;
    default:
      if (!plan.startTask) throw new Error("Start task step without a Start task plan.");
      await runStartTaskStep(git, plan.startTask, step, backups, remoteOps);
  }
}

export async function executeSave(
  plan: SavePlan,
  options: RemoteOptions = {},
): Promise<SaveResult> {
  if (!plan.canRun) throw new Error("This plan was refused and can't be executed.");
  const git = await openRepo(plan.dir);
  const remoteOps = options.remoteOps ?? cliRemoteOps(git);
  const result: SaveResult = { ok: false, completed: [], backups: [] };

  if (
    (await resolveRef(git, "HEAD")) !== plan.head ||
    (await currentBranch(git)) !== plan.diagnosis.currentBranch
  ) {
    return {
      ...result,
      failedStep: plan.steps[0],
      error: "Your repo changed since the plan was made (new commit or branch switch).",
    };
  }

  for (const step of plan.steps) {
    try {
      await runSaveStep(git, plan, step, result.backups, remoteOps);
      result.completed.push(step);
    } catch (error) {
      if (step.kind === "fastForwardMain") continue; // a bonus, skip silently
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

// Team status: who is on which branch, who is behind main, whose work would
// conflict. Read-only: the only thing it changes is the remote-tracking refs,
// via `git fetch --prune`.
import type { SimpleGit } from "simple-git";
import { authorsSinceSplit, predictConflicts, type DryRunMethod } from "./dry-run.js";
import { fetchOrigin, gitVersion, openRepo, resolveRef } from "./git.js";
import type { RemoteProblem } from "./remote-problem.js";

/** Branches with an upload in this window are "active". */
export const ACTIVE_HOURS = 24;
/** Active branches without an upload for this long are flagged. */
export const STALE_HOURS = 2;
/** Branches this many commits behind main are flagged. */
export const FAR_BEHIND_COMMITS = 5;

const HOUR_MS = 60 * 60 * 1000;
const REMOTE_PREFIX = "refs/remotes/origin/";

export interface MainConflict {
  path: string;
  /** Who changed the file on main since the branch split off. */
  mainAuthors: string[];
}

export interface RemoteBranch {
  branch: string;
  /** Name prefix before "/", or the last author if there is none. */
  owner: string;
  /** Date of the newest commit on the branch: the best guess at the last upload. */
  lastUpload: Date;
  /** Commits not in main yet. */
  ahead: number;
  /** Commits on main the branch doesn't have. */
  behind: number;
  conflictsWithMain: MainConflict[];
  active: boolean;
}

export interface BranchOverlap {
  branches: [string, string];
  owners: [string, string];
  files: string[];
}

export type TeamProblem =
  | { kind: "conflictWithMain"; branch: string; owner: string; conflicts: MainConflict[] }
  | { kind: "overlap"; overlap: BranchOverlap }
  | { kind: "noRecentUpload"; branch: string; owner: string; hours: number }
  | { kind: "farBehind"; branch: string; owner: string; behind: number };

export interface TeamStatus {
  mainBranch: string;
  now: Date;
  canReachRemote: boolean;
  remoteProblem: RemoteProblem | null;
  /** Uploaded in the last ACTIVE_HOURS, sorted by owner then branch. */
  branches: RemoteBranch[];
  /** Older branches, shown collapsed. */
  oldBranches: RemoteBranch[];
  /** Pairs of active branches that would conflict with each other. */
  overlaps: BranchOverlap[];
  /** Most urgent first. Empty when everyone's work combines cleanly. */
  problems: TeamProblem[];
}

export interface TeamStatusOptions {
  mainBranch?: string;
  /** For tests: the current time. */
  now?: Date;
  /** For tests: force a dry-run method; by default picked from the Git version. */
  dryRunMethod?: DryRunMethod;
}

interface RefInfo {
  branch: string;
  ref: string;
  date: Date;
  author: string;
}

async function listRemoteBranches(git: SimpleGit, mainBranch: string): Promise<RefInfo[]> {
  const output = await git.raw([
    "for-each-ref",
    "--format=%(refname)%09%(committerdate:unix)%09%(authorname)",
    REMOTE_PREFIX,
  ]);
  const refs: RefInfo[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref = "", unix = "0", author = ""] = line.split("\t");
    const branch = ref.slice(REMOTE_PREFIX.length);
    if (branch === "HEAD" || branch === mainBranch) continue;
    refs.push({ branch, ref, date: new Date(Number(unix) * 1000), author });
  }
  return refs;
}

async function aheadBehind(git: SimpleGit, main: string, ref: string): Promise<[number, number]> {
  const [behind = "0", ahead = "0"] = (
    await git.raw(["rev-list", "--left-right", "--count", `${main}...${ref}`])
  )
    .trim()
    .split(/\s+/);
  return [Number(ahead), Number(behind)];
}

function ownerOf(info: RefInfo): string {
  const slash = info.branch.indexOf("/");
  return slash > 0 ? info.branch.slice(0, slash) : info.author;
}

async function describeBranch(
  git: SimpleGit,
  dir: string,
  info: RefInfo,
  main: string,
  method: DryRunMethod,
  now: Date,
): Promise<RemoteBranch> {
  const [ahead, behind] = await aheadBehind(git, main, info.ref);
  const conflictsWithMain: MainConflict[] = [];
  // Only a branch with its own commits that's also behind can conflict.
  if (ahead > 0 && behind > 0) {
    for (const { path } of await predictConflicts(git, dir, info.ref, main, method)) {
      conflictsWithMain.push({
        path,
        mainAuthors: await authorsSinceSplit(git, info.ref, main, path),
      });
    }
  }
  return {
    branch: info.branch,
    owner: ownerOf(info),
    lastUpload: info.date,
    ahead,
    behind,
    conflictsWithMain,
    active: now.getTime() - info.date.getTime() < ACTIVE_HOURS * HOUR_MS,
  };
}

/**
 * Every pair of active branches that would conflict. Files that already
 * conflict with main are left out: that's main's problem, not an overlap.
 */
async function findOverlaps(
  git: SimpleGit,
  dir: string,
  branches: RemoteBranch[],
  method: DryRunMethod,
): Promise<BranchOverlap[]> {
  const candidates = branches.filter((b) => b.ahead > 0);
  const overlaps: BranchOverlap[] = [];
  for (const [i, a] of candidates.entries()) {
    for (const b of candidates.slice(i + 1)) {
      const viaMain = new Set([...a.conflictsWithMain, ...b.conflictsWithMain].map((c) => c.path));
      const predicted = await predictConflicts(
        git,
        dir,
        `${REMOTE_PREFIX}${a.branch}`,
        `${REMOTE_PREFIX}${b.branch}`,
        method,
      );
      const files = predicted.map((c) => c.path).filter((file) => !viaMain.has(file));
      if (files.length > 0) {
        overlaps.push({ branches: [a.branch, b.branch], owners: [a.owner, b.owner], files });
      }
    }
  }
  return overlaps;
}

function findProblems(branches: RemoteBranch[], overlaps: BranchOverlap[], now: Date): TeamProblem[] {
  const problems: TeamProblem[] = [];
  for (const b of branches) {
    if (b.conflictsWithMain.length > 0) {
      problems.push({ kind: "conflictWithMain", branch: b.branch, owner: b.owner, conflicts: b.conflictsWithMain });
    }
  }
  for (const overlap of overlaps) problems.push({ kind: "overlap", overlap });
  for (const b of branches) {
    const hours = Math.floor((now.getTime() - b.lastUpload.getTime()) / HOUR_MS);
    if (hours >= STALE_HOURS) {
      problems.push({ kind: "noRecentUpload", branch: b.branch, owner: b.owner, hours });
    }
  }
  for (const b of branches) {
    if (b.behind >= FAR_BEHIND_COMMITS) {
      problems.push({ kind: "farBehind", branch: b.branch, owner: b.owner, behind: b.behind });
    }
  }
  return problems;
}

export async function teamStatus(dir: string, options: TeamStatusOptions = {}): Promise<TeamStatus> {
  const mainBranch = options.mainBranch ?? "main";
  const now = options.now ?? new Date();
  const git = await openRepo(dir);
  const remote = await fetchOrigin(git, { prune: true });

  const main = `${REMOTE_PREFIX}${mainBranch}`;
  if (!(await resolveRef(git, main))) {
    throw new Error(`The team repo has no ${mainBranch} branch yet, so there's nothing to compare with.`);
  }
  const method =
    options.dryRunMethod ?? ((await gitVersion(git)).supportsMergeTree ? "mergeTree" : "worktree");

  const all: RemoteBranch[] = [];
  for (const info of await listRemoteBranches(git, mainBranch)) {
    all.push(await describeBranch(git, dir, info, main, method, now));
  }
  all.sort((a, b) => a.owner.localeCompare(b.owner) || a.branch.localeCompare(b.branch));

  const branches = all.filter((b) => b.active);
  const overlaps = await findOverlaps(git, dir, branches, method);
  return {
    mainBranch,
    now,
    ...remote,
    branches,
    oldBranches: all.filter((b) => !b.active),
    overlaps,
    problems: findProblems(branches, overlaps, now),
  };
}

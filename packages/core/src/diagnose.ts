// diagnose(): a read-only snapshot of where the user stands in their repo.
// The only thing it changes is the remote-tracking refs, via `git fetch`.
import { existsSync } from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { countCommits, fetchOrigin, gitVersion, openRepo } from "./git.js";
import type { RemoteProblem } from "./remote-problem.js";

export type OperationInProgress = "merge" | "rebase" | "cherry-pick" | "revert";

export type NextAction =
  | "startTask"
  | "save"
  | "sync"
  | "finishOperation"
  | "askCaptain"
  | "fixAccess";

export interface Diagnosis {
  gitVersion: string;
  /** Git >= 2.38 can dry-run merges with `git merge-tree --write-tree`. */
  supportsMergeTree: boolean;
  /** Null when HEAD is detached. */
  currentBranch: string | null;
  onMain: boolean;
  detached: boolean;
  /** A merge/rebase/... that stopped halfway (e.g. on a conflict). */
  inProgress: OperationInProgress | null;
  /** Uncommitted files, including untracked ones. */
  dirtyFiles: string[];
  /** Files with unresolved conflicts (Git's unmerged list). Also in dirtyFiles. */
  conflictedFiles: string[];
  /** Vs the branch's own remote branch. Null if it has none. */
  aheadOfUpstream: number | null;
  behindUpstream: number | null;
  /** Commits on origin/<main> that HEAD doesn't have. Null if origin/<main> is missing. */
  behindMain: number | null;
  /** Local <main> commits not on origin/<main>. Null if either branch is missing. */
  unpushedCommitsOnMain: number | null;
  canReachRemote: boolean;
  /** Why the fetch failed, else null. */
  remoteProblem: RemoteProblem | null;
  /** The one thing the user should do next. Null if nothing is needed. */
  nextAction: NextAction | null;
}

/** Picks exactly one next action, most urgent first. */
export function pickNextAction(d: Omit<Diagnosis, "nextAction">): NextAction | null {
  if (d.inProgress) return "finishOperation";
  if (d.detached) return "askCaptain";
  if (!d.canReachRemote) return "fixAccess";
  if (d.onMain) return "startTask";
  if (d.dirtyFiles.length > 0) return "save";
  if (d.behindMain) return "sync";
  return null;
}

export async function diagnose(dir: string, mainBranch = "main"): Promise<Diagnosis> {
  const git = await openRepo(dir);
  const version = await gitVersion(git);

  // Fetch first so every count below uses the latest remote state.
  const remote = await fetchOrigin(git);
  const status = await git.status();

  const upstream = status.tracking;
  const originMain = `refs/remotes/origin/${mainBranch}`;
  const localMain = `refs/heads/${mainBranch}`;

  const facts: Omit<Diagnosis, "nextAction"> = {
    gitVersion: version.text,
    supportsMergeTree: version.supportsMergeTree,
    currentBranch: status.detached ? null : status.current,
    onMain: !status.detached && status.current === mainBranch,
    detached: status.detached,
    inProgress: await operationInProgress(git, dir),
    dirtyFiles: status.files.map((file) => file.path),
    conflictedFiles: status.conflicted,
    aheadOfUpstream: upstream ? await countCommits(git, `${upstream}..HEAD`) : null,
    behindUpstream: upstream ? await countCommits(git, `HEAD..${upstream}`) : null,
    behindMain: await countCommits(git, `HEAD..${originMain}`),
    unpushedCommitsOnMain: await countCommits(git, `${originMain}..${localMain}`),
    ...remote,
  };
  return { ...facts, nextAction: pickNextAction(facts) };
}

// Files Git keeps in .git while an operation is unfinished. Rebase comes
// first: it can leave other *_HEAD files behind while it runs.
const IN_PROGRESS_MARKERS: Array<[string, OperationInProgress]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["MERGE_HEAD", "merge"],
];

async function operationInProgress(
  git: SimpleGit,
  dir: string,
): Promise<OperationInProgress | null> {
  const args = IN_PROGRESS_MARKERS.flatMap(([marker]) => ["--git-path", marker]);
  // Paths are printed relative to dir, one per marker.
  const paths = (await git.revparse(args)).split("\n");
  for (const [i, [, operation]] of IN_PROGRESS_MARKERS.entries()) {
    const markerPath = paths[i];
    if (markerPath && existsSync(path.resolve(dir, markerPath.trim()))) return operation;
  }
  return null;
}



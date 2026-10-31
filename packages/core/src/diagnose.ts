// diagnose(): a read-only snapshot of where the user stands in their repo.
// The only thing it changes is the remote-tracking refs, via `git fetch`.
import { GitPluginError, type SimpleGit } from "simple-git";
import { countCommits, GIT_TIMEOUT_MS, openRepo } from "./git.js";
import { classifyRemoteProblem, type RemoteProblem } from "./remote-problem.js";

export interface Diagnosis {
  gitVersion: string;
  /** Git >= 2.38 can dry-run merges with `git merge-tree --write-tree`. */
  supportsMergeTree: boolean;
  /** Null when HEAD is detached. */
  currentBranch: string | null;
  onMain: boolean;
  detached: boolean;
  /** Uncommitted files, including untracked ones. */
  dirtyFiles: string[];
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
}

export async function diagnose(dir: string, mainBranch = "main"): Promise<Diagnosis> {
  const git = await openRepo(dir);
  const version = await git.version();

  // Fetch first so every count below uses the latest remote state.
  const remote = await fetchOrigin(git);
  const status = await git.status();

  const upstream = status.tracking;
  const originMain = `refs/remotes/origin/${mainBranch}`;
  const localMain = `refs/heads/${mainBranch}`;

  return {
    gitVersion: `${version.major}.${version.minor}.${version.patch}`,
    supportsMergeTree: version.major > 2 || (version.major === 2 && version.minor >= 38),
    currentBranch: status.detached ? null : status.current,
    onMain: !status.detached && status.current === mainBranch,
    detached: status.detached,
    dirtyFiles: status.files.map((file) => file.path),
    aheadOfUpstream: upstream ? await countCommits(git, `${upstream}..HEAD`) : null,
    behindUpstream: upstream ? await countCommits(git, `HEAD..${upstream}`) : null,
    behindMain: await countCommits(git, `HEAD..${originMain}`),
    unpushedCommitsOnMain: await countCommits(git, `${originMain}..${localMain}`),
    ...remote,
  };
}

async function fetchOrigin(
  git: SimpleGit,
): Promise<Pick<Diagnosis, "canReachRemote" | "remoteProblem">> {
  try {
    await git.raw(["fetch", "--quiet", "origin"]);
    return { canReachRemote: true, remoteProblem: null };
  } catch (error) {
    return { canReachRemote: false, remoteProblem: toRemoteProblem(error) };
  }
}

function toRemoteProblem(error: unknown): RemoteProblem {
  if (error instanceof GitPluginError && error.plugin === "timeout") {
    return {
      kind: "timeout",
      detail: `No answer from the remote after ${GIT_TIMEOUT_MS / 1000} seconds.`,
    };
  }
  return classifyRemoteProblem(error instanceof Error ? error.message : String(error));
}

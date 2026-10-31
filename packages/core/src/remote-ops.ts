// Talking to the team repo (fetch and push) behind one small interface, so a
// UI can route it through its own Git integration. VS Code, for example,
// holds the GitHub sign-in token and only gives it to its own Git calls.
import type { SimpleGit } from "simple-git";
import { remoteProblemFromError } from "./git.js";
import type { RemoteProblem } from "./remote-problem.js";

/**
 * Fetch and push for the repo's "origin". Implementations throw on failure
 * with an Error whose message carries Git's own output, so core can classify
 * it (remoteProblemFromError, isPushRejected). They must never force-push.
 */
export interface RemoteOps {
  fetch(options: { prune?: boolean }): Promise<void>;
  push(branch: string, options: { setUpstream: boolean }): Promise<void>;
}

/** Whether origin could be reached, and why not. */
export interface RemoteState {
  canReachRemote: boolean;
  remoteProblem: RemoteProblem | null;
}

/** For execute functions: how to reach the team repo. Default: the git CLI. */
export interface RemoteOptions {
  remoteOps?: RemoteOps;
}

/** The default: the git command line, with core's non-interactive env and timeout. */
export function cliRemoteOps(git: SimpleGit): RemoteOps {
  return {
    async fetch({ prune }) {
      // --prune only drops remote-tracking refs of branches deleted on origin.
      await git.raw(["fetch", "--quiet", ...(prune ? ["--prune"] : []), "origin"]);
    },
    async push(branch, { setUpstream }) {
      await git.raw(["push", ...(setUpstream ? ["--set-upstream"] : []), "origin", branch]);
    },
  };
}

/** Fetches origin. Never throws: a failure is reported as a RemoteProblem. */
export async function fetchOrigin(
  git: SimpleGit,
  options: { prune?: boolean; remoteOps?: RemoteOps } = {},
): Promise<RemoteState> {
  const ops = options.remoteOps ?? cliRemoteOps(git);
  try {
    await ops.fetch({ prune: options.prune ?? false });
    return { canReachRemote: true, remoteProblem: null };
  } catch (error) {
    return { canReachRemote: false, remoteProblem: remoteProblemFromError(error) };
  }
}

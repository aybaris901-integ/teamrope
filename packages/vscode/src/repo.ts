// Which folder we work on, and how we reach its team repo.
import type { RemoteOps } from "@teamrope/core";
import * as vscode from "vscode";
import type { GitApi, GitApiRepository } from "./git-api.js";

/** Text core's classifier recognizes, for VS Code Git errors that come without stderr. */
const ERROR_CODE_TEXT: Record<string, string> = {
  PushRejected: "Updates were rejected because the remote contains work that you do not have locally.",
  AuthenticationFailed: "Authentication failed",
  RemoteConnectionError: "Could not connect to server",
  NoRemoteRepositorySpecified: "'origin' does not appear to be a git repository",
  PermissionDenied: "Permission denied (publickey)",
};

interface VsCodeGitError {
  message?: string;
  stderr?: string;
  gitErrorCode?: string;
}

/** Rethrows a VS Code Git error with Git's output in the message, for core to classify. */
function toCoreError(error: unknown): Error {
  const e = (error ?? {}) as VsCodeGitError;
  const parts = [e.stderr, e.gitErrorCode ? ERROR_CODE_TEXT[e.gitErrorCode] : undefined, e.message];
  return new Error(parts.filter((part): part is string => Boolean(part)).join("\n") || String(error));
}

/** Fetch and push through VS Code's Git, which has the user's GitHub sign-in. Never forces. */
function vscodeRemoteOps(repository: GitApiRepository): RemoteOps {
  return {
    async fetch({ prune }) {
      try {
        await repository.fetch({ remote: "origin", prune: prune ?? false });
      } catch (error) {
        throw toCoreError(error);
      }
    },
    async push(branch, { setUpstream }) {
      try {
        await repository.push("origin", branch, setUpstream);
      } catch (error) {
        throw toCoreError(error);
      }
    },
  };
}

export interface RepoContext {
  dir: string;
  /** Undefined: VS Code doesn't know this repo, core uses the git CLI. */
  remoteOps: RemoteOps | undefined;
}

/** The active file's workspace folder, else the first folder. */
export function activeFolder(): vscode.WorkspaceFolder | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  return folder ?? vscode.workspace.workspaceFolders?.[0];
}

export function repoContext(gitApi: GitApi | undefined): RepoContext | undefined {
  const folder = activeFolder();
  if (!folder) return undefined;
  const repository = gitApi?.getRepository(folder.uri) ?? null;
  return {
    dir: folder.uri.fsPath,
    remoteOps: repository ? vscodeRemoteOps(repository) : undefined,
  };
}

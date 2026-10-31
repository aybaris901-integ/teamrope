// The small part of VS Code's built-in Git extension API (vscode.git) we use.
// Full types: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
import * as vscode from "vscode";

export interface GitApiRepository {
  readonly rootUri: vscode.Uri;
  fetch(options?: { remote?: string; prune?: boolean }): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface GitApi {
  readonly git: { readonly path: string };
  getRepository(uri: vscode.Uri): GitApiRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/** VS Code's Git API, or undefined if the Git extension is missing or disabled. */
export async function getGitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) return undefined;
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.enabled ? exports.getAPI(1) : undefined;
}

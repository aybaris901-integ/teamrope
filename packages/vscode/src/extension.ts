// branchguard for VS Code: a thin UI over @branchguard/core.
import { configureGit } from "@branchguard/core";
import * as vscode from "vscode";
import { Actions } from "./actions.js";
import { getGitApi } from "./git-api.js";
import { BranchguardState } from "./state.js";
import { createStatusBar } from "./status-bar.js";
import { errorMessage, Output } from "./ui.js";
import { ActionsView, TeamView, YouView } from "./views.js";

const SAVE_DEBOUNCE_MS = 1500;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = new Output();
  context.subscriptions.push(output.channel);

  // Use the same git as VS Code; core falls back to "git" on PATH.
  const gitApi = await getGitApi().catch(() => undefined);
  const { binary } = configureGit({ binary: gitApi?.git.path });
  output.log(`Using git: ${binary}${gitApi ? "" : " (VS Code's Git extension isn't available)"}`);

  const state = new BranchguardState(gitApi, (line) => output.log(line));
  const actions = new Actions(state, output);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("branchguard.you", new YouView(state)),
    vscode.window.registerTreeDataProvider("branchguard.actions", new ActionsView(state)),
    vscode.window.registerTreeDataProvider("branchguard.team", new TeamView(state)),
    createStatusBar(state),
  );

  /** Every command: errors become a plain message (details in the Output channel). */
  const command = (id: string, run: (...args: never[]) => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          await run(...args);
        } catch (error) {
          const message = errorMessage(error);
          output.log(`${id} failed: ${message}`);
          void vscode.window.showErrorMessage(message);
        }
      }),
    );
  };
  command("branchguard.startTask", () => actions.startTask());
  command("branchguard.save", () => actions.save());
  command("branchguard.sync", () => actions.sync());
  command("branchguard.teamStatus", () => actions.teamStatus());
  command("branchguard.runNext", () => actions.runNext());
  command("branchguard.showProblem", (line: string) => actions.showProblem(line));
  command("branchguard.refresh", () => state.refresh("force"));

  // Saving a file: refresh without the network, debounced.
  let saveTimer: NodeJS.Timeout | undefined;
  let lastDir = state.context()?.dir;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void state.refresh("local"), SAVE_DEBOUNCE_MS);
    }),
    // Coming back to the window: fetch if the last fetch is over 2 minutes old.
    vscode.window.onDidChangeWindowState((window) => {
      if (window.focused) void state.refresh("auto");
    }),
    // Multi-root: switching to a file in another folder switches repos.
    vscode.window.onDidChangeActiveTextEditor(() => {
      const dir = state.context()?.dir;
      if (dir !== lastDir) {
        lastDir = dir;
        void state.refresh("auto");
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void state.refresh("auto")),
    { dispose: () => clearTimeout(saveTimer) },
  );

  await state.refresh("auto");
}

export function deactivate(): void {}

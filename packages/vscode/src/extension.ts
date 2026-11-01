// branchguard for VS Code: a thin UI over @branchguard/core.
import { configureGit, fileAtRef } from "@branchguard/core";
import * as vscode from "vscode";
import { Actions } from "./actions.js";
import { Avatars } from "./avatars.js";
import { getGitApi } from "./git-api.js";
import { BranchguardState } from "./state.js";
import { createStatusBar } from "./status-bar.js";
import { GIT_SCHEME } from "./problem-actions.js";
import { errorMessage, Output } from "./ui.js";
import { ActivityView, TeamView } from "./views.js";
import { YouView } from "./you-view.js";

const SAVE_DEBOUNCE_MS = 1500;
const WALKTHROUGH_SHOWN = "branchguard.walkthroughShown";
const TEAM_OPENED_FOR_CAPTAIN = "branchguard.teamOpenedForCaptain";

type Role = "captain" | "member";

function role(): Role {
  return vscode.workspace.getConfiguration("branchguard").get<Role>("role", "member");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = new Output();
  context.subscriptions.push(output.channel);

  // Use the same git as VS Code; core falls back to "git" on PATH.
  const gitApi = await getGitApi().catch(() => undefined);
  const { binary } = configureGit({ binary: gitApi?.git.path });
  output.log(`Using git: ${binary}${gitApi ? "" : " (VS Code's Git extension isn't available)"}`);

  const state = new BranchguardState(gitApi, (line) => output.log(line));
  const actions = new Actions(state, output);

  const avatars = new Avatars(context.globalStorageUri);
  const you = new YouView(context.extensionUri, state, (problem, action) => {
    const id = { compare: "branchguard.compare", copy: "branchguard.copyMessage", details: "branchguard.showProblem" }[action];
    void vscode.commands.executeCommand(id, problem);
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("branchguard.you", you),
    vscode.window.registerTreeDataProvider("branchguard.team", new TeamView(state, avatars)),
    vscode.window.registerTreeDataProvider("branchguard.activity", new ActivityView(state, avatars)),
    // Read-only "file at a ref" documents for Compare.
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      async provideTextDocumentContent(uri) {
        const query = new URLSearchParams(uri.query);
        const content = await fileAtRef(query.get("dir") ?? "", query.get("ref") ?? "", query.get("file") ?? "");
        return content ?? "";
      },
    }),
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
  command("branchguard.showProblem", (problem: never) => actions.showProblem(problem));
  command("branchguard.copyMessage", (target: never) => actions.copyMessage(target));
  command("branchguard.compare", (target: never) => actions.compare(target));
  command("branchguard.refresh", () => state.refresh("force"));
  const walkthroughId = `${context.extension.id}#getStarted`;
  command("branchguard.openWalkthrough", async () => {
    await vscode.commands.executeCommand("workbench.action.openWalkthrough", walkthroughId, false);
  });
  command("branchguard.setRole", async (value: never) => {
    const chosen: Role = value === "captain" ? "captain" : "member";
    await vscode.workspace.getConfiguration("branchguard").update("role", chosen, vscode.ConfigurationTarget.Global);
  });

  // Team starts collapsed (manifest); a captain gets it opened once.
  const openTeamForCaptain = async (): Promise<void> => {
    if (role() !== "captain" || context.globalState.get(TEAM_OPENED_FOR_CAPTAIN)) return;
    await context.globalState.update(TEAM_OPENED_FOR_CAPTAIN, true);
    await vscode.commands.executeCommand("branchguard.team.focus");
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("branchguard.role")) void openTeamForCaptain();
    }),
  );

  // First install: show the walkthrough once, in a window the user is looking
  // at. Activation can run while the window is still restoring (or in another
  // window, right after install), so the flag is only set once it opened.
  const showWalkthroughOnce = async (): Promise<void> => {
    if (context.globalState.get(WALKTHROUGH_SHOWN) || !vscode.window.state.focused) return;
    try {
      await vscode.commands.executeCommand("workbench.action.openWalkthrough", walkthroughId, false);
      await context.globalState.update(WALKTHROUGH_SHOWN, true);
    } catch (error) {
      output.log(`Couldn't open the walkthrough: ${errorMessage(error)}`);
    }
  };

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
      if (!window.focused) return;
      void showWalkthroughOnce();
      void state.refresh("auto");
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
  await showWalkthroughOnce();
  if (state.dir && !state.noRepo) await openTeamForCaptain();
}

export function deactivate(): void {}

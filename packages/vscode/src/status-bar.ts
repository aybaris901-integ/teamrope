// Status bar item: "Next: Save" or "All good"; clicking runs the next step.
import { explainDiagnosis, shortNextAction } from "@branchguard/core";
import * as vscode from "vscode";
import type { BranchguardState } from "./state.js";

/** Next actions that need a person, not a button: shown as a warning. */
const NEEDS_ATTENTION = new Set(["finishOperation", "askCaptain", "fixAccess"]);

export function createStatusBar(state: BranchguardState): vscode.Disposable {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = "branchguard.runNext";

  const update = (): void => {
    const d = state.diagnosis;
    if (!d || state.noRepo) {
      bar.hide();
      return;
    }
    const short = shortNextAction(d);
    bar.text = short ? `$(shield) Next: ${short}` : "$(shield) All good";
    bar.tooltip = explainDiagnosis(d).next;
    bar.backgroundColor =
      d.nextAction && NEEDS_ATTENTION.has(d.nextAction)
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    bar.show();
  };

  const listener = state.onDidChange(update);
  update();
  return vscode.Disposable.from(bar, listener);
}

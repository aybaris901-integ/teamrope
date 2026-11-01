// Status bar: "Conflict in <file>", "1 to share", "Next: Sync", "In sync".
import { explainDiagnosis, statusBarSummary, type StatusBarKind } from "@branchguard/core";
import * as vscode from "vscode";
import type { BranchguardState } from "./state.js";

const LOOK: Record<StatusBarKind, { icon: string; command: string; background?: string }> = {
  conflict: { icon: "$(error)", command: "branchguard.sync", background: "statusBarItem.errorBackground" },
  toShare: { icon: "$(cloud-upload)", command: "branchguard.save" },
  sync: { icon: "$(sync)", command: "branchguard.sync" },
  attention: { icon: "$(warning)", command: "branchguard.runNext", background: "statusBarItem.warningBackground" },
  inSync: { icon: "$(check)", command: "branchguard.runNext" },
};

export function createStatusBar(state: BranchguardState): vscode.Disposable {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  const update = (): void => {
    const d = state.diagnosis;
    if (!d || state.noRepo || !state.active) {
      bar.hide();
      return;
    }
    const { kind, text } = statusBarSummary(d, state.mainConflicts);
    const look = LOOK[kind];
    bar.text = `${look.icon} ${text}`;
    bar.command = look.command;
    bar.tooltip = explainDiagnosis(d).next;
    bar.backgroundColor = look.background ? new vscode.ThemeColor(look.background) : undefined;
    bar.show();
  };

  const listener = state.onDidChange(update);
  update();
  return vscode.Disposable.from(bar, listener);
}

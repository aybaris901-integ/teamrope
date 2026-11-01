// "Syncing would conflict in src/config.js (alice)": shown once per file and
// pair of commits (mine + main), remembered per workspace so a refresh or a
// reload never shows it again. Shown even with editor hints off.
import { conflictNotice, type MainConflictPreview, type MyProblem } from "@teamrope/core";
import * as vscode from "vscode";
import type { TeamRopeState } from "./state.js";

const SHOWN_KEY = "teamrope.conflictsNotified";
const MAX_REMEMBERED = 100;

function noticeKey(conflict: MainConflictPreview): string {
  return `${conflict.path}@${conflict.commits.mine}:${conflict.commits.main}`;
}

export function watchConflicts(state: TeamRopeState, memory: vscode.Memento): vscode.Disposable {
  return state.onDidChange(() => {
    if (!state.active) return;
    const shown = memory.get<string[]>(SHOWN_KEY, []);
    const fresh = state.mainConflicts.filter((conflict) => !shown.includes(noticeKey(conflict)));
    if (fresh.length === 0) return;
    // Remember first, so a refresh while the notification is open can't repeat it.
    void memory.update(SHOWN_KEY, [...shown, ...fresh.map(noticeKey)].slice(-MAX_REMEMBERED));
    for (const conflict of fresh) void notify(conflict);
  });
}

async function notify(conflict: MainConflictPreview): Promise<void> {
  const problem: MyProblem = { kind: "mainConflict", conflict };
  const answer = await vscode.window.showErrorMessage(conflictNotice(conflict), "Compare", "Copy message");
  if (answer === "Compare") await vscode.commands.executeCommand("teamrope.compare", problem);
  if (answer === "Copy message") await vscode.commands.executeCommand("teamrope.copyMessage", problem);
}

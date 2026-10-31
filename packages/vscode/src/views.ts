// The sidebar: You, Actions and Team. All text comes from core's explain layer.
import {
  explainDiagnosis,
  explainOldBranches,
  explainTeamProblem,
  TEAM_STATUS_FOOTER,
  teamStatusTable,
  type NextAction,
} from "@branchguard/core";
import * as vscode from "vscode";
import type { BranchguardState } from "./state.js";

type Item = vscode.TreeItem & { children?: Item[] };

function item(label: string, options: Partial<Item> = {}): Item {
  // Long sentences get cut off in the tree, so the tooltip holds the full text.
  return Object.assign(new vscode.TreeItem(label), { tooltip: label, ...options });
}

function warning(message: string): Item {
  return item(message, { iconPath: new vscode.ThemeIcon("warning") });
}

abstract class Provider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(protected readonly state: BranchguardState) {
    state.onDidChange(() => this.changed.fire());
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Item): Item[] {
    return element ? (element.children ?? []) : this.roots();
  }

  protected abstract roots(): Item[];
}

/** The diagnose summary, with the next step first and highlighted. */
export class YouView extends Provider {
  protected roots(): Item[] {
    // No items: VS Code shows the welcome text (no folder / not a repo).
    if (this.state.noRepo || !this.state.dir) return [];
    if (this.state.error) return [warning(this.state.error)];
    const d = this.state.diagnosis;
    if (!d) return [item("Checking your repo…", { iconPath: new vscode.ThemeIcon("loading~spin") })];

    const { summary, next } = explainDiagnosis(d);
    const nextItem = item(next, {
      iconPath: new vscode.ThemeIcon(
        "arrow-right",
        new vscode.ThemeColor(d.nextAction ? "charts.yellow" : "charts.green"),
      ),
      command: { command: "branchguard.runNext", title: "Do the next step" },
    });
    return [nextItem, ...summary.map((line) => item(line))];
  }
}

const ACTIONS: Array<{ label: string; command: string; action: NextAction | "teamStatus" }> = [
  { label: "Start task", command: "branchguard.startTask", action: "startTask" },
  { label: "Save", command: "branchguard.save", action: "save" },
  { label: "Sync", command: "branchguard.sync", action: "sync" },
  { label: "Team status", command: "branchguard.teamStatus", action: "teamStatus" },
];

/** The four buttons; the one diagnose suggests is starred. */
export class ActionsView extends Provider {
  protected roots(): Item[] {
    if (this.state.noRepo || !this.state.dir) return [];
    const next = this.state.diagnosis?.nextAction;
    return ACTIONS.map(({ label, command, action }) =>
      item(label, {
        description: action === next ? "next" : undefined,
        iconPath: new vscode.ThemeIcon(
          action === next ? "star-full" : "circle-outline",
          action === next ? new vscode.ThemeColor("charts.yellow") : undefined,
        ),
        command: { command, title: label },
      }),
    );
  }
}

/** Team problems (clickable), then the branch table, collapsed. */
export class TeamView extends Provider {
  protected roots(): Item[] {
    if (this.state.noRepo || !this.state.dir) return [];
    if (this.state.teamError) return [warning(this.state.teamError)];
    const status = this.state.team;
    if (!status) return [item("Checking the team…", { iconPath: new vscode.ThemeIcon("loading~spin") })];

    const items: Item[] = [];
    if (status.problems.length === 0) {
      items.push(
        item("No problems. Everyone's work combines cleanly.", {
          iconPath: new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green")),
        }),
      );
    }
    for (const problem of status.problems) {
      const line = explainTeamProblem(problem, status.mainBranch);
      items.push(
        item(line, {
          iconPath: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange")),
          command: { command: "branchguard.showProblem", title: "Show problem", arguments: [line] },
        }),
      );
    }

    const table = teamStatusTable(status);
    if (table.length > 0) {
      items.push(
        item("Branches", {
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          iconPath: new vscode.ThemeIcon("git-branch"),
          children: table.map((row) => item(row)),
        }),
      );
    }
    const old = explainOldBranches(status);
    if (old) items.push(item(old, { iconPath: new vscode.ThemeIcon("archive") }));
    items.push(item(TEAM_STATUS_FOOTER, { iconPath: new vscode.ThemeIcon("info") }));
    return items;
  }
}

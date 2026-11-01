// Native views: TEAM (problems, then members) and ACTIVITY (latest commits).
// All text comes from core's explain layer.
import {
  ago,
  explainMyProblem,
  involvesMe,
  memberStatus,
  onePerPerson,
  shortProblemLabel,
  statusBarSummary,
  type MyProblem,
  type RemoteBranch,
} from "@branchguard/core";
import * as vscode from "vscode";
import type { Avatars } from "./avatars.js";
import { compareTargetFor } from "./problem-actions.js";
import type { BranchguardState } from "./state.js";

/** A tree item that may carry the problem it shows (for Compare / Copy message). */
export type Item = vscode.TreeItem & { children?: Item[]; problem?: MyProblem };

function item(label: string, options: Partial<Item> = {}): Item {
  // Long sentences get cut off in the tree, so the tooltip holds the full text.
  return Object.assign(new vscode.TreeItem(label), { tooltip: label, ...options });
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
    if (element) return element.children ?? [];
    if (this.state.noRepo || !this.state.dir || !this.state.active) return [];
    return this.roots();
  }

  protected abstract roots(): Item[];
}

const PROBLEM_ICONS: Record<MyProblem["kind"], vscode.ThemeIcon> = {
  mainConflict: new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")),
  overlapWithMe: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow")),
  team: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.orange")),
};

/** Problems first (each with Compare / Copy message), then one row per member. */
export class TeamView extends Provider {
  constructor(
    state: BranchguardState,
    private readonly avatars: Avatars,
  ) {
    super(state);
  }

  protected roots(): Item[] {
    const now = new Date();
    // Problems about me live in the You panel; Team shows everyone else's.
    const myBranch = this.state.diagnosis?.currentBranch ?? null;
    const others = this.state.problems.filter((p) => !involvesMe(p, myBranch, this.state.me));
    // One row per person: the most severe problem, the rest in the tooltip.
    const problems = onePerPerson(others, this.state.me).map(({ problem, more }) =>
      item(shortProblemLabel(problem), {
        tooltip: [explainMyProblem(problem, now), ...more.map((p) => `Also: ${explainMyProblem(p, now)}`)].join("\n\n"),
        iconPath: PROBLEM_ICONS[problem.kind],
        contextValue: compareTargetFor(problem) ? "problem copyable comparable" : "problem copyable",
        command: { command: "branchguard.showProblem", title: "Show details", arguments: [problem] },
        problem,
      }),
    );
    if (this.state.teamError) {
      problems.push(item(this.state.teamError, { iconPath: new vscode.ThemeIcon("warning") }));
    }
    return [...problems, ...this.members(now)];
  }

  private members(now: Date): Item[] {
    const byOwner = new Map<string, RemoteBranch[]>();
    for (const branch of this.state.team?.branches ?? []) {
      byOwner.set(branch.owner, [...(byOwner.get(branch.owner) ?? []), branch]);
    }
    return [...byOwner].map(([owner, branches]) => {
      const problem = this.state.problems.find(
        (p) => p.kind === "overlapWithMe" && p.overlap.owner === owner,
      );
      const d = this.state.diagnosis;
      const isMe = owner === this.state.me;
      return item(isMe ? `${owner} (you)` : owner, {
        iconPath: this.avatars.uri(owner),
        description:
          isMe && d
            ? statusBarSummary(d, this.state.mainConflicts).text
            : memberStatus(owner, branches, this.state.problems, now),
        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
        contextValue: problem ? "member copyable comparable" : "member",
        problem,
        children: branches.map((b) =>
          item(b.branch, {
            iconPath: new vscode.ThemeIcon("git-branch"),
            description: `+${b.ahead} / -${b.behind} · ${ago(b.lastSave, now)}`,
          }),
        ),
      });
    });
  }
}

/** The last few commits across the team repo's branches. */
export class ActivityView extends Provider {
  constructor(
    state: BranchguardState,
    private readonly avatars: Avatars,
  ) {
    super(state);
  }

  protected roots(): Item[] {
    const now = new Date();
    return this.state.activity.map((entry) =>
      item(`${entry.who} · ${entry.subject}`, {
        iconPath: this.avatars.uri(entry.who),
        description: `${entry.branch} · ${ago(entry.date, now)}`,
      }),
    );
  }
}

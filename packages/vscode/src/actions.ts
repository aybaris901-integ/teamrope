// The buttons, each as plan -> confirm -> execute, plus Compare and Copy message.
// All Git work is core's.
import {
  applySaveChoices,
  executeSave,
  executeStartTask,
  executeSync,
  explainDiagnosis,
  explainMyProblem,
  explainSavePlan,
  explainSaveRefusal,
  explainSaveResult,
  explainStartTaskRefusal,
  explainStartTaskResult,
  explainSyncRefusal,
  explainSyncResult,
  explainTeamStatus,
  isPlainSave,
  planSave,
  planStartTask,
  planSync,
  slugify,
  type MyProblem,
  type SavePlan,
} from "@branchguard/core";
import * as vscode from "vscode";
import { compareTargetFor, copyTextFor, refUri, type CompareSide } from "./problem-actions.js";
import type { RepoContext } from "./repo.js";
import type { BranchguardState } from "./state.js";
import {
  askMemberName,
  askShareMessage,
  askTaskName,
  chooseFilesToShare,
  confirmPlan,
  showExplanation,
  showResult,
  withProgress,
  type Output,
} from "./ui.js";
import type { Item } from "./views.js";

export class Actions {
  constructor(
    private readonly state: BranchguardState,
    private readonly output: Output,
  ) {}

  private requireRepo(): RepoContext | undefined {
    const ctx = this.state.context();
    if (!ctx) void vscode.window.showInformationMessage("Open your team's repo folder first.");
    return ctx;
  }

  async startTask(): Promise<void> {
    const ctx = this.requireRepo();
    if (!ctx) return;
    const taskName = await askTaskName();
    if (taskName === undefined) return;

    const options = { taskName, remoteOps: ctx.remoteOps };
    let plan = await withProgress("Checking your repo…", () => planStartTask(ctx.dir, options));
    if (!plan.canRun) {
      return showExplanation(this.output, "Start task", explainStartTaskRefusal(plan), "warning");
    }
    if (plan.nameIsNew) {
      const memberName = await askMemberName(plan.memberName);
      if (memberName === undefined) return;
      if (slugify(memberName) !== plan.memberName) {
        plan = await withProgress("Checking your repo…", () =>
          planStartTask(ctx.dir, { ...options, memberName }),
        );
      }
    }

    if (!(await confirmPlan("Start task: here's what I'll do", plan.steps.map((s) => s.description)))) return;
    const result = await withProgress("Starting your task…", () =>
      executeStartTask(plan, { remoteOps: ctx.remoteOps }),
    );
    await this.state.refresh("force");
    await showResult(this.output, "Start task", explainStartTaskResult(plan, result), result.ok);
  }

  /** Share changes: pick files (1/2), write the message (2/2), then commit and upload. */
  async save(): Promise<void> {
    const ctx = this.requireRepo();
    if (!ctx) return;
    const options = { remoteOps: ctx.remoteOps };
    let plan: SavePlan | undefined = await withProgress("Checking your changes…", () =>
      planSave(ctx.dir, options),
    );
    if (!plan.canRun) {
      const kind = plan.nothingToSave ? "info" : "warning";
      return showExplanation(this.output, "Share changes", explainSaveRefusal(plan), kind);
    }
    if (plan.startTask?.nameIsNew) {
      const memberName = await askMemberName(plan.startTask.memberName);
      if (memberName === undefined) return;
      if (slugify(memberName) !== plan.startTask.memberName) {
        plan = await withProgress("Checking your changes…", () =>
          planSave(ctx.dir, { ...options, memberName }),
        );
      }
    }

    plan = await chooseFilesToShare(plan);
    if (!plan) return;
    const commit = plan.steps.find((step) => step.kind === "commit");
    if (commit?.kind === "commit") {
      const message = await askShareMessage(commit.message);
      if (message === undefined) return;
      plan = applySaveChoices(plan, {}, {}, { message });
    }
    const notes = explainSavePlan(plan);
    if (plan.steps.length === 0) {
      return showExplanation(this.output, "Share changes", [...notes, "Nothing left to share."], "info");
    }

    // An everyday share to a branch already on the team repo runs without a dialog.
    const steps = plan.steps.map((step) => step.description);
    if (!isPlainSave(plan) && !(await confirmPlan("Share changes: here's what I'll do", steps, notes))) return;

    const ready = plan;
    const result = await withProgress("Sharing your changes…", () => executeSave(ready, options));
    await this.state.refresh("force");
    await showResult(this.output, "Share changes", [...notes, ...explainSaveResult(ready, result)], result.ok);
  }

  async sync(): Promise<void> {
    const ctx = this.requireRepo();
    if (!ctx) return;
    const options = { remoteOps: ctx.remoteOps };
    const plan = await withProgress("Checking whether main combines cleanly with your work…", () =>
      planSync(ctx.dir, options),
    );
    if (!plan.canRun) {
      const lines = explainSyncRefusal(plan);
      if (plan.conflicts.length > 0) return this.showConflict(lines);
      return showExplanation(this.output, "Sync", lines, plan.upToDate ? "info" : "warning");
    }

    if (!(await confirmPlan("Sync: here's what I'll do", plan.steps.map((s) => s.description)))) return;
    const result = await withProgress("Syncing…", () => executeSync(plan, options));
    await this.state.refresh("force");
    await showResult(this.output, "Sync", explainSyncResult(plan, result), result.ok);
  }

  /** Predicted conflict: the code goes to the Output channel, the gist to a modal. */
  private async showConflict(lines: string[]): Promise<void> {
    this.output.section("Sync", lines);
    this.output.channel.show(true);
    const gist = lines.filter((line) => !line.startsWith("  "));
    await vscode.window.showWarningMessage(gist[0] ?? "Sync", {
      modal: true,
      detail: gist.slice(1).join("\n\n") + "\n\nThe conflicting lines are in the branchguard output.",
    });
  }

  async teamStatus(): Promise<void> {
    if (!this.requireRepo()) return;
    await withProgress("Checking the team…", () => this.state.refresh("force"));
    await vscode.commands.executeCommand("branchguard.team.focus");
    const status = this.state.team;
    if (status) this.output.section("Team status", explainTeamStatus(status));
    else if (this.state.teamError) void vscode.window.showWarningMessage(this.state.teamError);
  }

  async showProblem(problem: MyProblem): Promise<void> {
    const line = explainMyProblem(problem, new Date());
    this.output.section("Problem", [line]);
    const buttons = compareTargetFor(problem) ? ["Compare", "Copy message"] : ["Copy message"];
    const answer = await vscode.window.showInformationMessage(line, { modal: true }, ...buttons);
    if (answer === "Compare") await this.compare(problem);
    if (answer === "Copy message") await this.copyMessage(problem);
  }

  /** Accepts a problem, or a tree item carrying one (inline actions pass the item). */
  async copyMessage(target: MyProblem | Item | undefined): Promise<void> {
    const problem = problemOf(target);
    if (!problem) return;
    await vscode.env.clipboard.writeText(copyTextFor(problem, this.state.diagnosis?.currentBranch ?? "my branch"));
    void vscode.window.showInformationMessage("Copied");
  }

  async compare(target: MyProblem | Item | undefined): Promise<void> {
    const problem = problemOf(target);
    const dir = this.state.dir;
    const compare = problem && compareTargetFor(problem);
    if (!compare || !dir) return;
    const uriFor = (side: CompareSide): vscode.Uri =>
      "workingTree" in side
        ? vscode.Uri.joinPath(vscode.Uri.file(dir), compare.path)
        : refUri(dir, side.ref, compare.path, side.label);
    const label = (side: CompareSide): string => ("workingTree" in side ? "yours" : side.label);
    await vscode.commands.executeCommand(
      "vscode.diff",
      uriFor(compare.left),
      uriFor(compare.right),
      `${compare.path}: ${label(compare.left)} ↔ ${label(compare.right)}`,
    );
  }

  /** Runs whatever diagnose suggests; for steps that need a person, explains them. */
  async runNext(): Promise<void> {
    const d = this.state.diagnosis;
    if (!d) return void vscode.window.showInformationMessage("Open your team's repo folder first.");
    switch (d.nextAction) {
      case "startTask":
        return this.startTask();
      case "save":
        return this.save();
      case "sync":
        return this.sync();
      case null:
        return void vscode.window.showInformationMessage(explainDiagnosis(d).next);
      default: {
        const { summary, next } = explainDiagnosis(d);
        this.output.section("Next step", [...summary, next]);
        await vscode.window.showWarningMessage(next, { modal: true, detail: summary.join("\n") });
      }
    }
  }
}

/** The problem a command was called with: directly, or on a tree item. */
function problemOf(target: MyProblem | Item | undefined): MyProblem | undefined {
  if (!target) return undefined;
  return target instanceof vscode.TreeItem ? (target as Item).problem : (target as MyProblem);
}

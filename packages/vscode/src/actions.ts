// The four buttons, each as plan -> confirm -> execute. All Git work is core's.
import {
  executeSave,
  executeStartTask,
  executeSync,
  explainDiagnosis,
  explainSavePlan,
  explainSaveRefusal,
  explainSaveResult,
  explainStartTaskRefusal,
  explainStartTaskResult,
  explainSyncRefusal,
  explainSyncResult,
  explainTeamStatus,
  planSave,
  planStartTask,
  planSync,
  slugify,
  type SavePlan,
} from "@branchguard/core";
import * as vscode from "vscode";
import type { RepoContext } from "./repo.js";
import type { BranchguardState } from "./state.js";
import {
  askAboutRiskyFiles,
  askMemberName,
  askTaskName,
  confirmPlan,
  showExplanation,
  showResult,
  withProgress,
  type Output,
} from "./ui.js";

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

  async save(): Promise<void> {
    const ctx = this.requireRepo();
    if (!ctx) return;
    const options = { remoteOps: ctx.remoteOps };
    let plan: SavePlan | undefined = await withProgress("Checking your work…", () =>
      planSave(ctx.dir, options),
    );
    if (!plan.canRun) {
      const kind = plan.nothingToSave ? "info" : "warning";
      return showExplanation(this.output, "Save", explainSaveRefusal(plan), kind);
    }
    if (plan.startTask?.nameIsNew) {
      const memberName = await askMemberName(plan.startTask.memberName);
      if (memberName === undefined) return;
      if (slugify(memberName) !== plan.startTask.memberName) {
        plan = await withProgress("Checking your work…", () =>
          planSave(ctx.dir, { ...options, memberName }),
        );
      }
    }
    plan = await askAboutRiskyFiles(plan);
    if (!plan) return;
    const notes = explainSavePlan(plan);
    if (plan.steps.length === 0) {
      return showExplanation(this.output, "Save", [...notes, "Nothing left to save."], "info");
    }

    // A plain save (commit + upload to their own branch) runs without a dialog.
    const plain =
      !plan.startTask &&
      plan.risky.length === 0 &&
      plan.steps.every((step) => step.kind === "commit" || step.kind === "upload");
    const steps = plan.steps.map((step) => step.description);
    if (!plain && !(await confirmPlan("Save: here's what I'll do", steps, notes))) return;

    const ready = plan;
    const result = await withProgress("Saving…", () => executeSave(ready, options));
    await this.state.refresh("force");
    await showResult(this.output, "Save", [...notes, ...explainSaveResult(ready, result)], result.ok);
  }

  async sync(): Promise<void> {
    const ctx = this.requireRepo();
    if (!ctx) return;
    const options = { remoteOps: ctx.remoteOps };
    const plan = await withProgress("Checking whether main merges cleanly…", () =>
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

  async showProblem(line: string): Promise<void> {
    this.output.section("Team problem", [line]);
    await vscode.window.showInformationMessage("Team problem", { modal: true, detail: line });
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

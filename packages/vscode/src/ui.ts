// Dialogs and messages. Prompts only: every decision is made by core.
import {
  applySaveChoices,
  riskyFileReason,
  secretIgnoreQuestion,
  slugify,
  type SavePlan,
} from "@branchguard/core";
import * as vscode from "vscode";

export class Output {
  readonly channel = vscode.window.createOutputChannel("branchguard");

  log(line: string): void {
    this.channel.appendLine(line);
  }

  section(title: string, lines: string[]): void {
    this.log("");
    this.log(`--- ${title} (${new Date().toLocaleTimeString()}) ---`);
    for (const line of lines) this.log(line);
  }
}

/** Plain message for an error: never a stack trace. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Modal with the plan in plain English; true on Continue. */
export async function confirmPlan(title: string, steps: string[], notes: string[] = []): Promise<boolean> {
  const detail = [...steps.map((step, i) => `${i + 1}. ${step}`), ...(notes.length ? ["", ...notes] : [])];
  const answer = await vscode.window.showInformationMessage(
    title,
    { modal: true, detail: detail.join("\n") },
    "Continue",
  );
  return answer === "Continue";
}

/** Asks for the branch-name prefix. Undefined if cancelled. */
export async function askMemberName(suggestion: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "branchguard",
    prompt: "What name should your branches start with?",
    value: suggestion,
    validateInput: (value) => (slugify(value) === "" ? "Use at least one letter or number." : undefined),
  });
}

/** Asks for an optional task name. Undefined if cancelled; "" means the default. */
export async function askTaskName(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "branchguard: Start task",
    prompt: "What are you working on? (optional, used in the branch name)",
    placeHolder: "work",
  });
}

/**
 * Risky files: checked = left out (core's safe default), then which left-out
 * secrets go into .gitignore. Undefined if cancelled.
 */
export async function askAboutRiskyFiles(plan: SavePlan): Promise<SavePlan | undefined> {
  if (plan.risky.length === 0) return plan;
  const picks = await vscode.window.showQuickPick(
    plan.risky.map((risky) => ({ label: risky.path, detail: riskyFileReason(risky), picked: true, risky })),
    {
      title: "branchguard: Save",
      placeHolder: "Checked files are left out of the save. Uncheck a file to include it anyway.",
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picks) return undefined;

  const leftOut = new Set(picks.map((pick) => pick.risky.path));
  const include = Object.fromEntries(plan.risky.map((r) => [r.path, !leftOut.has(r.path)]));
  const ignorable = plan.ignorableSecrets.filter((file) => leftOut.has(file));
  const ignore: Record<string, boolean> = {};
  if (ignorable.length > 0) {
    const chosen = await vscode.window.showQuickPick(
      ignorable.map((file) => ({ label: file, detail: secretIgnoreQuestion(file).question, picked: true })),
      {
        title: "branchguard: Save",
        placeHolder: "Add the checked files to .gitignore so Git never asks again?",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!chosen) return undefined;
    const ignored = new Set(chosen.map((pick) => pick.label));
    for (const file of ignorable) ignore[file] = ignored.has(file);
  }
  return applySaveChoices(plan, include, ignore);
}

/** Runs `task` behind a progress notification. */
export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

/** Short notification for a result; the full lines go to the Output channel. */
export async function showResult(output: Output, title: string, lines: string[], ok: boolean): Promise<void> {
  output.section(title, lines);
  const text = ok ? (lines.at(-1) ?? `${title}: done.`) : lines.slice(-2).join(" ");
  const show = ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
  if ((await show(text, "Show details")) === "Show details") output.channel.show(true);
}

/** A refusal or explanation: a short message, details in the Output channel. */
export async function showExplanation(output: Output, title: string, lines: string[], kind: "info" | "warning"): Promise<void> {
  output.section(title, lines);
  const show = kind === "info" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
  if ((await show(lines.join(" "), "Show details")) === "Show details") output.channel.show(true);
}

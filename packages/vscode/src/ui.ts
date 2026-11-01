// Dialogs and messages. Prompts only: every decision is made by core.
import {
  applySaveChoices,
  isCoveredBy,
  riskyFileReason,
  slugify,
  type RiskyFile,
  type SavePlan,
} from "@teamrope/core";
import * as vscode from "vscode";

export class Output {
  readonly channel = vscode.window.createOutputChannel("TeamRope");

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
    title: "TeamRope",
    prompt: "Your name (used for your branches)",
    placeHolder: "e.g. alice",
    value: suggestion,
    validateInput: (value) => (slugify(value) === "" ? "Use at least one letter or number." : undefined),
  });
}

/**
 * Asks for an optional task name. Undefined if cancelled; "" means the default.
 * `memberName`: the saved name, if any, to warn about alice/alice.
 */
export async function askTaskName(memberName: string | null): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "TeamRope: Start task",
    prompt: "What are you working on?",
    placeHolder: "e.g. login-page",
    validateInput: (value) =>
      memberName && slugify(value) === memberName
        ? {
            message: `That's your name, so the branch would be ${memberName}/${memberName}. I'll use "work" instead: ${memberName}/work.`,
            severity: vscode.InputBoxValidationSeverity.Warning,
          }
        : undefined,
  });
}

/**
 * Share changes (1/2): every changed file, ordinary ones checked; risky ones
 * (secrets, generated, large) unchecked with a warning and the reason.
 * Returns the plan with the choices applied, or undefined if cancelled.
 */
export async function chooseFilesToShare(plan: SavePlan): Promise<SavePlan | undefined> {
  type Pick = vscode.QuickPickItem & { risky?: RiskyFile; file?: string };
  const riskyItems: Pick[] = plan.risky.map((risky) => ({
    label: `$(warning) ${risky.path}`,
    description: riskyFileReason(risky),
    picked: false,
    risky,
  }));
  const fileItems: Pick[] = plan.files
    .filter((file) => !plan.risky.some((risky) => isCoveredBy(file.path, risky)))
    .map((file) => ({ label: file.path, description: file.untracked ? "new" : file.deleted ? "deleted" : undefined, picked: true, file: file.path }));
  if (riskyItems.length + fileItems.length === 0) return plan; // nothing to pick: upload only

  const picks = await vscode.window.showQuickPick([...fileItems, ...riskyItems], {
    title: "Share changes (1/2)",
    placeHolder: "Choose the files to share. Unchecked files stay on your computer.",
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (!picks) return undefined;
  const picked = new Set(picks);
  const include = Object.fromEntries(riskyItems.map((item) => [item.risky?.path ?? "", picked.has(item)]));
  const excludedFiles = fileItems.filter((item) => !picked.has(item)).map((item) => item.file ?? "");
  return applySaveChoices(plan, include, {}, { excludedFiles });
}

/** Share changes (2/2): the commit message, prefilled. Undefined if cancelled. */
export async function askShareMessage(suggestion: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: "Share changes (2/2)",
    prompt: "Describe your changes in a few words",
    value: suggestion,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === "" ? "Write a few words about your changes." : undefined),
  });
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

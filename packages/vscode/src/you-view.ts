// YOU: a small webview with one headline, one primary button and the details.
// Strict CSP, local codicons, colors only from --vscode-* variables (media/you.css).
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  explainMyProblem,
  headline,
  involvesMe,
  panelDetails,
  shortNextAction,
  type MyProblem,
  type Severity,
} from "@branchguard/core";
import * as vscode from "vscode";
import { compareTargetFor } from "./problem-actions.js";
import type { BranchguardState } from "./state.js";

interface ButtonModel {
  label: string;
  command: string;
  icon: string;
}

/** The full-width button under the headline; "secondary" when nothing is urgent. */
type MainButtonModel = ButtonModel & { style: "primary" | "secondary" };

/** What the page draws. Sent with postMessage; the page never builds text itself. */
type YouModel =
  | { state: "noFolder" | "noRepo" | "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      severity: Severity;
      sentence: string;
      primary?: MainButtonModel;
      secondary: ButtonModel[];
      problems: Array<{ index: number; text: string; kind: MyProblem["kind"]; canCompare: boolean }>;
      details: string[];
    };

type FromPage =
  | { type: "ready" }
  | { type: "run"; command: string }
  | { type: "problem"; index: number; action: "compare" | "copy" | "details" };

/** The only commands the page may run. */
const ALLOWED_COMMANDS = new Set([
  "branchguard.startTask",
  "branchguard.save",
  "branchguard.sync",
  "branchguard.runNext",
  "branchguard.refresh",
  "vscode.openFolder",
  "git.clone",
]);

const ACTIONS: ButtonModel[] = [
  { label: "Start task", command: "branchguard.startTask", icon: "add" },
  { label: "Share changes", command: "branchguard.save", icon: "cloud-upload" },
  { label: "Sync", command: "branchguard.sync", icon: "sync" },
];

const NEXT_COMMANDS: Record<string, string> = {
  startTask: "branchguard.startTask",
  save: "branchguard.save",
  sync: "branchguard.sync",
};

export class YouView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pageReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: BranchguardState,
    /** Called whenever the view is shown: opening it opts the workspace in. */
    private readonly onShown: () => void,
    private readonly onProblem: (problem: MyProblem, action: "compare" | "copy" | "details") => void,
  ) {
    state.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.pageReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: FromPage) => this.receive(message));
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.onShown();
      this.update();
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.onShown();
    this.update();
  }

  private receive(message: FromPage): void {
    if (message.type === "ready") {
      this.pageReady = true;
      this.update();
    } else if (message.type === "run" && ALLOWED_COMMANDS.has(message.command)) {
      void vscode.commands.executeCommand(message.command);
    } else if (message.type === "problem") {
      const problem = this.state.problems[message.index];
      if (problem) this.onProblem(problem, message.action);
    }
  }

  update(): void {
    const view = this.view;
    if (!view) return;
    view.description = this.state.dir ? path.basename(this.state.dir) : undefined;
    const d = this.state.diagnosis;
    const problems = this.state.problems.length;
    const toShare = d?.dirtyFiles.length ?? 0;
    view.badge =
      this.state.active && problems + toShare > 0
        ? { value: problems + toShare, tooltip: `${problems} problem(s), ${toShare} file(s) to share` }
        : undefined;
    if (this.pageReady) void view.webview.postMessage(this.model());
  }

  private model(): YouModel {
    const s = this.state;
    if (!s.dir) return { state: "noFolder" };
    if (s.noRepo) return { state: "noRepo" };
    if (s.error) return { state: "error", message: s.error };
    const d = s.diagnosis;
    if (!d) return { state: "loading" };

    const now = new Date();
    const { severity, sentence } = headline(d, s.problems, "main", Boolean(s.team));
    const nextCommand = d.nextAction ? NEXT_COMMANDS[d.nextAction] : undefined;
    // In sync: one quiet Start task button; Share and Sync stay in the "…" menu.
    const primary: MainButtonModel = nextCommand
      ? { label: shortNextAction(d) ?? "", command: nextCommand, icon: "arrow-right", style: "primary" }
      : d.nextAction
        ? { label: "What should I do?", command: "branchguard.runNext", icon: "question", style: "primary" }
        : { label: "Start task", command: "branchguard.startTask", icon: "add", style: "secondary" };
    return {
      state: "ready",
      severity,
      sentence,
      primary,
      secondary: primary.style === "secondary" ? [] : ACTIONS.filter((a) => a.command !== primary.command),
      // Only problems about me; everyone else's live in the Team view.
      problems: s.problems.flatMap((problem, index) =>
        involvesMe(problem, d.currentBranch, s.me)
          ? [{ index, text: explainMyProblem(problem, now), kind: problem.kind, canCompare: Boolean(compareTargetFor(problem)) }]
          : [],
      ),
      details: panelDetails(d),
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset("dist", "codicons", "codicon.css")}">
  <link rel="stylesheet" href="${asset("media", "you.css")}">
</head>
<body>
  <main id="root" aria-live="polite"></main>
  <script nonce="${nonce}" src="${asset("media", "you.js")}"></script>
</body>
</html>`;
  }
}

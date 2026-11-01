// YOU: a small webview with one headline, one primary button and the details.
// Strict CSP, local codicons, colors only from --vscode-* variables (media/you.css).
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  ago,
  buildTimeline,
  explainMyProblem,
  headline,
  involvesMe,
  panelDetails,
  shortNextAction,
  timelineAxis,
  timelineDuration,
  timelineRowSummary,
  timelineTitle,
  TIMELINE_WINDOW_MS,
  type Diagnosis,
  type MyProblem,
  type Severity,
  type TimelineRow,
} from "@teamrope/core";
import * as vscode from "vscode";
import { avatarColor, initials } from "./avatars.js";
import { compareTargetFor } from "./problem-actions.js";
import type { TeamRopeState } from "./state.js";

interface ButtonModel {
  label: string;
  command: string;
  icon: string;
}

/** The full-width button under the headline; "secondary" when nothing is urgent. */
type MainButtonModel = ButtonModel & { style: "primary" | "secondary" };

interface ProblemModel {
  index: number;
  text: string;
  kind: MyProblem["kind"];
  canCompare: boolean;
}

/** One person's line in the timeline. Positions are percent of the window (0 = oldest, 100 = now). */
interface TimelineRowModel {
  id: string;
  /** "you" for me, else the name; the page shows only the avatar when narrow. */
  label: string;
  initials: string;
  /** Neutral avatar color: never a status color. */
  color: string;
  isMe: boolean;
  summary: string;
  dots: Array<{ x: number; title: string }>;
  /** Me only: where my changes not shared yet start. */
  notShared?: number;
  /** Status shapes; x is 100 when the start is unknown. */
  shapes: Array<{ kind: "conflict" | "overlap"; x: number }>;
  duration: string;
  /** For narrow sidebars: "now" instead of "just now". */
  durationShort: string;
  card: { problems: ProblemModel[]; commits: string[]; sync?: ButtonModel };
}

interface TimelineModel {
  title: string;
  axis: string[];
  rows: TimelineRowModel[];
}

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
      problems: ProblemModel[];
      timeline: TimelineModel;
      details: string[];
    };

type FromPage =
  | { type: "ready" }
  | { type: "run"; command: string }
  | { type: "problem"; index: number; action: "compare" | "copy" | "details" };

/** The only commands the page may run. */
const ALLOWED_COMMANDS = new Set([
  "teamrope.startTask",
  "teamrope.save",
  "teamrope.sync",
  "teamrope.runNext",
  "teamrope.refresh",
  "vscode.openFolder",
  "git.clone",
]);

const ACTIONS: ButtonModel[] = [
  { label: "Start task", command: "teamrope.startTask", icon: "add" },
  { label: "Share changes", command: "teamrope.save", icon: "cloud-upload" },
  { label: "Sync", command: "teamrope.sync", icon: "sync" },
];

const NEXT_COMMANDS: Record<string, string> = {
  startTask: "teamrope.startTask",
  save: "teamrope.save",
  sync: "teamrope.sync",
};

export class YouView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private pageReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: TeamRopeState,
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
        ? { label: "What should I do?", command: "teamrope.runNext", icon: "question", style: "primary" }
        : { label: "Start task", command: "teamrope.startTask", icon: "add", style: "secondary" };
    return {
      state: "ready",
      severity,
      sentence,
      primary,
      secondary: primary.style === "secondary" ? [] : ACTIONS.filter((a) => a.command !== primary.command),
      // Only problems about me; everyone else's live in the Team view.
      problems: s.problems.flatMap((problem, index) =>
        involvesMe(problem, d.currentBranch, s.me) ? [this.problemModel(problem, index, now)] : [],
      ),
      timeline: this.timelineModel(d, now),
      details: panelDetails(d),
    };
  }

  private problemModel(problem: MyProblem, index: number, now: Date): ProblemModel {
    return { index, text: explainMyProblem(problem, now), kind: problem.kind, canCompare: Boolean(compareTargetFor(problem)) };
  }

  private timelineModel(d: Diagnosis, now: Date): TimelineModel {
    const s = this.state;
    const timeline = buildTimeline({
      now,
      me: s.me,
      commits: s.commits,
      team: s.team,
      problems: s.problems,
      notSharedSince: d.dirtyFiles.length > 0 ? s.notSharedSince : null,
    });
    const at = (date: Date): number => {
      const x = ((date.getTime() - timeline.start.getTime()) / TIMELINE_WINDOW_MS) * 100;
      return Math.round(Math.min(100, Math.max(0, x)) * 10) / 10;
    };
    const rowModel = (row: TimelineRow): TimelineRowModel => {
      const duration = row.problems.map((p) => timelineDuration(p, now)).find(Boolean) ?? "";
      const indexes = [...new Set(row.problems.flatMap((p) => p.problemIndexes))];
      return {
        id: row.person,
        label: row.isMe ? "you" : row.person,
        initials: initials(row.person),
        color: avatarColor(row.person),
        isMe: row.isMe,
        summary: timelineRowSummary(row, now, TIMELINE_WINDOW_MS),
        dots: row.commits.map((c) => ({ x: at(c.date), title: `${c.branch}: ${c.subject} · ${ago(c.date, now)}` })),
        notShared: row.notSharedSince ? at(row.notSharedSince) : undefined,
        shapes: row.problems.map((p) => ({ kind: p.kind, x: p.since ? at(p.since) : 100 })),
        duration,
        durationShort: duration === "just now" ? "now" : duration,
        card: {
          problems: indexes.flatMap((index) => {
            const problem = s.problems[index];
            return problem ? [this.problemModel(problem, index, now)] : [];
          }),
          commits: row.commits
            .slice(-3)
            .reverse()
            .map((c) => `${c.subject} · ${ago(c.date, now)}`),
          sync: row.isMe && d.nextAction === "sync" ? ACTIONS.find((a) => a.command === "teamrope.sync") : undefined,
        },
      };
    };
    return { title: timelineTitle(TIMELINE_WINDOW_MS), axis: timelineAxis(TIMELINE_WINDOW_MS), rows: timeline.rows.map(rowModel) };
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

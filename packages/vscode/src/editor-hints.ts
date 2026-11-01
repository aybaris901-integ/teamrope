// Hints where people work: file badges, a CodeLens over lines a teammate also
// changed, and the lines that would conflict with main. Everything reads the
// cached state (recomputed on file save), never Git: typing and scrolling stay
// free. Off in repos that haven't opted in, or with teamrope.editorHints off.
import path from "node:path";
import {
  conflictLineHint,
  explainMyProblem,
  overlapHints,
  overlapNames,
  overlapHintTitle,
  type MainConflictPreview,
  type MyProblem,
} from "@teamrope/core";
import * as vscode from "vscode";
import { initials } from "./avatars.js";
import type { TeamRopeState } from "./state.js";

export function editorHintsOn(): boolean {
  return vscode.workspace.getConfiguration("teamrope").get<boolean>("editorHints", true);
}

/** Badge letters: one person's initials, or the first letters of two people. */
function badgeLetters(names: string[]): string {
  if (names.length === 1) return initials(names[0] ?? "");
  return names
    .slice(0, 2)
    .map((name) => initials(name).charAt(0))
    .join("");
}

/** Where `lines` appear in the document, as 0-based line numbers; undefined if not found. */
function findLines(document: vscode.TextDocument, lines: string[]): number | undefined {
  const wanted = lines.map((line) => line.trimEnd());
  for (let start = 0; start + wanted.length <= document.lineCount; start++) {
    if (wanted.every((line, i) => document.lineAt(start + i).text.trimEnd() === line)) return start;
  }
  return undefined;
}

export class EditorHints implements vscode.FileDecorationProvider, vscode.CodeLensProvider {
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  /** File badges by absolute path, rebuilt when the state changes. */
  private badges = new Map<string, vscode.FileDecoration>();
  private readonly conflictLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  constructor(private readonly state: TeamRopeState) {}

  register(): vscode.Disposable {
    const update = (): void => this.update();
    return vscode.Disposable.from(
      vscode.window.registerFileDecorationProvider(this),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      this.conflictLine,
      this.state.onDidChange(update),
      vscode.window.onDidChangeVisibleTextEditors(() => this.drawConflictLines()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("teamrope.editorHints")) update();
      }),
    );
  }

  private on(): boolean {
    return this.state.active && Boolean(this.state.dir) && editorHintsOn();
  }

  private update(): void {
    this.badges = this.on() ? this.buildBadges() : new Map();
    this.decorationsChanged.fire(undefined);
    this.lensesChanged.fire();
    this.drawConflictLines();
  }

  /** Repo-relative path with forward slashes, or undefined outside the repo. */
  private relative(uri: vscode.Uri): string | undefined {
    const dir = this.state.dir;
    if (!dir || uri.scheme !== "file") return undefined;
    const rel = path.relative(dir, uri.fsPath);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  }

  private buildBadges(): Map<string, vscode.FileDecoration> {
    const dir = this.state.dir ?? "";
    const now = new Date();
    const files = new Map<string, { names: Set<string>; tooltips: string[]; conflict: boolean }>();
    const add = (file: string, names: string[], problem: MyProblem): void => {
      const entry = files.get(file) ?? { names: new Set<string>(), tooltips: [], conflict: false };
      for (const name of names) entry.names.add(name);
      entry.tooltips.push(explainMyProblem(problem, now));
      if (problem.kind === "mainConflict") entry.conflict = true;
      files.set(file, entry);
    };
    for (const overlap of this.state.overlaps) {
      for (const file of overlap.files) {
        add(path.join(dir, file.path), overlapNames(overlap, file), { kind: "overlapWithMe", overlap, file });
      }
    }
    for (const conflict of this.state.mainConflicts) {
      add(path.join(dir, conflict.path), conflict.authors, { kind: "mainConflict", conflict });
    }

    const badges = new Map<string, vscode.FileDecoration>();
    for (const [file, { names, tooltips, conflict }] of files) {
      badges.set(
        file,
        new vscode.FileDecoration(
          names.size > 0 ? badgeLetters([...names]) : "!",
          tooltips.join("\n"),
          // A conflict with main is more urgent than an overlap.
          new vscode.ThemeColor(conflict ? "errorForeground" : "charts.yellow"),
        ),
      );
    }
    return badges;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === "file" ? this.badges.get(uri.fsPath) : undefined;
  }

  /** One CodeLens per spot a teammate also changed (main's changes are never listed). */
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.on()) return [];
    const rel = this.relative(document.uri);
    if (!rel) return [];
    const now = new Date();
    return overlapHints(this.state.overlaps, rel).map((hint) => {
      // Ranges are from the last save; between saves they may drift a little.
      const line = Math.min(Math.max(hint.range.start, 1), document.lineCount) - 1;
      const problem: MyProblem = { kind: "overlapWithMe", overlap: hint.overlap, file: hint.file };
      return new vscode.CodeLens(document.lineAt(line).range, {
        title: `$(warning) ${overlapHintTitle(hint, now)}`,
        tooltip: "Compare or copy a message to send",
        command: "teamrope.showProblem",
        arguments: [problem],
      });
    });
  }

  /** Marks my lines that would conflict with main, found by their text. */
  private drawConflictLines(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = this.on() ? this.relative(editor.document.uri) : undefined;
      const conflict = rel ? this.state.mainConflicts.find((c) => c.path === rel) : undefined;
      editor.setDecorations(this.conflictLine, conflict ? this.conflictDecorations(editor.document, conflict) : []);
    }
  }

  private conflictDecorations(document: vscode.TextDocument, conflict: MainConflictPreview): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    for (const hunk of conflict.hunks) {
      if (hunk.yours.length === 0) continue;
      const start = findLines(document, hunk.yours);
      if (start === undefined) continue; // Edited since: the badge and notification still show.
      const end = start + hunk.yours.length - 1;
      decorations.push({
        range: new vscode.Range(start, 0, end, document.lineAt(end).text.length),
        hoverMessage: `Syncing would conflict here. ${conflictLineHint(conflict, hunk)}`,
        renderOptions: {
          after: {
            contentText: `  ${conflictLineHint(conflict, hunk)}`,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
          },
        },
      });
    }
    return decorations;
  }
}

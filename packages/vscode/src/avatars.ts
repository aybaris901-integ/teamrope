// Round avatars with a teammate's initial, in a stable color per name.
// Written once as SVG files in the extension's storage, used as tree icons.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}

/** Up to 2 initials: "alice" -> "A", "alice-smith" -> "AS". */
export function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = parts.length > 1 ? parts.map((p) => p[0]) : [parts[0]?.[0]];
  return letters.join("").slice(0, 2).toUpperCase() || "?";
}

export class Avatars {
  private readonly dir: string;

  constructor(storage: vscode.Uri) {
    this.dir = path.join(storage.fsPath, "avatars");
    mkdirSync(this.dir, { recursive: true });
  }

  /** File URI of the avatar for `name` (created on first use). */
  uri(name: string): vscode.Uri {
    const text = initials(name);
    const hue = hash(name.toLowerCase()) % 360;
    const file = path.join(this.dir, `${hue}-${encodeURIComponent(text)}.svg`);
    if (!existsSync(file)) {
      const fontSize = text.length > 1 ? 6.5 : 8.5;
      writeFileSync(
        file,
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
          `<circle cx="8" cy="8" r="8" fill="hsl(${hue}, 55%, 42%)"/>` +
          `<text x="8" y="8" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="600" fill="#fff">${text}</text>` +
          `</svg>`,
      );
    }
    return vscode.Uri.file(file);
  }
}

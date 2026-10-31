// Finds files that shouldn't go into a commit: secrets, generated folders and
// very large files. Only reads files, never changes anything.
import { openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";

export type SecretReason = "fileName" | "awsKey" | "githubToken" | "apiKey" | "privateKey";

export type RiskyFile =
  | { kind: "secret"; path: string; reason: SecretReason }
  /** A folder of generated files, e.g. "node_modules/" or "web/dist/". */
  | { kind: "generated"; path: string; fileCount: number }
  | { kind: "large"; path: string; sizeBytes: number };

/** A changed file as Save sees it. Paths are relative to the repo root. */
export interface ChangedFile {
  path: string;
  /** Old path, for a staged rename. */
  from?: string;
  /** True for files Git doesn't know about yet. */
  untracked: boolean;
  deleted: boolean;
}

export const LARGE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_SCANNED_BYTES = 1024 * 1024;
const GENERATED_FOLDERS = new Set(["node_modules", "venv", ".venv", "dist", "build"]);

const SECRET_FILE_NAMES = [
  /^\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^credentials.*\.json$/,
];
// Templates meant to be shared, e.g. .env.example.
const SAFE_FILE_NAMES = [/^\.env\.(example|sample|template)$/, /\.pub$/];

const SECRET_CONTENT: Array<[RegExp, SecretReason]> = [
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/, "awsKey"],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/, "githubToken"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, "apiKey"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "privateKey"],
];

function secretByName(file: string): boolean {
  const name = path.basename(file);
  if (SAFE_FILE_NAMES.some((pattern) => pattern.test(name))) return false;
  return SECRET_FILE_NAMES.some((pattern) => pattern.test(name));
}

/** Reads the start of a text file; null for binary or unreadable files. */
function readTextStart(fullPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(fullPath, "r");
    const buffer = Buffer.alloc(MAX_SCANNED_BYTES);
    const length = readSync(fd, buffer, 0, MAX_SCANNED_BYTES, 0);
    const bytes = buffer.subarray(0, length);
    return bytes.includes(0) ? null : bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function secretByContent(fullPath: string): SecretReason | null {
  const text = readTextStart(fullPath);
  if (text === null) return null;
  for (const [pattern, reason] of SECRET_CONTENT) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/** "web/node_modules/x/y.js" -> "web/node_modules/". Null if not in such a folder. */
function generatedFolder(file: string): string | null {
  const parts = file.split("/");
  const index = parts.slice(0, -1).findIndex((part) => GENERATED_FOLDERS.has(part));
  return index === -1 ? null : `${parts.slice(0, index + 1).join("/")}/`;
}

function fileSize(fullPath: string): number {
  try {
    return statSync(fullPath).size;
  } catch {
    return 0;
  }
}

/**
 * Checks changed files for risks. Only new files count for generated
 * folders: a tracked dist/ was committed on purpose. Files inside a
 * generated folder aren't scanned for secrets.
 */
export function findRiskyFiles(repoRoot: string, files: ChangedFile[]): RiskyFile[] {
  const risky: RiskyFile[] = [];
  const generated = new Map<string, number>();

  for (const file of files) {
    if (file.deleted) continue;
    const folder = file.untracked ? generatedFolder(file.path) : null;
    if (folder) {
      generated.set(folder, (generated.get(folder) ?? 0) + 1);
      continue;
    }
    const fullPath = path.join(repoRoot, file.path);
    const size = fileSize(fullPath);
    if (size > LARGE_FILE_BYTES) {
      risky.push({ kind: "large", path: file.path, sizeBytes: size });
      continue;
    }
    const reason = secretByContent(fullPath) ?? (secretByName(file.path) ? "fileName" : null);
    if (reason) risky.push({ kind: "secret", path: file.path, reason });
  }

  for (const [folder, fileCount] of generated) {
    risky.push({ kind: "generated", path: folder, fileCount });
  }
  return risky;
}

/** True if `file` is covered by a risky entry (a file, or a folder ending in "/"). */
export function isCoveredBy(file: string, risky: RiskyFile): boolean {
  return risky.path.endsWith("/") ? file.startsWith(risky.path) : file === risky.path;
}

// Who else is changing the code I'm changing? Compares all my changes since
// my branch split from a teammate's (commits + uncommitted + untracked) with
// their changes since the same point. Read-only; never fetches.
import { statSync } from "node:fs";
import path from "node:path";
import type { SimpleGit } from "simple-git";
import { authorsSinceSplit, predictConflicts } from "./dry-run.js";
import { gitVersion, openRepo, resolveRef } from "./git.js";
import { readMemberName } from "./start-task.js";
import type { SyncConflict } from "./sync.js";

const REMOTE_PREFIX = "refs/remotes/origin/";

/** 1-based, inclusive line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

export interface OverlapRange {
  /** Where it is in my working-tree file. */
  mine: LineRange;
  /** Where it is in their version of the file. */
  theirs: LineRange;
}

export interface FileOverlap {
  path: string;
  /** Spots where both sides changed the same or adjacent lines. Empty: same file, different spots (or binary). */
  ranges: OverlapRange[];
  /** Who changed the file on their branch since the split. */
  authors: string[];
  /** Oldest commit involved (theirs or mine) touching the file since the split. */
  since: Date;
}

export interface OverlapWithMe {
  branch: string;
  owner: string;
  files: FileOverlap[];
}

/** One side's change to a file: hunks in base ("old") and changed ("new") coordinates. */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The hunk's "-" and "+" lines, to tell identical changes apart from different ones. */
  body: string;
}

interface SideOfFile {
  hunks: Hunk[];
  authors: string[];
  oldest: Date | null;
}

/** A teammate's changes since the split, cached by their ref SHA and the base. */
export interface TheirSide {
  files: Map<string, SideOfFile>;
}

/** Owned by the caller (e.g. one per repo in an editor): avoids recomputing their side. */
export type TheirSideCache = Map<string, TheirSide>;

export interface OverlapOptions {
  mainBranch?: string;
  cache?: TheirSideCache;
}

const DIFF_ARGS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Parses `git diff -U0` output into hunks per file path. */
export function parseDiffHunks(diff: string): Map<string, Hunk[]> {
  const files = new Map<string, Hunk[]>();
  let oldPath: string | null = null;
  let current: Hunk[] | null = null;
  // Inside a hunk, read exactly the announced number of lines, so content
  // like "--- x" is never mistaken for a file header.
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  const body: string[] = [];
  const finishHunk = (): void => {
    if (hunk) hunk.body = body.join("\n");
    hunk = null;
    body.length = 0;
  };
  for (const line of diff.split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      if (!line.startsWith("\\")) body.push(line); // skip "\ No newline at end of file"
      if (oldLeft <= 0 && newLeft <= 0) finishHunk();
      continue;
    }
    finishHunk();
    if (line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? null : line.slice("--- a/".length);
    } else if (line.startsWith("+++ ")) {
      const file = line === "+++ /dev/null" ? oldPath : line.slice("+++ b/".length);
      current = file === null ? null : (files.get(file) ?? []);
      if (file !== null && current) files.set(file, current);
    } else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      const match = / and b\/(.+) differ$/.exec(line) ?? /^Binary files a\/(.+) and /.exec(line);
      if (match?.[1] && !files.has(match[1])) files.set(match[1], []);
    } else if (line.startsWith("@@") && current) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match) {
        hunk = {
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
          body: "",
        };
        current.push(hunk);
        oldLeft = hunk.oldCount;
        newLeft = hunk.newCount;
      }
    }
  }
  finishHunk();
  return files;
}

/** Their hunks minus the ones main made too (same place, same lines): those came from main. */
export function withoutMainHunks(
  theirs: Map<string, Hunk[]>,
  main: Map<string, Hunk[]>,
): Map<string, Hunk[]> {
  const same = (a: Hunk, b: Hunk): boolean =>
    a.oldStart === b.oldStart && a.oldCount === b.oldCount && a.body === b.body;
  const result = new Map<string, Hunk[]>();
  for (const [file, hunks] of theirs) {
    // A binary file has no hunks: drop it only if main changed it too.
    if (hunks.length === 0) {
      if (!main.has(file)) result.set(file, hunks);
      continue;
    }
    const mainHunks = main.get(file) ?? [];
    const own = hunks.filter((h) => !mainHunks.some((m) => same(h, m)));
    if (own.length > 0) result.set(file, own);
  }
  return result;
}

/** A hunk's span in base coordinates; a pure insertion sits at its line. */
function oldSpan(h: Hunk): LineRange {
  return { start: h.oldStart, end: h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1 };
}

/** A hunk's span in the changed file; a pure deletion sits at the line before it. */
function newSpan(h: Hunk): LineRange {
  const start = Math.max(h.newStart, 1);
  return { start, end: h.newCount === 0 ? start : h.newStart + h.newCount - 1 };
}

/** Same or adjacent lines: Git treats adjacent changes as conflicting too. */
function touches(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end + 1 && b.start <= a.end + 1;
}

/** The spots where my hunks and theirs touch, in each side's own coordinates. */
export function overlappingRanges(mine: Hunk[], theirs: Hunk[]): OverlapRange[] {
  const ranges: OverlapRange[] = [];
  for (const m of mine) {
    for (const t of theirs) {
      if (touches(oldSpan(m), oldSpan(t))) ranges.push({ mine: newSpan(m), theirs: newSpan(t) });
    }
  }
  return ranges;
}

/** Commit authors and the oldest commit date per file in `range` (e.g. "base..sha"). */
async function historyPerFile(
  git: SimpleGit,
  ...revs: string[]
): Promise<Map<string, { authors: string[]; oldest: Date }>> {
  const log = await git.raw([
    "-c",
    "core.quotePath=false",
    "log",
    "--no-renames",
    "--format=%x00%an%x09%ct",
    "--name-only",
    ...revs,
  ]);
  const files = new Map<string, { authors: string[]; oldest: Date }>();
  for (const entry of log.split("\0").filter(Boolean)) {
    const [header = "", ...paths] = entry.split("\n");
    const [author = "", unix = "0"] = header.split("\t");
    const date = new Date(Number(unix) * 1000);
    for (const file of paths.filter(Boolean)) {
      const seen = files.get(file);
      if (!seen) {
        files.set(file, { authors: [author], oldest: date });
        continue;
      }
      if (!seen.authors.includes(author)) seen.authors.push(author);
      if (date < seen.oldest) seen.oldest = date;
    }
  }
  return files;
}

/**
 * Their own changes since `base`: hunks that main also has (because they
 * branched from a newer main) are left out, and so are main's commits.
 */
async function computeTheirSide(
  git: SimpleGit,
  base: string,
  theirs: string,
  main: string | null,
): Promise<TheirSide> {
  const all = parseDiffHunks(await git.raw([...DIFF_ARGS, base, theirs]));
  const hunks = main ? withoutMainHunks(all, parseDiffHunks(await git.raw([...DIFF_ARGS, base, main]))) : all;
  const history = await historyPerFile(git, theirs, `^${base}`, ...(main ? [`^${main}`] : []));
  const files = new Map<string, SideOfFile>();
  for (const [file, fileHunks] of hunks) {
    const h = history.get(file);
    files.set(file, { hunks: fileHunks, authors: h?.authors ?? [], oldest: h?.oldest ?? null });
  }
  return { files };
}

/** My changes since `base`: working tree vs base, plus untracked files (whole file). */
async function computeMySide(git: SimpleGit, base: string, untracked: string[]): Promise<TheirSide> {
  const hunks = parseDiffHunks(await git.raw([...DIFF_ARGS, base]));
  const history = await historyPerFile(git, `${base}..HEAD`);
  const files = new Map<string, SideOfFile>();
  for (const [file, fileHunks] of hunks) {
    files.set(file, { hunks: fileHunks, authors: [], oldest: history.get(file)?.oldest ?? null });
  }
  for (const file of untracked) {
    // A new file: everything in it is mine, at the very start of base's (empty) version.
    files.set(file, {
      hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, body: "" }],
      authors: [],
      oldest: null,
    });
  }
  return { files };
}

interface RemoteBranchRef {
  branch: string;
  sha: string;
  author: string;
}

async function remoteBranches(git: SimpleGit): Promise<RemoteBranchRef[]> {
  const output = await git.raw([
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(authorname)",
    REMOTE_PREFIX,
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", author = ""] = line.split("\t");
      return { branch: ref.slice(REMOTE_PREFIX.length), sha, author };
    });
}

/** Name prefix before "/", or the last author if there is none (as in Team status). */
function ownerOf(branch: string, author: string): string {
  const slash = branch.indexOf("/");
  return slash > 0 ? branch.slice(0, slash) : author;
}

async function upstreamBranch(git: SimpleGit): Promise<string | null> {
  try {
    const ref = (await git.raw(["rev-parse", "--symbolic-full-name", "@{upstream}"])).trim();
    return ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : null;
  } catch {
    return null;
  }
}

async function untrackedFiles(git: SimpleGit): Promise<string[]> {
  const output = await git.raw(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--full-name"]);
  return output.split("\n").filter(Boolean);
}

function earliest(...dates: Array<Date | null>): Date | null {
  return dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
}

/**
 * For each teammate's branch: the files (and spots) where my changes since
 * the split and theirs touch. Skips main, my upstream and branches I own.
 */
export async function overlapsWithMe(dir: string, options: OverlapOptions = {}): Promise<OverlapWithMe[]> {
  const mainBranch = options.mainBranch ?? "main";
  const git = await openRepo(dir);
  const head = await resolveRef(git, "HEAD");
  if (!head) return [];

  const { saved, suggestion } = await readMemberName(dir);
  const me = saved ?? suggestion;
  const upstream = await upstreamBranch(git);
  const main = await resolveRef(git, `${REMOTE_PREFIX}${mainBranch}`);
  const untracked = await untrackedFiles(git);
  const mySides = new Map<string, TheirSide>(); // per base, within this call

  const result: OverlapWithMe[] = [];
  for (const ref of await remoteBranches(git)) {
    const owner = ownerOf(ref.branch, ref.author);
    if (ref.branch === "HEAD" || ref.branch === mainBranch || ref.branch === upstream || owner === me) {
      continue;
    }
    let base: string;
    try {
      base = (await git.raw(["merge-base", head, ref.sha])).trim();
    } catch {
      continue; // no common history
    }

    // Their side also depends on main (its hunks are left out).
    const key = `${ref.sha}:${base}:${main ?? ""}`;
    let theirs = options.cache?.get(key);
    if (!theirs) {
      theirs = await computeTheirSide(git, base, ref.sha, main);
      options.cache?.set(key, theirs);
    }
    let mine = mySides.get(base);
    if (!mine) {
      mine = await computeMySide(git, base, untracked);
      mySides.set(base, mine);
    }

    const files: FileOverlap[] = [];
    for (const [file, mySide] of mine.files) {
      const theirSide = theirs.files.get(file);
      if (!theirSide) continue;
      files.push({
        path: file,
        ranges: overlappingRanges(mySide.hunks, theirSide.hunks),
        authors: theirSide.authors.length > 0 ? theirSide.authors : [owner],
        since: earliest(theirSide.oldest, mySide.oldest) ?? new Date(),
      });
    }
    if (files.length > 0) result.push({ branch: ref.branch, owner, files });
  }
  return result;
}

/** A predicted conflict with main for my current work, and how old it is. */
export interface MainConflictPreview extends SyncConflict {
  /** Oldest commit involved (on main or mine) touching the file since the split. */
  since: Date;
  /** The two commits the dry run combined: mine (HEAD) and the team repo's main. */
  commits: { mine: string; main: string };
}

/**
 * Dry-runs merging origin/<main> into HEAD (my committed work) and reports
 * the conflicts. Works with uncommitted changes. Read-only; never fetches.
 */
export async function predictMainConflicts(
  dir: string,
  options: { mainBranch?: string } = {},
): Promise<MainConflictPreview[]> {
  const git = await openRepo(dir);
  const head = await resolveRef(git, "HEAD");
  const target = await resolveRef(git, `${REMOTE_PREFIX}${options.mainBranch ?? "main"}`);
  if (!head || !target) return [];
  const base = (await git.raw(["merge-base", head, target]).catch(() => "")).trim();
  // Nothing of mine since the split, or nothing new on main: no conflict possible.
  if (!base || base === head || base === target) return [];

  const method = (await gitVersion(git)).supportsMergeTree ? "mergeTree" : "worktree";
  const predicted = await predictConflicts(git, dir, head, target, method);
  if (predicted.length === 0) return [];
  const mainHistory = await historyPerFile(git, `${base}..${target}`);
  const myHistory = await historyPerFile(git, `${base}..${head}`);
  const conflicts: MainConflictPreview[] = [];
  for (const { path: file, hunks } of predicted) {
    conflicts.push({
      path: file,
      authors: await authorsSinceSplit(git, head, target, file),
      hunks,
      since: earliest(mainHistory.get(file)?.oldest ?? null, myHistory.get(file)?.oldest ?? null) ?? new Date(),
      commits: { mine: head, main: target },
    });
  }
  return conflicts;
}

/** When my oldest not-shared change was made (oldest modified time among changed files). */
export async function notSharedSince(dir: string): Promise<Date | null> {
  const git = await openRepo(dir);
  const root = (await git.revparse(["--show-toplevel"])).trim();
  const status = await git.status();
  let oldest: Date | null = null;
  for (const file of status.files) {
    try {
      const mtime = statSync(path.join(root, file.path)).mtime;
      if (!oldest || mtime < oldest) oldest = mtime;
    } catch {
      // Deleted: no modified time.
    }
  }
  return oldest;
}

export interface ActivityEntry {
  branch: string;
  author: string;
  /** Who to show: the branch owner (as in Team) on member branches, the commit author on main. */
  who: string;
  date: Date;
  subject: string;
}

/** The latest commits across the team repo's branches (as of the last fetch). */
export async function recentActivity(
  dir: string,
  options: { limit?: number; mainBranch?: string } = {},
): Promise<ActivityEntry[]> {
  const git = await openRepo(dir);
  const mainBranch = options.mainBranch ?? "main";
  const output = await git.raw([
    "log",
    "--remotes=origin",
    "--source",
    `-n${options.limit ?? 5}`,
    "--format=%S%x09%an%x09%ct%x09%s",
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [source = "", author = "", unix = "0", ...subject] = line.split("\t");
      const sourceBranch = source.replace(/^(refs\/remotes\/)?origin\//, "");
      // origin/HEAD is just another name for main.
      const branch = sourceBranch === "HEAD" ? mainBranch : sourceBranch;
      const slash = branch.indexOf("/");
      return {
        branch,
        author,
        who: branch !== mainBranch && slash > 0 ? branch.slice(0, slash) : author,
        date: new Date(Number(unix) * 1000),
        subject: subject.join("\t"),
      };
    });
}

/** A file's content at a ref (e.g. "refs/remotes/origin/alice/feature"), or null if it isn't there. */
export async function fileAtRef(dir: string, ref: string, file: string): Promise<string | null> {
  const git = await openRepo(dir);
  try {
    return await git.raw(["show", `${ref}:${file}`]);
  } catch {
    return null;
  }
}

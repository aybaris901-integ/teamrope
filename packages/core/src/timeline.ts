// The team over the last couple of hours: shared commits per person, my work
// that isn't shared yet, and how long each problem has been open. Only
// sharedCommits() reads Git (read-only, never fetches); buildTimeline() turns
// data the caller already has into rows.
import { openRepo } from "./git.js";
import { problemPeople, type MyProblem } from "./my-problems.js";
import type { TeamStatus } from "./team-status.js";

export const TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface SharedCommit {
  branch: string;
  /** The branch owner (name before "/"), as in Team; else the commit author. */
  owner: string;
  date: Date;
  subject: string;
}

/** Commits on teammates' branches in the team repo since `since` (as of the last fetch). Main is left out. */
export async function sharedCommits(
  dir: string,
  options: { since: Date; mainBranch?: string },
): Promise<SharedCommit[]> {
  const git = await openRepo(dir);
  const mainBranch = options.mainBranch ?? "main";
  const output = await git.raw([
    "log",
    "--remotes=origin",
    "--source",
    `--since=${options.since.toISOString()}`,
    "--format=%S%x09%an%x09%ct%x09%s",
  ]);
  const commits: SharedCommit[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [source = "", author = "", unix = "0", ...subject] = line.split("\t");
    const branch = source.replace(/^(refs\/remotes\/)?origin\//, "");
    if (branch === mainBranch || branch === "HEAD") continue;
    const slash = branch.indexOf("/");
    commits.push({
      branch,
      owner: slash > 0 ? branch.slice(0, slash) : author,
      date: new Date(Number(unix) * 1000),
      subject: subject.join("\t"),
    });
  }
  return commits;
}

export type TimelineProblemKind = "conflict" | "overlap";

export interface TimelineProblem {
  kind: TimelineProblemKind;
  /** When it started (oldest commit involved); null when unknown (Team status has no dates). */
  since: Date | null;
  /** Indexes into the problems passed in, for details, Compare and Copy message. */
  problemIndexes: number[];
}

export interface TimelineRow {
  person: string;
  isMe: boolean;
  /** Shared commits in the window, oldest first. */
  commits: SharedCommit[];
  /** Me only: when my oldest change not shared yet was made. */
  notSharedSince: Date | null;
  /** At most one per kind, conflict first. A quiet teammate has none: fewer dots is all. */
  problems: TimelineProblem[];
  /** Newest commit on any of the person's branches, even before the window. */
  lastShared: Date | null;
}

export interface Timeline {
  start: Date;
  now: Date;
  rows: TimelineRow[];
}

export interface TimelineInput {
  now: Date;
  windowMs?: number;
  me: string | undefined;
  commits: SharedCommit[];
  team: TeamStatus | undefined;
  /** The panel's problem list (problemsForMe). */
  problems: MyProblem[];
  notSharedSince: Date | null;
}

function problemShape(problem: MyProblem): { kind: TimelineProblemKind; since: Date | null } | null {
  switch (problem.kind) {
    case "mainConflict":
      return { kind: "conflict", since: problem.conflict.since };
    case "overlapWithMe":
      return { kind: "overlap", since: problem.file.since };
    case "team":
      if (problem.problem.kind === "conflictWithMain") return { kind: "conflict", since: null };
      if (problem.problem.kind === "overlap") return { kind: "overlap", since: null };
      return null;
  }
}

/** Earliest known date; a known date beats an unknown one. */
function earlier(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** One row per person: me first, then people with problems (conflicts first), then everyone else by name. */
export function buildTimeline(input: TimelineInput): Timeline {
  const start = new Date(input.now.getTime() - (input.windowMs ?? TIMELINE_WINDOW_MS));
  const me = input.me ?? "you";
  const rows = new Map<string, TimelineRow>();
  const row = (person: string): TimelineRow => {
    let found = rows.get(person);
    if (!found) {
      const isMe = person === me;
      found = { person, isMe, commits: [], notSharedSince: isMe ? input.notSharedSince : null, problems: [], lastShared: null };
      rows.set(person, found);
    }
    return found;
  };

  row(me);
  for (const branch of input.team?.branches ?? []) {
    const r = row(branch.owner);
    if (!r.lastShared || branch.lastSave > r.lastShared) r.lastShared = branch.lastSave;
  }
  for (const commit of input.commits) {
    if (commit.date >= start && commit.date <= input.now) row(commit.owner).commits.push(commit);
  }
  input.problems.forEach((problem, index) => {
    const shape = problemShape(problem);
    if (!shape) return;
    const people = problemPeople(problem, me);
    if (problem.kind === "overlapWithMe") people.push(problem.overlap.owner);
    for (const person of new Set(people)) {
      const r = row(person);
      const existing = r.problems.find((p) => p.kind === shape.kind);
      if (existing) {
        existing.since = earlier(existing.since, shape.since);
        existing.problemIndexes.push(index);
      } else {
        r.problems.push({ kind: shape.kind, since: shape.since, problemIndexes: [index] });
      }
    }
  });

  const rank = (r: TimelineRow): number =>
    r.isMe ? 0 : r.problems.some((p) => p.kind === "conflict") ? 1 : r.problems.length > 0 ? 2 : 3;
  for (const r of rows.values()) {
    r.commits.sort((a, b) => a.date.getTime() - b.date.getTime());
    r.problems.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "conflict" ? -1 : 1));
  }
  return {
    start,
    now: input.now,
    rows: [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.person.localeCompare(b.person)),
  };
}

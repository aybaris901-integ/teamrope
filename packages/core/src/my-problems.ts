// One problem list for "me": my conflict with main, my overlaps with
// teammates, then the rest of the team's problems, each reported once.
import type { FileOverlap, MainConflictPreview, OverlapWithMe } from "./overlaps.js";
import type { TeamProblem, TeamStatus } from "./team-status.js";

export type MyProblem =
  | { kind: "mainConflict"; conflict: MainConflictPreview }
  | { kind: "overlapWithMe"; overlap: OverlapWithMe; file: FileOverlap }
  | { kind: "team"; problem: TeamProblem };

/** True if a problem is about me: my conflict, my overlap, or a team problem on my branch. */
export function involvesMe(problem: MyProblem, myBranch: string | null, me: string | undefined): boolean {
  if (problem.kind !== "team") return true;
  const p = problem.problem;
  switch (p.kind) {
    case "overlap":
      return (myBranch !== null && p.overlap.branches.includes(myBranch)) || p.overlap.owners.includes(me ?? "");
    default:
      return p.branch === myBranch || p.owner === me;
  }
}

/** The people a problem is about: its branch owners, or me for my own problems. */
export function problemPeople(problem: MyProblem, me: string | undefined): string[] {
  if (problem.kind !== "team") return [me ?? "you"];
  const p = problem.problem;
  return p.kind === "overlap" ? [...new Set(p.overlap.owners)] : [p.owner];
}

/**
 * One entry per person: the first (most severe) problem that brings someone
 * new, with later problems about the same people folded into it. Problems
 * must come most severe first, as problemsForMe and teamStatus return them.
 */
export function onePerPerson(
  problems: MyProblem[],
  me: string | undefined,
): Array<{ problem: MyProblem; more: MyProblem[] }> {
  const rows: Array<{ problem: MyProblem; more: MyProblem[] }> = [];
  const rowOf = new Map<string, { problem: MyProblem; more: MyProblem[] }>();
  for (const problem of problems) {
    const people = problemPeople(problem, me);
    const existing = people.map((person) => rowOf.get(person));
    if (existing.every(Boolean)) {
      existing[0]?.more.push(problem);
      continue;
    }
    const row: { problem: MyProblem; more: MyProblem[] } = { problem, more: [] };
    rows.push(row);
    for (const person of people) if (!rowOf.has(person)) rowOf.set(person, row);
  }
  return rows;
}

/**
 * Local results win over Team status (they include work not shared yet and
 * have line ranges): a team overlap between my branch and a teammate's is
 * dropped for files already in `overlaps`, and Team status' conflict with
 * main for my branch is dropped in favour of `mainConflicts`.
 */
export function problemsForMe(
  team: TeamStatus | undefined,
  overlaps: OverlapWithMe[],
  mainConflicts: MainConflictPreview[],
  myBranch: string | null,
): MyProblem[] {
  const problems: MyProblem[] = mainConflicts.map((conflict) => ({ kind: "mainConflict", conflict }));
  for (const overlap of overlaps) {
    for (const file of overlap.files) problems.push({ kind: "overlapWithMe", overlap, file });
  }

  for (const problem of team?.problems ?? []) {
    if (problem.kind === "conflictWithMain" && problem.branch === myBranch) continue;
    if (problem.kind === "overlap" && myBranch && problem.overlap.branches.includes(myBranch)) {
      const [a, b] = problem.overlap.branches;
      const other = a === myBranch ? b : a;
      const known = new Set(overlaps.find((o) => o.branch === other)?.files.map((f) => f.path) ?? []);
      const files = problem.overlap.files.filter((file) => !known.has(file));
      if (files.length === 0) continue;
      problems.push({ kind: "team", problem: { ...problem, overlap: { ...problem.overlap, files } } });
      continue;
    }
    problems.push({ kind: "team", problem });
  }
  return problems;
}

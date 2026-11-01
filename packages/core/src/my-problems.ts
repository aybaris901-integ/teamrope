// One problem list for "me": my conflict with main, my overlaps with
// teammates, then the rest of the team's problems, each reported once.
import type { FileOverlap, MainConflictPreview, OverlapWithMe } from "./overlaps.js";
import type { TeamProblem, TeamStatus } from "./team-status.js";

export type MyProblem =
  | { kind: "mainConflict"; conflict: MainConflictPreview }
  | { kind: "overlapWithMe"; overlap: OverlapWithMe; file: FileOverlap }
  | { kind: "team"; problem: TeamProblem };

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

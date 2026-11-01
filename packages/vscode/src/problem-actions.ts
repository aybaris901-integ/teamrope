// Compare and Copy message for a problem: what to diff, what to copy.
import { problemMessage, type MyProblem } from "@teamrope/core";
import * as vscode from "vscode";

const REMOTE = "refs/remotes/origin/";

/** One side of a comparison: a file at a ref, or my working-tree file. */
export type CompareSide = { ref: string; label: string } | { workingTree: true };

export interface CompareTarget {
  path: string;
  left: CompareSide;
  right: CompareSide;
}

/** What Compare should show for a problem, or undefined if no file is involved. */
export function compareTargetFor(problem: MyProblem, mainBranch = "main"): CompareTarget | undefined {
  switch (problem.kind) {
    case "mainConflict": {
      const who = problem.conflict.authors.join(", ") || mainBranch;
      return {
        path: problem.conflict.path,
        left: { ref: `${REMOTE}${mainBranch}`, label: `${who} (${mainBranch})` },
        right: { workingTree: true },
      };
    }
    case "overlapWithMe":
      return {
        path: problem.file.path,
        left: { ref: `${REMOTE}${problem.overlap.branch}`, label: problem.overlap.owner },
        right: { workingTree: true },
      };
    case "team": {
      const p = problem.problem;
      if (p.kind === "overlap") {
        const [a, b] = p.overlap.branches;
        const [ownerA, ownerB] = p.overlap.owners;
        const file = p.overlap.files[0];
        if (!file) return undefined;
        return { path: file, left: { ref: `${REMOTE}${a}`, label: ownerA }, right: { ref: `${REMOTE}${b}`, label: ownerB } };
      }
      if (p.kind === "conflictWithMain") {
        const file = p.conflicts[0]?.path;
        if (!file) return undefined;
        return {
          path: file,
          left: { ref: `${REMOTE}${mainBranch}`, label: mainBranch },
          right: { ref: `${REMOTE}${p.branch}`, label: p.owner },
        };
      }
      return undefined;
    }
  }
}

export function copyTextFor(problem: MyProblem, myBranch: string, mainBranch = "main"): string {
  return problemMessage(problem, myBranch, mainBranch);
}

/** Read-only documents with a file's content at a ref, for vscode.diff. */
export const GIT_SCHEME = "teamrope-git";

export function refUri(dir: string, ref: string, file: string, label: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${file}`,
    query: new URLSearchParams({ dir, ref, file, label }).toString(),
  });
}

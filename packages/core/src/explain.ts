// Explain layer: turns core results into short plain-English sentences.
// Pure functions only - callers decide how to show them.
import type { Diagnosis, OperationInProgress } from "./diagnose.js";
import type { RemoteProblem } from "./remote-problem.js";

const MAX_LISTED_FILES = 5;

const OPERATION_DESCRIPTIONS: Record<OperationInProgress, string> = {
  merge: "a merge (combining another branch into yours)",
  rebase: "a rebase (replaying your commits on top of another branch)",
  "cherry-pick": "a cherry-pick (copying a commit from another branch)",
  revert: "a revert (undoing an earlier commit)",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function them(count: number): string {
  return count === 1 ? "it" : "them";
}

function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  const hidden = files.length - MAX_LISTED_FILES;
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
}

/** What the problem means, then what to do about it. */
export function explainRemoteProblem(problem: RemoteProblem): [string, string] {
  switch (problem.kind) {
    case "auth":
      return [
        "Git needs you to log in, and there's no saved login on this computer (or it has expired).",
        "If the repo is on GitHub, install the GitHub CLI (gh), run `gh auth login`, then `gh auth setup-git`, and try again.",
      ];
    case "notFoundOrNoAccess":
      return [
        "The team repo wasn't found, or your account doesn't have access to it.",
        "Check the repo address with your captain and ask them to add your account to the repo.",
      ];
    case "sshKey":
      return [
        "The server didn't accept your SSH key (the file on your computer that proves who you are).",
        "Add your public key to your account on the server (on GitHub: Settings → SSH and GPG keys), or switch the repo to an HTTPS address.",
      ];
    case "hostKey":
      return [
        "Your computer doesn't recognize the server yet (or its identity changed), so it refused to connect to be safe.",
        "Ask your captain to check the server's fingerprint before connecting. Don't just accept it.",
      ];
    case "network":
      return [
        "Your computer couldn't connect to the server that hosts the team repo.",
        "Check your internet connection (or the venue Wi-Fi) and try again.",
      ];
    case "timeout":
      return [
        "The server didn't answer in time.",
        "Check your internet connection and try again in a minute.",
      ];
    case "unknown":
      return [
        `Something unexpected went wrong. Git said: ${endSentence(problem.detail)}`,
        "Show this message to your captain.",
      ];
  }
}

export interface Explanation {
  /** What's going on, as short sentences. No advice except how to fix access. */
  summary: string[];
  /** Exactly one suggestion: "Next: <button>" or "Nothing to do, keep coding." */
  next: string;
}

function explainNextAction(d: Diagnosis): string {
  switch (d.nextAction) {
    case "finishOperation":
      return `Next: finish or cancel the ${d.inProgress ?? "operation"} (ask your captain if you're stuck)`;
    case "fixAccess":
      return "Next: fix access to the team repo (see above)";
    case "startTask":
      return "Next: Start task";
    case "save":
      return "Next: Save";
    case "sync":
      return "Next: Sync";
    case null:
      return "Nothing to do, keep coding.";
  }
}

export function explainDiagnosis(d: Diagnosis, mainBranch = "main"): Explanation {
  const sentences: string[] = [];

  if (d.inProgress) {
    sentences.push(
      `You're in the middle of ${OPERATION_DESCRIPTIONS[d.inProgress]}, and Git is waiting for it to be finished or cancelled.`,
      "I won't change anything until it's done.",
    );
  }

  // Before the rest, because it's all based on possibly old remote data.
  if (d.remoteProblem) {
    const [meaning, whatToDo] = explainRemoteProblem(d.remoteProblem);
    sentences.push("I couldn't reach the team repo, so the rest may be out of date.", meaning);
    // Only when fixing access is the next step, so there's one suggestion.
    if (d.nextAction === "fixAccess") sentences.push(whatToDo);
  }

  if (d.detached) {
    // A rebase detaches HEAD on purpose; the in-progress sentence covers it.
    if (!d.inProgress) {
      sentences.push(
        `You're not on any branch right now (Git calls this "detached HEAD"), so new work could get lost.`,
      );
    }
  } else if (d.onMain) {
    sentences.push(`You're on ${mainBranch}, the branch the whole team shares.`);
  } else {
    sentences.push(`You're on your own branch ${d.currentBranch}.`);
  }

  const unsavedFiles = d.dirtyFiles.filter((file) => !d.conflictedFiles.includes(file));
  if (d.conflictedFiles.length > 0) {
    sentences.push(
      `You have ${plural(d.conflictedFiles.length, "file")} with conflicts: ${listFiles(d.conflictedFiles)}.`,
    );
    if (unsavedFiles.length > 0) {
      sentences.push(
        `You also have ${plural(unsavedFiles.length, "other changed file")}: ${listFiles(unsavedFiles)}.`,
      );
    }
  } else {
    sentences.push(
      unsavedFiles.length === 0
        ? "You have no unsaved changes."
        : `You have ${plural(unsavedFiles.length, "unsaved file")}: ${listFiles(unsavedFiles)}.`,
    );
  }

  if (!d.onMain && !d.detached) {
    if (d.aheadOfUpstream === null) {
      sentences.push("This branch is only on your computer so far.");
    } else if (d.aheadOfUpstream > 0) {
      sentences.push(
        `You have ${plural(d.aheadOfUpstream, "commit")} that only ${d.aheadOfUpstream === 1 ? "exists" : "exist"} on your computer.`,
      );
    }
    if (d.behindUpstream) {
      sentences.push(
        `The team repo's copy of your branch has ${plural(d.behindUpstream, "commit")} you don't have yet.`,
      );
    }
  }

  if (!d.canReachRemote) {
    // The comparison would use old data, so say nothing about main.
  } else if (d.behindMain === null) {
    sentences.push(`I couldn't find the team's ${mainBranch} branch to compare with.`);
  } else if (d.behindMain > 0) {
    sentences.push(
      `${capitalize(mainBranch)} has ${plural(d.behindMain, "new commit")} you don't have yet.`,
    );
  } else if (!d.onMain && !d.inProgress) {
    sentences.push(`You're up to date with ${mainBranch}.`);
  }

  if (d.unpushedCommitsOnMain) {
    sentences.push(
      `Your ${mainBranch} has ${plural(d.unpushedCommitsOnMain, "commit")} that ${d.unpushedCommitsOnMain === 1 ? "was" : "were"} never uploaded, so only you have ${them(d.unpushedCommitsOnMain)}.`,
    );
  }

  if (!d.supportsMergeTree) {
    sentences.push(
      `Your Git (${d.gitVersion}) is older than 2.38, so conflict checks will be a bit slower.`,
    );
  }

  return { summary: sentences, next: explainNextAction(d) };
}

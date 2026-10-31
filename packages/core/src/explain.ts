// Explain layer: turns core results into short plain-English sentences.
// Pure functions only - callers decide how to show them.
import type { Diagnosis } from "./diagnose.js";

const MAX_LISTED_FILES = 5;

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

export function explainDiagnosis(d: Diagnosis, mainBranch = "main"): string[] {
  const sentences: string[] = [];

  // First, because everything below is based on possibly old remote data.
  if (!d.canReachRemote) {
    sentences.push(
      `I couldn't reach the team repo, so this may be out of date. Git said: ${endSentence(d.remoteError ?? "unknown error")}`,
    );
  }

  if (d.detached) {
    sentences.push(
      `You're not on any branch right now (Git calls this "detached HEAD"), so new work could get lost. Ask your captain for help before saving.`,
    );
  } else if (d.onMain) {
    sentences.push(
      `You're on ${mainBranch}, the branch the whole team shares. Start a task to get your own branch before changing things.`,
    );
  } else {
    sentences.push(`You're on your own branch ${d.currentBranch}.`);
  }

  sentences.push(
    d.dirtyFiles.length === 0
      ? "You have no unsaved changes."
      : `You have ${plural(d.dirtyFiles.length, "unsaved file")}: ${listFiles(d.dirtyFiles)}.`,
  );

  if (!d.onMain && !d.detached) {
    if (d.aheadOfUpstream === null) {
      sentences.push("This branch is only on your computer so far. Save will upload it.");
    } else if (d.aheadOfUpstream > 0) {
      sentences.push(
        `You have ${plural(d.aheadOfUpstream, "commit")} that only ${d.aheadOfUpstream === 1 ? "exists" : "exist"} on your computer. Save will upload ${them(d.aheadOfUpstream)}.`,
      );
    }
    if (d.behindUpstream) {
      sentences.push(
        `The team repo's copy of your branch has ${plural(d.behindUpstream, "commit")} you don't have yet.`,
      );
    }
  }

  if (d.behindMain === null) {
    sentences.push(`I couldn't find the team's ${mainBranch} branch to compare with.`);
  } else if (d.behindMain > 0) {
    sentences.push(
      `${capitalize(mainBranch)} has ${plural(d.behindMain, "new commit")} you don't have yet. Sync will bring ${them(d.behindMain)} in.`,
    );
  } else if (!d.onMain) {
    sentences.push(`You're up to date with ${mainBranch}.`);
  }

  if (d.unpushedCommitsOnMain) {
    sentences.push(
      `Your ${mainBranch} has ${plural(d.unpushedCommitsOnMain, "commit")} that ${d.unpushedCommitsOnMain === 1 ? "was" : "were"} never uploaded, so only you have ${them(d.unpushedCommitsOnMain)}. Save will move ${them(d.unpushedCommitsOnMain)} to your own branch.`,
    );
  }

  if (!d.supportsMergeTree) {
    sentences.push(
      `Your Git (${d.gitVersion}) is older than 2.38, so conflict checks will be a bit slower.`,
    );
  }

  return sentences;
}

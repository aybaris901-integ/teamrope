// Explain layer: turns core results into short plain-English sentences.
// Pure functions only - callers decide how to show them.
import type { Diagnosis, OperationInProgress } from "./diagnose.js";
import type { RemoteProblem } from "./remote-problem.js";
import type {
  StartTaskPlan,
  StartTaskResult,
  StartTaskStep,
  StartTaskStepData,
} from "./start-task.js";
import { willIgnore, type SavePlan, type SaveResult, type SaveStepData } from "./save.js";
import type { RiskyFile, SecretReason } from "./risky-files.js";

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
    case "askCaptain":
      return "Next: ask your captain for help before changing anything. If you're the captain: `git switch -c rescue/<name>` keeps everything you have.";
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

// --- Start task ------------------------------------------------------------

function describeCarried(files: number, commits: number): string {
  const parts: string[] = [];
  if (files > 0) parts.push(plural(files, "unsaved file"));
  if (commits > 0) parts.push(plural(commits, "commit"));
  return parts.join(" and ");
}

/** One plain-English line saying what a step will do. */
export function describeStartTaskStep(step: StartTaskStepData): string {
  switch (step.kind) {
    case "saveName":
      return `Remember "${step.name}" as your name in this repo, so your branches start with "${step.name}/".`;
    case "createBranch":
      return step.carry
        ? `Create your own branch ${step.branch} right where you are, so it keeps your ${describeCarried(step.carriedFiles, step.carriedCommits)}.`
        : `Create your own branch ${step.branch} from the team's latest main and switch to it.`;
    case "moveMain":
      return "Back up your main, then move it back to match the team's main (your commits stay on your new branch).";
    case "fastForwardMain":
      return "Update your main to the team's latest main (nothing is lost).";
    case "push":
      return `Upload ${step.branch} to the team repo so everyone can see it.`;
  }
}

/** Why Start task won't run, plus the diagnosis behind it. */
export function explainStartTaskRefusal(plan: StartTaskPlan): string[] {
  const { summary, next } = explainDiagnosis(plan.diagnosis, plan.mainBranch);
  switch (plan.refusal) {
    case "saveFirst":
      return [
        ...summary,
        `You have unsaved changes on your branch ${plan.diagnosis.currentBranch}. Save first, then start a new task.`,
      ];
    case "noMainOnRemote":
      return [
        ...summary,
        `The team repo has no ${plan.mainBranch} branch yet, so there's nothing to start from. Ask your captain to upload ${plan.mainBranch} first.`,
      ];
    default:
      return ["I can't start a new task right now.", ...summary, next];
  }
}

function explainDoneStep(
  step: StartTaskStep,
  plan: StartTaskPlan,
  result: Pick<StartTaskResult, "backups">,
): string {
  switch (step.kind) {
    case "saveName":
      return `Saved "${step.name}" as your name in this repo.`;
    case "createBranch":
      return step.carry
        ? `You're now on your own branch ${step.branch}, with your ${describeCarried(step.carriedFiles, step.carriedCommits)}.`
        : `You're now on your own branch ${step.branch}, starting from the team's latest main.`;
    case "moveMain": {
      const backup = result.backups.find((b) => b.of === plan.mainBranch)?.ref ?? "a backup ref";
      return `Moved your ${plan.mainBranch} back to match the team's. Your old ${plan.mainBranch} is backed up as ${backup}. To put it back: \`git branch -f ${plan.mainBranch} ${backup}\`.`;
    }
    case "fastForwardMain":
      return `Updated your ${plan.mainBranch} to the team's latest ${plan.mainBranch}.`;
    case "push": {
      const create = plan.steps.find((s) => s.kind === "createBranch");
      const unsaved = create?.kind === "createBranch" ? create.carriedFiles : 0;
      return unsaved > 0
        ? `Uploaded ${step.branch} to the team repo. Your unsaved changes are still only on your computer until you Save.`
        : `Uploaded ${step.branch} to the team repo.`;
    }
  }
}

/** What Start task did, step by step, and what went wrong if anything. */
export function explainStartTaskResult(plan: StartTaskPlan, result: StartTaskResult): string[] {
  const lines = result.completed.map((step) => explainDoneStep(step, plan, result));
  if (result.pushProblem) {
    const [meaning, whatToDo] = explainRemoteProblem(result.pushProblem);
    lines.push(
      `Your branch ${plan.branch} is safe on your computer, but uploading it failed. ${meaning}`,
      `${whatToDo} Then Save will upload it.`,
    );
  } else if (result.failedStep) {
    lines.push(
      `I stopped before this step: ${result.failedStep.description} Reason: ${endSentence(result.error ?? "unknown error")}`,
      result.completed.length === 0
        ? "Nothing was changed."
        : "Nothing after that was changed.",
    );
  }
  return lines;
}

// --- Save ------------------------------------------------------------------

const SECRET_REASONS: Record<SecretReason, string> = {
  fileName: "its name looks like a secrets file",
  awsKey: "it looks like it contains an AWS key",
  githubToken: "it looks like it contains a GitHub token",
  apiKey: "it looks like it contains an API key",
  privateKey: "it looks like it contains a private key",
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** A yes/no question about one risky file, and what "yes" means. */
export function riskyFileQuestion(risky: RiskyFile): {
  question: string;
  defaultAnswer: boolean;
  /** True: "yes" includes the file. False: "yes" leaves it out (and ignores it). */
  yesIncludes: boolean;
} {
  switch (risky.kind) {
    case "secret":
      return {
        question: `${risky.path} may be a secret: ${SECRET_REASONS[risky.reason]}. Include it in the save? Anyone with repo access could see it.`,
        defaultAnswer: false,
        yesIncludes: true,
      };
    case "generated":
      return {
        question: `${risky.path} looks like generated files (${plural(risky.fileCount, "file")}) that don't belong in Git. Leave it out and add it to .gitignore?`,
        defaultAnswer: true,
        yesIncludes: false,
      };
    case "large":
      return {
        question: `${risky.path} is ${megabytes(risky.sizeBytes)}, too big for Git. Leave it out and add it to .gitignore?`,
        defaultAnswer: true,
        yesIncludes: false,
      };
  }
}

function describeIgnoreEntries(entries: string[]): string {
  return entries.length === 1 ? (entries[0] ?? "") : `${entries.slice(0, -1).join(", ")} and ${entries.at(-1)}`;
}

/** One plain-English line saying what a Save step will do. */
export function describeSaveStep(step: SaveStepData): string {
  switch (step.kind) {
    case "ignore":
      return `Add ${describeIgnoreEntries(step.entries)} to .gitignore so Git leaves ${step.entries.length === 1 ? "it" : "them"} out from now on.`;
    case "commit":
      return `Save ${plural(step.files.length, "file")} as a commit (a snapshot of your work): "${step.message}".`;
    case "upload":
      return `Upload it to ${step.branch} on the team repo.`;
    default:
      return describeStartTaskStep(step);
  }
}

/** Asked after a secret is left out, if it can go into .gitignore. */
export function secretIgnoreQuestion(path: string): { question: string; defaultAnswer: boolean } {
  return { question: `Add ${path} to .gitignore so Git never asks again?`, defaultAnswer: true };
}

/** Lines about risky files left out of the commit. */
export function explainLeftOutFiles(plan: SavePlan): string[] {
  return plan.risky
    .filter((risky) => !plan.choices[risky.path])
    .map((risky) => {
      const ignoring = willIgnore(plan, risky) ? " and adding it to .gitignore" : "";
      return risky.kind === "secret"
        ? `Leaving out ${risky.path}${ignoring}: ${SECRET_REASONS[risky.reason]}. It stays on your computer.`
        : `Leaving out ${risky.path}${ignoring}.`;
    });
}

/** Why Save won't run, or that there's nothing to do. */
export function explainSaveRefusal(plan: SavePlan): string[] {
  if (plan.nothingToSave) return ["Nothing to save, you're all set."];
  if (plan.refusal === "noIdentity") {
    return [
      "Git doesn't know your name and email yet, and every save records who made it.",
      'Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then Save again.',
    ];
  }
  if (plan.startTask && !plan.startTask.canRun) return explainStartTaskRefusal(plan.startTask);
  const { summary, next } = explainDiagnosis(plan.diagnosis, plan.mainBranch);
  return ["I can't save right now.", ...summary, next];
}

/** Warnings for secret-looking files that were committed before. Never blocks a save. */
export function explainTrackedSecrets(plan: SavePlan): string[] {
  return plan.risky
    .filter((risky) => risky.kind === "secret" && risky.tracked)
    .map(
      (risky) =>
        `Warning: ${risky.path} is already in the repo history (it was saved before), so anyone with access to the repo may already have the key. Replace the key: make a new one and cancel the old one. Removing the file isn't enough.`,
    );
}

/** Lines shown with the plan, before asking to continue. */
export function explainSavePlan(plan: SavePlan): string[] {
  const lines = [...explainTrackedSecrets(plan), ...explainLeftOutFiles(plan)];
  if (plan.uploadBlocked) {
    lines.push(
      `The team repo's copy of ${plan.branch} has commits you don't have, so I'll save on your computer only. Sync, then Save again to upload.`,
    );
  }
  return lines;
}

/** What Save did, step by step, and what went wrong if anything. */
export function explainSaveResult(plan: SavePlan, result: SaveResult): string[] {
  const lines = result.completed.map((step) => {
    switch (step.kind) {
      case "ignore":
        return `Added ${describeIgnoreEntries(step.entries)} to .gitignore.`;
      case "commit":
        return `Saved ${plural(step.files.length, "file")} as a commit: "${step.message}".`;
      case "upload":
        return `Uploaded your work to ${step.branch} on the team repo.`;
      default:
        return plan.startTask ? explainDoneStep(step, plan.startTask, result) : step.description;
    }
  });
  const committed = result.completed.some((step) => step.kind === "commit");

  if (result.pushRejected) {
    lines.push(
      `Didn't upload: the team repo's copy of ${plan.branch} has commits you don't have.${committed ? " Your work is saved on this computer." : ""}`,
      "Sync to bring those commits in, then Save again.",
    );
  } else if (result.pushProblem) {
    const [meaning, whatToDo] = explainRemoteProblem(result.pushProblem);
    lines.push(
      `Your work is saved only on this computer: uploading failed. ${meaning}`,
      `${whatToDo} Then Save again to upload.`,
    );
  } else if (result.failedStep) {
    lines.push(
      `I stopped before this step: ${result.failedStep.description} Reason: ${endSentence(result.error ?? "unknown error")}`,
      result.completed.length === 0 ? "Nothing was changed." : "Nothing after that was changed.",
    );
  } else if (plan.uploadBlocked && committed) {
    lines.push(
      `Saved on this computer only, because the team repo's copy of ${plan.branch} has commits you don't have. Sync, then Save again to upload.`,
    );
  }
  return lines;
}

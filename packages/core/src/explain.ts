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
import type { SyncConflict, SyncPlan, SyncResult, SyncStepData } from "./sync.js";
import type { RemoteBranch, TeamProblem, TeamStatus } from "./team-status.js";
import type { MyProblem } from "./my-problems.js";
import type { FileOverlap, LineRange, MainConflictPreview, OverlapWithMe } from "./overlaps.js";
import { gitignoreEntry, type RiskyFile, type SecretReason } from "./risky-files.js";

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
      return "Next: Share changes";
    case "sync":
      return "Next: Sync";
    case null:
      return "Nothing to do, keep coding.";
  }
}

/** A few words for the next step (status bars, buttons). Null if nothing to do. */
export function shortNextAction(d: Diagnosis): string | null {
  switch (d.nextAction) {
    case "startTask":
      return "Start task";
    case "save":
      return "Share changes";
    case "sync":
      return "Sync";
    case "finishOperation":
      return `finish the ${d.inProgress ?? "operation"}`;
    case "askCaptain":
      return "ask your captain";
    case "fixAccess":
      return "fix access";
    case null:
      return null;
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

  const notSharedFiles = d.dirtyFiles.filter((file) => !d.conflictedFiles.includes(file));
  if (d.conflictedFiles.length > 0) {
    sentences.push(
      `You have ${plural(d.conflictedFiles.length, "file")} with conflicts: ${listFiles(d.conflictedFiles)}.`,
    );
    if (notSharedFiles.length > 0) {
      sentences.push(
        `You also have ${plural(notSharedFiles.length, "other changed file")}: ${listFiles(notSharedFiles)}.`,
      );
    }
  } else {
    sentences.push(
      notSharedFiles.length === 0
        ? "You have no changes waiting to be shared."
        : `You have ${plural(notSharedFiles.length, "file")} not shared yet: ${listFiles(notSharedFiles)}.`,
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
  if (files > 0) parts.push(plural(files, "changed file"));
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
        `You have changes on your branch ${plan.diagnosis.currentBranch} that aren't shared yet. Share your changes first, then start a new task.`,
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
      const notShared = create?.kind === "createBranch" ? create.carriedFiles : 0;
      return notShared > 0
        ? `Uploaded ${step.branch} to the team repo. Your changes are still only on your computer until you share them.`
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
      `${whatToDo} Then Share changes will upload it.`,
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

/** Why a file is risky, in a few words (for lists like a quick pick). */
export function riskyFileReason(risky: RiskyFile): string {
  switch (risky.kind) {
    case "secret":
      return `may be a secret: ${SECRET_REASONS[risky.reason]}`;
    case "generated":
      return risky.path.endsWith("/")
        ? `generated files (${plural(risky.fileCount, "file")}) that don't belong in Git`
        : "a build output (an archive, installer or large binary file) that doesn't belong in Git";
    case "large":
      return `${megabytes(risky.sizeBytes)}, too big for Git`;
  }
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
        question: `${risky.path} may be a secret: ${SECRET_REASONS[risky.reason]}. Include it when you share? Anyone with repo access could see it.`,
        defaultAnswer: false,
        yesIncludes: true,
      };
    case "generated":
      return {
        question: `${risky.path} looks like ${riskyFileReason(risky)}. Leave it out and add ${risky.ignoreEntry === risky.path ? "it" : risky.ignoreEntry} to .gitignore?`,
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

/** "a", "a and b", "a, b and c". */
function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function describeIgnoreEntries(entries: string[]): string {
  return listWords(entries);
}

/** One plain-English line saying what a Save step will do. */
export function describeSaveStep(step: SaveStepData): string {
  switch (step.kind) {
    case "ignore":
      return `Add ${describeIgnoreEntries(step.entries)} to .gitignore so Git leaves ${step.entries.length === 1 ? "it" : "them"} out from now on.`;
    case "commit":
      return `Commit ${plural(step.files.length, "file")} (a snapshot of your work): "${step.message}".`;
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
      const entry = gitignoreEntry(risky);
      const ignoring = willIgnore(plan, risky)
        ? ` and adding ${entry === risky.path ? "it" : entry} to .gitignore`
        : "";
      return risky.kind === "secret"
        ? `Leaving out ${risky.path}${ignoring}: ${SECRET_REASONS[risky.reason]}. It stays on your computer.`
        : `Leaving out ${risky.path}${ignoring}.`;
    });
}

/** Why Save won't run, or that there's nothing to do. */
export function explainSaveRefusal(plan: SavePlan): string[] {
  if (plan.nothingToSave) return ["Nothing to share, you're all set."];
  if (plan.refusal === "noIdentity") {
    return [
      "Git doesn't know your name and email yet, and every shared change records who made it.",
      'Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then share your changes again.',
    ];
  }
  if (plan.startTask && !plan.startTask.canRun) return explainStartTaskRefusal(plan.startTask);
  const { summary, next } = explainDiagnosis(plan.diagnosis, plan.mainBranch);
  return ["I can't share your changes right now.", ...summary, next];
}

/** Warnings for secret-looking files that were committed before. Never blocks a save. */
export function explainTrackedSecrets(plan: SavePlan): string[] {
  return plan.risky
    .filter((risky) => risky.kind === "secret" && risky.tracked)
    .map(
      (risky) =>
        `Warning: ${risky.path} is already in the repo history (it was committed before), so anyone with access to the repo may already have the key. Replace the key: make a new one and cancel the old one. Removing the file isn't enough.`,
    );
}

/** Lines shown with the plan, before asking to continue. */
export function explainSavePlan(plan: SavePlan): string[] {
  const lines = [...explainTrackedSecrets(plan), ...explainLeftOutFiles(plan)];
  if (plan.uploadBlocked) {
    lines.push(
      `The team repo's copy of ${plan.branch} has commits you don't have, so I'll commit on your computer only. Sync, then share your changes again to upload them.`,
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
        return `Committed ${plural(step.files.length, "file")}: "${step.message}".`;
      case "upload":
        return `Uploaded your work to ${step.branch} on the team repo.`;
      default:
        return plan.startTask ? explainDoneStep(step, plan.startTask, result) : step.description;
    }
  });
  const committed = result.completed.some((step) => step.kind === "commit");

  if (result.pushRejected) {
    lines.push(
      `Didn't upload: the team repo's copy of ${plan.branch} has commits you don't have.${committed ? " Your work is committed on this computer." : ""}`,
      "Sync to bring those commits in, then share your changes again.",
    );
  } else if (result.pushProblem) {
    const [meaning, whatToDo] = explainRemoteProblem(result.pushProblem);
    lines.push(
      `Your work is committed, but only on this computer: uploading failed. ${meaning}`,
      `${whatToDo} Then share your changes again to upload them.`,
    );
  } else if (result.failedStep) {
    lines.push(
      `I stopped before this step: ${result.failedStep.description} Reason: ${endSentence(result.error ?? "unknown error")}`,
      result.completed.length === 0 ? "Nothing was changed." : "Nothing after that was changed.",
    );
  } else if (plan.uploadBlocked && committed) {
    lines.push(
      `Committed on this computer only, because the team repo's copy of ${plan.branch} has commits you don't have. Sync, then share your changes again to upload them.`,
    );
  }
  return lines;
}

// --- Sync ------------------------------------------------------------------

/** One plain-English line saying what a Sync step will do. */
export function describeSyncStep(step: SyncStepData): string {
  switch (step.kind) {
    case "merge":
      return `Back up ${step.branch}, then bring in ${plural(step.commits, "new commit")} from main (a merge: Git combines main's changes with yours).`;
    case "upload":
      return `Upload ${step.branch} to the team repo.`;
  }
}

const MAX_HUNKS_SHOWN = 3;
const MAX_LINES_PER_SIDE = 6;

function indentSide(lines: string[]): string[] {
  if (lines.length === 0 || lines.every((line) => line.trim() === "")) {
    return ["    (nothing: these lines were removed)"];
  }
  const shown = lines.slice(0, MAX_LINES_PER_SIDE).map((line) => `    ${line}`);
  const hidden = lines.length - MAX_LINES_PER_SIDE;
  return hidden > 0 ? [...shown, `    … and ${plural(hidden, "more line")}`] : shown;
}

function possessive(names: string[]): string {
  return names.length === 0 ? "The version" : `${listWords(names)}'s version`;
}

function explainConflictHunks(conflict: SyncConflict, mainBranch: string): string[] {
  const lines: string[] = [];
  for (const hunk of conflict.hunks.slice(0, MAX_HUNKS_SHOWN)) {
    lines.push(
      "  Your version:",
      ...indentSide(hunk.yours),
      `  ${possessive(conflict.authors)} on ${mainBranch}:`,
      ...indentSide(hunk.theirs),
    );
  }
  const hidden = conflict.hunks.length - MAX_HUNKS_SHOWN;
  if (hidden > 0) lines.push(`  and ${hidden} more`);
  return lines;
}

function explainConflicts(plan: SyncPlan): string[] {
  const lines = [
    `Syncing now would cause a conflict: ${plan.mainBranch} changed the same lines you did. I didn't change anything.`,
  ];
  for (const conflict of plan.conflicts) {
    lines.push(
      conflict.authors.length > 0
        ? `${listWords(conflict.authors)} changed the same part of ${conflict.path}. Talk to them before syncing.`
        : `${conflict.path} was also changed on ${plan.mainBranch}. Find out who changed it before syncing.`,
      ...explainConflictHunks(conflict, plan.mainBranch),
    );
  }
  const authors = [...new Set(plan.conflicts.flatMap((conflict) => conflict.authors))];
  const who = authors.length > 0 ? listWords(authors) : "your team";
  const files = plan.conflicts.length === 1 ? "your file" : "your files";
  lines.push(
    `Next: agree with ${who} on one version, edit ${files} to match it exactly, share your changes, then Sync.`,
  );
  return lines;
}

/** Why Sync won't run: refused, already up to date, or a predicted conflict. */
export function explainSyncRefusal(plan: SyncPlan): string[] {
  if (plan.upToDate) return [`You already have everything from ${plan.mainBranch}.`];
  if (plan.conflicts.length > 0) return explainConflicts(plan);
  switch (plan.refusal) {
    case "saveFirst":
      return ["You have changes that aren't shared yet. Share your changes first, then Sync."];
    case "noIdentity":
      return [
        "Git doesn't know your name and email yet, and a merge records who made it.",
        'Run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then Sync again.',
      ];
    case "noMainOnRemote":
      return [`The team repo has no ${plan.mainBranch} branch to sync with yet.`];
    default: {
      const { summary, next } = explainDiagnosis(plan.diagnosis, plan.mainBranch);
      return ["I can't sync right now.", ...summary, next];
    }
  }
}

/** What Sync did, and what went wrong if anything. */
export function explainSyncResult(plan: SyncPlan, result: SyncResult): string[] {
  const backup = result.backups[0]?.ref ?? "a backup ref";
  const lines = result.completed.map((step) =>
    step.kind === "merge"
      ? `Backed up ${step.branch} as ${backup}, then merged ${plural(step.commits, "new commit")} from ${plan.mainBranch}.`
      : `Uploaded ${step.branch} to the team repo.`,
  );
  const reason = endSentence(result.error ?? "unknown error");

  if (result.failedStep?.kind === "merge") {
    lines.push(
      result.restored
        ? `The merge failed, so I put ${plan.branch} back exactly as it was. Reason: ${reason}`
        : `The merge failed and I couldn't put ${plan.branch} back by myself. Your work is safe in ${backup}. Ask your captain to run \`git merge --abort\` and \`git reset --keep ${backup}\`.`,
    );
  } else if (result.pushRejected) {
    lines.push(
      `Didn't upload: the team repo's copy of ${plan.branch} has commits you don't have. The merge is committed on this computer.`,
      "Ask your captain how to combine the two copies of your branch.",
    );
  } else if (result.pushProblem) {
    const [meaning, whatToDo] = explainRemoteProblem(result.pushProblem);
    lines.push(
      `The merge is committed, but only on this computer: uploading failed. ${meaning}`,
      `${whatToDo} Then share your changes to upload it.`,
    );
  } else if (result.failedStep) {
    lines.push(`I stopped before this step: ${result.failedStep.description} Reason: ${reason}`, "Nothing was changed.");
  }
  return lines;
}

// --- Team status -----------------------------------------------------------

/** "just now", "25 min ago", "3 h ago", "2 days ago". */
export function timeAgo(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function explainTeamProblem(problem: TeamProblem, mainBranch: string): string {
  switch (problem.kind) {
    case "conflictWithMain": {
      const { owner, branch, conflicts } = problem;
      const files = listWords(conflicts.map((c) => c.path));
      const authors = [...new Set(conflicts.flatMap((c) => c.mainAuthors))].filter((a) => a !== owner);
      return authors.length > 0
        ? `${owner}'s ${branch} would conflict with ${mainBranch} in ${files} (changed on ${mainBranch} by ${listWords(authors)}). ${owner} should agree with ${listWords(authors)} on one version, then share changes and Sync.`
        : `${owner}'s ${branch} would conflict with ${mainBranch} in ${files}. ${owner} should look at what changed on ${mainBranch}, then share changes and Sync.`;
    }
    case "overlap": {
      const { branches: [a, b], owners: [ownerA, ownerB], files } = problem.overlap;
      return ownerA === ownerB
        ? `${ownerA}'s ${a} and ${b} change the same part of ${listWords(files)}. ${ownerA} should settle on one version before either goes into ${mainBranch}.`
        : `${ownerA} (${a}) and ${ownerB} (${b}) changed the same part of ${listWords(files)}. They should agree on one version now, before either one's work goes into ${mainBranch}.`;
    }
    case "farBehind":
      return `${problem.owner}'s ${problem.branch} is ${problem.behind} commits behind ${mainBranch}. ${problem.owner} should Sync soon, while it's still easy.`;
  }
}

/** Short status for one table row: the most urgent thing about the branch. */
function branchStatusLabel(branch: RemoteBranch, status: TeamStatus): string {
  const problems = status.problems.filter((p) =>
    p.kind === "overlap" ? p.overlap.branches.includes(branch.branch) : p.branch === branch.branch,
  );
  const first = problems[0];
  if (!first) return "ok";
  switch (first.kind) {
    case "conflictWithMain":
      return `conflicts with ${status.mainBranch}`;
    case "overlap": {
      const others = problems
        .filter((p): p is Extract<TeamProblem, { kind: "overlap" }> => p.kind === "overlap")
        .map((p) => p.overlap.owners[p.overlap.branches[0] === branch.branch ? 1 : 0]);
      return `overlaps ${listWords([...new Set(others)])}`;
    }
    case "farBehind":
      return "far behind";
  }
}

function formatTable(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  return rows.map((row) =>
    row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd(),
  );
}

export const TEAM_STATUS_FOOTER = "This only shows shared work. Ask everyone to share changes often.";

/** The table of active branches as aligned text lines, header first. Empty if none. */
export function teamStatusTable(status: TeamStatus): string[] {
  if (status.branches.length === 0) return [];
  return formatTable([
    ["who", "branch", "last shared", "ahead/behind", "status"],
    ...status.branches.map((b) => [
      b.owner,
      b.branch,
      timeAgo(b.lastSave, status.now),
      `+${b.ahead} / -${b.behind}`,
      branchStatusLabel(b, status),
    ]),
  ]);
}

/** "and 2 old branches (not shared for over a day)", or null if there are none. */
export function explainOldBranches(status: TeamStatus): string | null {
  return status.oldBranches.length > 0
    ? `and ${plural(status.oldBranches.length, "old branch")} (not shared for over a day)`
    : null;
}

/** The whole Team status report, line by line, problems first. */
export function explainTeamStatus(status: TeamStatus): string[] {
  const lines: string[] = [];
  if (status.remoteProblem) {
    const [meaning] = explainRemoteProblem(status.remoteProblem);
    lines.push(`I couldn't reach the team repo, so this is from the last time I could. ${meaning}`, "");
  }

  if (status.problems.length === 0) {
    lines.push("No problems. Everyone's work combines cleanly.");
  } else {
    lines.push(`${plural(status.problems.length, "problem")}, most urgent first:`);
    status.problems.forEach((problem, i) =>
      lines.push(`  ${i + 1}. ${explainTeamProblem(problem, status.mainBranch)}`),
    );
  }
  lines.push("");

  const table = teamStatusTable(status);
  lines.push(...(table.length > 0 ? table : ["Nobody has shared work in the last day."]));
  const old = explainOldBranches(status);
  if (old) lines.push(old);

  lines.push("", TEAM_STATUS_FOOTER);
  return lines;
}

// --- Panel: headline, problems, messages -----------------------------------

/** Compact duration: "15m", "2h", "3d" ("<1m" below a minute: display it via ago() or approxAge(), which say "just now"). */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const MINUTE_MS = 60_000;

/** Age of an overlap or conflict, e.g. "~20m" (oldest commit involved), or "just now". */
export function approxAge(since: Date, now: Date): string {
  const ms = now.getTime() - since.getTime();
  return ms < MINUTE_MS ? "just now" : `~${shortDuration(ms)}`;
}

/** "just now", "5m ago", "2h ago". */
export function ago(date: Date, now: Date): string {
  const ms = now.getTime() - date.getTime();
  return ms < MINUTE_MS ? "just now" : `${shortDuration(ms)} ago`;
}

/** " (line 2)", " (lines 2–5)", or "" when there are no ranges. */
function describeLines(ranges: LineRange[]): string {
  if (ranges.length === 0) return "";
  const start = Math.min(...ranges.map((r) => r.start));
  const end = Math.max(...ranges.map((r) => r.end));
  return start === end ? ` (line ${start})` : ` (lines ${start}–${end})`;
}

export type Severity = "error" | "warning" | "info" | "ok";

const SEVERITY_RANK: Record<Severity, number> = { ok: 0, info: 1, warning: 2, error: 3 };

/** Why the primary button is the next step. */
function primaryReason(d: Diagnosis, mainBranch: string): [string, Severity] {
  const files = d.dirtyFiles.length;
  switch (d.nextAction) {
    case "finishOperation":
      return [`You're in the middle of ${OPERATION_DESCRIPTIONS[d.inProgress ?? "merge"]}.`, "error"];
    case "askCaptain":
      return ["You're not on any branch right now.", "warning"];
    case "fixAccess":
      return ["I can't reach the team repo.", "warning"];
    case "startTask":
      return files > 0
        ? [`You're on ${mainBranch} with ${plural(files, "file")} not shared.`, "info"]
        : [`You're on ${mainBranch}, the branch the whole team shares.`, "info"];
    case "save":
      return [`You have ${plural(files, "file")} not shared.`, "info"];
    case "sync":
      return [`${capitalize(mainBranch)} has ${plural(d.behindMain ?? 0, "new commit")} for you.`, "info"];
    case null:
      return ["You're in sync.", "ok"];
  }
}

/** The most important thing about me that the primary button doesn't fix. */
function problemNote(problems: MyProblem[], mainBranch: string): [string, Severity] | null {
  const conflicts = problems.flatMap((p) => (p.kind === "mainConflict" ? [p.conflict] : []));
  if (conflicts.length > 0) {
    const authors = [...new Set(conflicts.flatMap((c) => c.authors))];
    const files = listWords(conflicts.map((c) => c.path));
    const who = authors.length > 0 ? listWords(authors) : "the team";
    return [`${files} would conflict with ${mainBranch} — talk to ${who} before syncing.`, "error"];
  }
  const overlaps = problems.flatMap((p) => (p.kind === "overlapWithMe" ? [p] : []));
  if (overlaps.length > 0) {
    const names = [...new Set(overlaps.flatMap((p) => (p.file.authors.length > 0 ? p.file.authors : [p.overlap.owner])))];
    const ranges = overlaps.flatMap((p) => p.file.ranges.map((r) => r.mine));
    const what =
      ranges.length === 0
        ? "the same file"
        : ranges.length === 1 && ranges[0]?.start === ranges[0]?.end
          ? "the same line"
          : "the same lines";
    return [`${listWords(names)} changed ${what} — talk before your work goes into ${mainBranch}.`, "warning"];
  }
  return null;
}

/**
 * The sentence at the top of the panel: why the primary button is the next
 * step, then the most important problem about me (a conflict or an overlap).
 */
export function headline(
  d: Diagnosis,
  problems: MyProblem[],
  mainBranch = "main",
): { severity: Severity; sentence: string } {
  const [reason, reasonSeverity] = primaryReason(d, mainBranch);
  const note = problemNote(problems, mainBranch);
  if (!note) return { severity: reasonSeverity, sentence: reason };
  const [text, noteSeverity] = note;
  const severity = SEVERITY_RANK[noteSeverity] > SEVERITY_RANK[reasonSeverity] ? noteSeverity : reasonSeverity;
  return { severity, sentence: `${reason} ${text}` };
}

function fileName(file: string): string {
  return file.split("/").pop() ?? file;
}

/** A few words that fit a narrow sidebar: "hank: conflict with main", "alice + frank: same code in app.js". */
export function shortProblemLabel(problem: MyProblem, mainBranch = "main"): string {
  switch (problem.kind) {
    case "mainConflict":
      return `you: conflict with ${mainBranch} in ${fileName(problem.conflict.path)}`;
    case "overlapWithMe":
      return `${problem.overlap.owner} + you: same code in ${fileName(problem.file.path)}`;
    case "team": {
      const p = problem.problem;
      switch (p.kind) {
        case "conflictWithMain":
          return `${p.owner}: conflict with ${mainBranch}`;
        case "overlap": {
          const [a, b] = p.overlap.owners;
          const who = a === b ? a : `${a} + ${b}`;
          const [first, ...rest] = p.overlap.files;
          const more = rest.length > 0 ? ` (+${rest.length})` : "";
          return `${who}: same code in ${fileName(first ?? "")}${more}`;
        }
        case "farBehind":
          return `${p.owner}: ${p.behind} behind ${mainBranch}`;
      }
    }
  }
}

/** One line for a problem in the panel or the Team view. */
export function explainMyProblem(problem: MyProblem, now: Date, mainBranch = "main"): string {
  switch (problem.kind) {
    case "mainConflict": {
      const { path, authors, since } = problem.conflict;
      const who = authors.length > 0 ? ` (${listWords(authors)})` : "";
      return `Syncing would conflict in ${path}${who} · ${approxAge(since, now)}`;
    }
    case "overlapWithMe": {
      const { file, overlap } = problem;
      return `${listWords(file.authors.length > 0 ? file.authors : [overlap.owner])} also changed ${file.path}${describeLines(file.ranges.map((r) => r.mine))} · ${approxAge(file.since, now)}`;
    }
    case "team":
      return explainTeamProblem(problem.problem, mainBranch);
  }
}

/** A ready-to-send chat message about an overlap with me. */
export function overlapMessage(overlap: OverlapWithMe, file: FileOverlap, myBranch: string): string {
  const names = file.authors.length > 0 ? file.authors : [overlap.owner];
  return `Hi ${listWords(names)}, I'm also changing ${file.path}${describeLines(file.ranges.map((r) => r.mine))} on ${myBranch}, and you changed it on ${overlap.branch}. Can we agree who keeps what before either of our changes goes into main?`;
}

/** A ready-to-send chat message about my predicted conflict with main. */
export function conflictMessage(conflict: MainConflictPreview, myBranch: string, mainBranch = "main"): string {
  const names = conflict.authors.length > 0 ? listWords(conflict.authors) : "team";
  return `Hi ${names}, my branch ${myBranch} would conflict with ${mainBranch} in ${conflict.path}: we changed the same lines. Can we agree on one version before I sync?`;
}

/** A ready-to-send chat message for any problem in the list. */
export function problemMessage(problem: MyProblem, myBranch: string, mainBranch = "main"): string {
  switch (problem.kind) {
    case "mainConflict":
      return conflictMessage(problem.conflict, myBranch, mainBranch);
    case "overlapWithMe":
      return overlapMessage(problem.overlap, problem.file, myBranch);
    case "team": {
      const p = problem.problem;
      switch (p.kind) {
        case "conflictWithMain": {
          const files = listWords(p.conflicts.map((c) => c.path));
          const authors = [...new Set(p.conflicts.flatMap((c) => c.mainAuthors))].filter((a) => a !== p.owner);
          const withWhom = authors.length > 0 ? ` (changed there by ${listWords(authors)})` : "";
          return `Hi ${p.owner}, your branch ${p.branch} would conflict with ${mainBranch} in ${files}${withWhom}. Can you agree on one version, then share your changes and Sync?`;
        }
        case "overlap": {
          const { branches: [a, b], owners, files } = p.overlap;
          return `Hi ${listWords([...new Set(owners)])}, ${a} and ${b} change the same part of ${listWords(files)}. Can you agree on one version before either goes into ${mainBranch}?`;
        }
        case "farBehind":
          return `Hi ${p.owner}, ${p.branch} is ${p.behind} commits behind ${mainBranch}. Could you Sync soon, while it's still easy?`;
      }
    }
  }
}

/** Short status of a team member for the Team view, most urgent first. */
export function memberStatus(
  owner: string,
  branches: RemoteBranch[],
  problems: MyProblem[],
  now: Date,
  mainBranch = "main",
): string {
  const overlap = problems.find((p) => p.kind === "overlapWithMe" && p.overlap.owner === owner);
  if (overlap?.kind === "overlapWithMe") return `overlaps you · ${approxAge(overlap.file.since, now)}`;
  const team = problems.flatMap((p) => (p.kind === "team" ? [p.problem] : []));
  const mine = new Set(branches.map((b) => b.branch));
  for (const p of team) {
    if (p.kind === "conflictWithMain" && mine.has(p.branch)) return `conflict with ${mainBranch}`;
    if (p.kind === "overlap" && p.overlap.branches.some((b) => mine.has(b))) return "overlaps a teammate";
    if (p.kind === "farBehind" && mine.has(p.branch)) return `${p.behind} behind ${mainBranch}`;
  }
  const latest = branches.reduce<Date | null>((max, b) => (!max || b.lastSave > max ? b.lastSave : max), null);
  return latest ? `last shared ${ago(latest, now)}` : "nothing shared yet";
}

export type StatusBarKind = "conflict" | "toShare" | "sync" | "attention" | "inSync";

/** Short status bar text: "Conflict in src/config.js", "1 to share", "Next: Sync", "In sync". */
export function statusBarSummary(
  d: Diagnosis,
  conflicts: MainConflictPreview[],
): { kind: StatusBarKind; text: string } {
  const conflict = conflicts[0];
  if (conflict) return { kind: "conflict", text: `Conflict in ${conflict.path}` };
  if (d.dirtyFiles.length > 0) return { kind: "toShare", text: `${d.dirtyFiles.length} to share` };
  if (d.nextAction === "sync") return { kind: "sync", text: "Next: Sync" };
  const short = shortNextAction(d);
  if (short) return { kind: "attention", text: `Next: ${short}` };
  return { kind: "inSync", text: "In sync" };
}

#!/usr/bin/env node
// Thin CLI over @branchguard/core, used for manual testing.
// No Git logic here: every command calls core.
import path from "node:path";
import { parseArgs } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import {
  applySaveChoices,
  diagnose,
  executeSave,
  executeStartTask,
  explainDiagnosis,
  explainSavePlan,
  explainSaveRefusal,
  explainSaveResult,
  explainStartTaskRefusal,
  explainStartTaskResult,
  explainSyncRefusal,
  explainSyncResult,
  executeSync,
  planSync,
  planSave,
  planStartTask,
  riskyFileQuestion,
  secretIgnoreQuestion,
  slugify,
  type SavePlan,
} from "@branchguard/core";

const USAGE = `Usage:
  branchguard diagnose [dir]   show where you stand
  branchguard start [task] [--name <name>] [--yes]
                               start a new task on your own branch
                               --name  your name for branch names (skips the question)
                               --yes   don't ask anything, accept the defaults
  branchguard save [-m <message>] [--name <name>] [--yes]
                               commit your work and upload it to your own branch
                               -m      commit message (default: made from the file names)
                               --yes   accept the defaults: risky files are left out
  branchguard sync [--yes]     bring the latest main into your branch (only if it merges cleanly)`;

async function runDiagnose(dirArg: string | undefined): Promise<void> {
  const dir = path.resolve(dirArg ?? ".");
  const { summary, next } = explainDiagnosis(await diagnose(dir));
  console.log(summary.join(" "));
  console.log(next);
}

interface PromptFlags {
  name?: string;
  yes: boolean;
}

/** Checks flags shared by commands that prompt. Prints why and returns false if unusable. */
function checkPromptFlags(flags: PromptFlags): boolean {
  // Prompts need a terminal; without one they would wait forever.
  if (!flags.yes && !process.stdin.isTTY) {
    console.error("Run in a terminal or pass --yes");
    process.exitCode = 1;
    return false;
  }
  if (flags.name !== undefined && slugify(flags.name) === "") {
    console.error("--name needs at least one letter or number.");
    process.exitCode = 1;
    return false;
  }
  return true;
}

/** Asks for the branch-name prefix; returns the answer, or null if nothing to ask. */
async function askMemberName(
  nameIsNew: boolean,
  suggestion: string,
  flags: PromptFlags,
): Promise<string | null> {
  if (!nameIsNew || flags.name !== undefined || flags.yes) return null;
  const answer = await input({
    message: "What name should your branches start with?",
    default: suggestion,
    validate: (value) => slugify(value) !== "" || "Use at least one letter or number.",
  });
  return slugify(answer) === suggestion ? null : answer;
}

async function confirmPlan(lines: string[], notes: string[], flags: PromptFlags): Promise<boolean> {
  console.log("Here's what I'll do:");
  lines.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  for (const note of notes) console.log(note);
  if (flags.yes || (await confirm({ message: "Continue?", default: true }))) return true;
  console.log("OK, nothing was changed.");
  return false;
}

async function runStart(taskName: string | undefined, flags: PromptFlags): Promise<void> {
  if (!checkPromptFlags(flags)) return;

  const dir = process.cwd();
  let plan = await planStartTask(dir, { taskName, memberName: flags.name });
  if (!plan.canRun) {
    console.log(explainStartTaskRefusal(plan).join(" "));
    process.exitCode = 1;
    return;
  }

  const memberName = await askMemberName(plan.nameIsNew, plan.memberName, flags);
  if (memberName !== null) plan = await planStartTask(dir, { taskName, memberName });

  if (!(await confirmPlan(plan.steps.map((step) => step.description), [], flags))) return;
  const result = await executeStartTask(plan);
  for (const line of explainStartTaskResult(plan, result)) console.log(line);
  if (!result.ok) process.exitCode = 1;
}

async function ask(question: string, defaultAnswer: boolean, yes: boolean): Promise<boolean> {
  return yes ? defaultAnswer : confirm({ message: question, default: defaultAnswer });
}

/** Asks about each risky file (or takes the safe defaults with --yes). */
async function askAboutRiskyFiles(plan: SavePlan, yes: boolean): Promise<SavePlan> {
  const include: Record<string, boolean> = {};
  const ignore: Record<string, boolean> = {};
  for (const risky of plan.risky) {
    const { question, defaultAnswer, yesIncludes } = riskyFileQuestion(risky);
    include[risky.path] = (await ask(question, defaultAnswer, yes)) === yesIncludes;
    if (!include[risky.path] && plan.ignorableSecrets.includes(risky.path)) {
      const follow = secretIgnoreQuestion(risky.path);
      ignore[risky.path] = await ask(follow.question, follow.defaultAnswer, yes);
    }
  }
  return applySaveChoices(plan, include, ignore);
}

async function runSave(flags: PromptFlags & { message?: string }): Promise<void> {
  if (!checkPromptFlags(flags)) return;

  const dir = process.cwd();
  const options = { message: flags.message, memberName: flags.name };
  let plan = await planSave(dir, options);
  if (!plan.canRun) {
    console.log(explainSaveRefusal(plan).join(" "));
    if (!plan.nothingToSave) process.exitCode = 1;
    return;
  }

  if (plan.startTask) {
    const memberName = await askMemberName(plan.startTask.nameIsNew, plan.startTask.memberName, flags);
    if (memberName !== null) plan = await planSave(dir, { ...options, memberName });
  }
  plan = await askAboutRiskyFiles(plan, flags.yes);
  if (plan.steps.length === 0) {
    console.log([...explainSavePlan(plan), "Nothing left to save."].join(" "));
    return;
  }

  const lines = plan.steps.map((step) => step.description);
  if (!(await confirmPlan(lines, explainSavePlan(plan), flags))) return;
  const result = await executeSave(plan);
  for (const line of explainSaveResult(plan, result)) console.log(line);
  if (!result.ok) process.exitCode = 1;
}

async function runSync(flags: PromptFlags): Promise<void> {
  if (!checkPromptFlags(flags)) return;
  const plan = await planSync(process.cwd());
  if (!plan.canRun) {
    // A predicted conflict shows code, so keep its lines apart.
    console.log(explainSyncRefusal(plan).join(plan.conflicts.length > 0 ? "\n" : " "));
    if (!plan.upToDate) process.exitCode = 1;
    return;
  }
  if (!(await confirmPlan(plan.steps.map((step) => step.description), [], flags))) return;
  const result = await executeSync(plan);
  for (const line of explainSyncResult(plan, result)) console.log(line);
  if (!result.ok) process.exitCode = 1;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "diagnose":
      await runDiagnose(rest[0]);
      break;
    case "start": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { name: { type: "string" }, yes: { type: "boolean", short: "y", default: false } },
      });
      await runStart(positionals[0], { name: values.name, yes: values.yes ?? false });
      break;
    }
    case "save": {
      const { values } = parseArgs({
        args: rest,
        options: {
          message: { type: "string", short: "m" },
          name: { type: "string" },
          yes: { type: "boolean", short: "y", default: false },
        },
      });
      await runSave({ message: values.message, name: values.name, yes: values.yes ?? false });
      break;
    }
    case "sync": {
      const { values } = parseArgs({
        args: rest,
        options: { yes: { type: "boolean", short: "y", default: false } },
      });
      await runSync({ yes: values.yes ?? false });
      break;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Ctrl+C or closed input during a prompt: prompts come before any change.
  if (error instanceof Error && error.name === "ExitPromptError") {
    console.error("Cancelled. Nothing was changed.");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});

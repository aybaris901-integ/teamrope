#!/usr/bin/env node
// Thin CLI over @branchguard/core, used for manual testing.
// No Git logic here: every command calls core.
import path from "node:path";
import { parseArgs } from "node:util";
import { confirm, input } from "@inquirer/prompts";
import {
  diagnose,
  executeStartTask,
  explainDiagnosis,
  explainStartTaskRefusal,
  explainStartTaskResult,
  planStartTask,
  slugify,
} from "@branchguard/core";

const USAGE = `Usage:
  branchguard diagnose [dir]   show where you stand
  branchguard start [task] [--name <name>] [--yes]
                               start a new task on your own branch
                               --name  your name for branch names (skips the question)
                               --yes   don't ask anything, accept the defaults`;

async function runDiagnose(dirArg: string | undefined): Promise<void> {
  const dir = path.resolve(dirArg ?? ".");
  const { summary, next } = explainDiagnosis(await diagnose(dir));
  console.log(summary.join(" "));
  console.log(next);
}

interface StartFlags {
  name?: string;
  yes: boolean;
}

async function runStart(taskName: string | undefined, flags: StartFlags): Promise<void> {
  // Prompts need a terminal; without one they would wait forever.
  if (!flags.yes && !process.stdin.isTTY) {
    console.error("Run in a terminal or pass --yes");
    process.exitCode = 1;
    return;
  }

  if (flags.name !== undefined && slugify(flags.name) === "") {
    console.error("--name needs at least one letter or number.");
    process.exitCode = 1;
    return;
  }

  const dir = process.cwd();
  let plan = await planStartTask(dir, { taskName, memberName: flags.name });
  if (!plan.canRun) {
    console.log(explainStartTaskRefusal(plan).join(" "));
    process.exitCode = 1;
    return;
  }

  // Ask only if the name is neither saved nor given.
  if (plan.nameIsNew && flags.name === undefined && !flags.yes) {
    const memberName = await input({
      message: "What name should your branches start with?",
      default: plan.memberName,
      validate: (value) => slugify(value) !== "" || "Use at least one letter or number.",
    });
    if (slugify(memberName) !== plan.memberName) {
      plan = await planStartTask(dir, { taskName, memberName });
    }
  }

  console.log("Here's what I'll do:");
  plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step.description}`));
  if (!flags.yes && !(await confirm({ message: "Continue?", default: true }))) {
    console.log("OK, nothing was changed.");
    return;
  }

  const result = await executeStartTask(plan);
  for (const line of explainStartTaskResult(plan, result)) console.log(line);
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

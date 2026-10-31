#!/usr/bin/env node
// Thin CLI over @branchguard/core, used for manual testing.
// No Git logic here: every command calls core.
import path from "node:path";
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
  branchguard start [task]     start a new task on your own branch`;

async function runDiagnose(dirArg: string | undefined): Promise<void> {
  const dir = path.resolve(dirArg ?? ".");
  const { summary, next } = explainDiagnosis(await diagnose(dir));
  console.log(summary.join(" "));
  console.log(next);
}

async function runStart(taskName: string | undefined): Promise<void> {
  const dir = process.cwd();
  let plan = await planStartTask(dir, { taskName });
  if (!plan.canRun) {
    console.log(explainStartTaskRefusal(plan).join(" "));
    process.exitCode = 1;
    return;
  }

  if (plan.nameIsNew) {
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
  if (!(await confirm({ message: "Continue?", default: true }))) {
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
    case "start":
      await runStart(rest[0]);
      break;
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

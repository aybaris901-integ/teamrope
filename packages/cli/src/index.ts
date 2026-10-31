#!/usr/bin/env node
// Thin CLI over @branchguard/core, used for manual testing.
// No Git logic here: every command calls core.
import path from "node:path";
import { diagnose, explainDiagnosis } from "@branchguard/core";

const USAGE = "Usage: branchguard diagnose [dir]";

async function runDiagnose(dirArg: string | undefined): Promise<void> {
  const dir = path.resolve(dirArg ?? ".");
  const { summary, next } = explainDiagnosis(await diagnose(dir));
  console.log(summary.join(" "));
  console.log(next);
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "diagnose":
      await runDiagnose(rest[0]);
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

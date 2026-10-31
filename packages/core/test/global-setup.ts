// Rebuilds ./playground once before the whole test run.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const script = fileURLToPath(new URL("../../../scripts/broken-repo.sh", import.meta.url));
  execFileSync("bash", [script], { stdio: ["ignore", "ignore", "inherit"] });
}

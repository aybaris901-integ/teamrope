// Runs once before the whole test run:
// - rebuilds ./playground;
// - points HOME at a temp dir with a minimal .gitconfig, so tests never
//   depend on the developer's own global Git config.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITCONFIG = `[user]
\tname = teamrope tests
\temail = tests@example.com
[init]
\tdefaultBranch = main
`;

export default function setup(): () => void {
  const script = fileURLToPath(new URL("../../../scripts/broken-repo.sh", import.meta.url));
  execFileSync("bash", [script], { stdio: ["ignore", "ignore", "inherit"] });

  const home = mkdtempSync(path.join(tmpdir(), "teamrope-test-home-"));
  writeFileSync(path.join(home, ".gitconfig"), GITCONFIG);
  // Git also reads $XDG_CONFIG_HOME/git/config; keep that inside the temp HOME too.
  mkdirSync(path.join(home, ".config"));
  // Test workers start after this and inherit these variables.
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");

  return () => rmSync(home, { recursive: true, force: true });
}

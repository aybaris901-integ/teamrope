// Bundles the extension and @branchguard/core (with simple-git) into one file,
// and copies the codicon font for the webview (served locally, no CDN).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  logLevel: "info",
});

const require = createRequire(import.meta.url);
const codicons = path.dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
mkdirSync("dist/codicons", { recursive: true });
for (const file of ["codicon.css", "codicon.ttf"]) {
  copyFileSync(path.join(codicons, file), path.join("dist/codicons", file));
}

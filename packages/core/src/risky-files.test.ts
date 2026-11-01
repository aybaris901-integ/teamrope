import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BINARY_OUTPUT_BYTES,
  findRiskyFiles,
  LARGE_FILE_BYTES,
  type ChangedFile,
} from "./risky-files.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "teamrope-risky-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(name: string, content = "nothing secret\n", untracked = true): ChangedFile {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), content);
  return { path: name, untracked, deleted: false };
}

describe("findRiskyFiles", () => {
  test.each([
    [".env", "DEBUG=1\n", "fileName"],
    [".env.local", "DEBUG=1\n", "fileName"],
    ["certs/server.pem", "x\n", "fileName"],
    ["deploy.key", "x\n", "fileName"],
    ["id_rsa", "x\n", "fileName"],
    ["credentials-prod.json", "{}\n", "fileName"],
    ["config.js", 'const key = "AKIAIOSFODNN7EXAMPLE";\n', "awsKey"],
    ["ci.yml", `token: ghp_${"a".repeat(36)}\n`, "githubToken"],
    ["app.py", 'openai.api_key = "sk-test-4f8a1b2c3d4e5f6a7b8c9d0e"\n', "apiKey"],
    ["notes.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", "privateKey"],
  ])("%s is a secret (%s)", (name, content, reason) => {
    expect(findRiskyFiles(root, [file(name, content)])).toEqual([
      { kind: "secret", path: name, reason, tracked: false },
    ]);
  });

  test.each([
    [".env.example", "API_KEY=\n"],
    ["id_rsa.pub", "ssh-ed25519 AAAA\n"],
    ["tasks.md", "Ask-for-feedback task-manager-integration-notes\n"],
    ["README.md", "Put your private key in .env\n"],
  ])("%s is not a secret", (name, content) => {
    expect(findRiskyFiles(root, [file(name, content)])).toEqual([]);
  });

  test("new files in generated folders are grouped per folder", () => {
    const files = [
      file("node_modules/a/index.js"),
      file("node_modules/b/index.js"),
      file("web/dist/app.js"),
      file(".venv/bin/python"),
    ];
    expect(findRiskyFiles(root, files)).toEqual([
      { kind: "generated", path: "node_modules/", fileCount: 2, ignoreEntry: "node_modules/" },
      { kind: "generated", path: "web/dist/", fileCount: 1, ignoreEntry: "web/dist/" },
      { kind: "generated", path: ".venv/", fileCount: 1, ignoreEntry: ".venv/" },
    ]);
  });

  test("a tracked secret is marked as tracked", () => {
    expect(findRiskyFiles(root, [file(".env", "X=1\n", false)])).toEqual([
      { kind: "secret", path: ".env", reason: "fileName", tracked: true },
    ]);
  });

  test.each([
    ["packages/vscode/teamrope-0.0.1.vsix", "*.vsix"],
    ["release.zip", "*.zip"],
    ["dist-linux.TAR.GZ", "*.tar.gz"],
    ["setup.exe", "*.exe"],
    ["App.dmg", "*.dmg"],
  ])("new build output %s is generated (ignore %s)", (name, pattern) => {
    expect(findRiskyFiles(root, [file(name, "small\n")])).toEqual([
      { kind: "generated", path: name, fileCount: 1, ignoreEntry: pattern },
    ]);
  });

  test("a build output that's already tracked isn't flagged", () => {
    expect(findRiskyFiles(root, [file("docs/sample.zip", "x\n", false)])).toEqual([]);
  });

  test("a new binary file over 1 MB is generated; text or small binaries aren't", () => {
    const binary = (name: string, bytes: number): ChangedFile => {
      const changed = file(name, "");
      writeFileSync(path.join(root, name), Buffer.alloc(bytes, 0));
      return changed;
    };
    const big = binary("model.bin", BINARY_OUTPUT_BYTES + 1);
    const small = binary("icon.ico", 4096);
    const bigText = file("data.csv", "a,b\n".repeat(400_000));
    expect(findRiskyFiles(root, [big, small, bigText])).toEqual([
      { kind: "generated", path: "model.bin", fileCount: 1, ignoreEntry: "model.bin" },
    ]);
  });

  test("tracked files in dist/ are not flagged (committed on purpose)", () => {
    expect(findRiskyFiles(root, [file("dist/app.js", "x\n", false)])).toEqual([]);
  });

  test("files over 50 MB are flagged", () => {
    const big = file("video.mp4", "");
    truncateSync(path.join(root, "video.mp4"), LARGE_FILE_BYTES + 1);
    expect(findRiskyFiles(root, [big])).toEqual([
      { kind: "large", path: "video.mp4", sizeBytes: LARGE_FILE_BYTES + 1 },
    ]);
  });

  test("deleted files are skipped", () => {
    expect(findRiskyFiles(root, [{ path: ".env", untracked: false, deleted: true }])).toEqual([]);
  });
});

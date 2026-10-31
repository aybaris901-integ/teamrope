import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findRiskyFiles, LARGE_FILE_BYTES, type ChangedFile } from "./risky-files.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "branchguard-risky-"));
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
      { kind: "secret", path: name, reason },
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
      { kind: "generated", path: "node_modules/", fileCount: 2 },
      { kind: "generated", path: "web/dist/", fileCount: 1 },
      { kind: "generated", path: ".venv/", fileCount: 1 },
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

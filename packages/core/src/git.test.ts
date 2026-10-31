import { describe, expect, test } from "vitest";
import { cleanGitEnv, DEFAULT_SSH_COMMAND } from "./git.js";

describe("cleanGitEnv", () => {
  test("drops editors, pagers, password pop-ups and other rejected vars, keeps the rest", () => {
    const env = cleanGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_EDITOR: "code --wait",
      EDITOR: "vim",
      PAGER: "less",
      GIT_ASKPASS: "/vscode/askpass.sh",
      SSH_ASKPASS: "/usr/lib/ssh/askpass",
      PREFIX: "/data/data/com.termux/files/usr",
      GIT_EXTERNAL_DIFF: "difft",
      GIT_TEMPLATE_DIR: "/home/me/.git-templates",
      UNDEFINED_VAR: undefined,
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: DEFAULT_SSH_COMMAND,
    });
  });

  test("overrides a user's GIT_TERMINAL_PROMPT", () => {
    expect(cleanGitEnv({ GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("keeps the user's own GIT_SSH_COMMAND", () => {
    expect(cleanGitEnv({ GIT_SSH_COMMAND: "ssh -i key" }).GIT_SSH_COMMAND).toBe("ssh -i key");
  });

  test("doesn't override GIT_SSH or core.sshCommand", () => {
    expect(cleanGitEnv({ GIT_SSH: "/usr/bin/plink" }).GIT_SSH_COMMAND).toBeUndefined();
    expect(cleanGitEnv({}, true).GIT_SSH_COMMAND).toBeUndefined();
  });
});

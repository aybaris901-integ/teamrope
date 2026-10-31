import { describe, expect, test } from "vitest";
import { cleanGitEnv } from "./git.js";

describe("cleanGitEnv", () => {
  test("drops editors, pagers and password pop-ups, keeps the rest", () => {
    const env = cleanGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      GIT_EDITOR: "code --wait",
      EDITOR: "vim",
      PAGER: "less",
      GIT_ASKPASS: "/vscode/askpass.sh",
      SSH_ASKPASS: "/usr/lib/ssh/askpass",
      UNDEFINED_VAR: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/me", GIT_TERMINAL_PROMPT: "0" });
  });

  test("overrides a user's GIT_TERMINAL_PROMPT", () => {
    expect(cleanGitEnv({ GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe("0");
  });
});

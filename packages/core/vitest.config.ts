import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Like broken-repo.sh, ignore the system Git config. GIT_CONFIG_GLOBAL
    // can't be set here: simple-git's safety checks reject it.
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
    },
    testTimeout: 30_000,
  },
});

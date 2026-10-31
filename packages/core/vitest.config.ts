import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Ignore the system Git config. The global one is replaced by a temp HOME
    // in global-setup.ts (GIT_CONFIG_GLOBAL would be rejected by simple-git).
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
    },
    testTimeout: 30_000,
  },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_AUTH_TOKEN: "test-mailbox-token-0123456789",
          GROKBOT_WEBHOOK_URL: "https://hooks.test/grok",
          GROKBOT_WEBHOOK_TOKEN: "crsr_test_key",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});

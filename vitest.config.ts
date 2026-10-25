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
          // grokbot here must be ignored. cursor is delivered. gemini is refused
          // before fetch because the host is private.
          AGENT_WEBHOOKS: JSON.stringify({
            cursor: { url: "https://hooks.test/cursor", token: "cursor-token" },
            gemini: { url: "https://10.1.2.3/hook", token: "should-not-send" },
            grokbot: { url: "https://hooks.test/ignored", token: "ignored-token" },
            "Not A Name": { url: "https://hooks.test/bad" },
          }),
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

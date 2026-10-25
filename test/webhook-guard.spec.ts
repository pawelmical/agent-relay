import { describe, expect, it } from "vitest";
import { dcrEnabled } from "../src/policy";
import { isAgentName, normalizeAssignee, normalizeSender, toTask, type TaskRow } from "../src/tasks";
import { readAgentWebhooks } from "../src/webhook";
import { explainWebhookUrl } from "../src/webhook-guard";

describe("webhook target filter", () => {
  it("allows public https and loopback, and refuses private literals", () => {
    expect(explainWebhookUrl("https://hooks.example/grok")).toBeNull();
    expect(explainWebhookUrl("https://127.0.0.1/hook")).toBeNull();
    expect(explainWebhookUrl("http://localhost:8788/hook")).toBeNull();
    expect(explainWebhookUrl("http://[::1]/hook")).toBeNull();
    expect(explainWebhookUrl("https://2130706433/hook")).toBeNull();

    expect(explainWebhookUrl("https://10.1.2.3/latest")).toMatch(/private/);
    expect(explainWebhookUrl("https://169.254.169.254/latest")).toMatch(/private/);
    expect(explainWebhookUrl("https://192.168.1.9/hook")).toMatch(/private/);
    expect(explainWebhookUrl("https://[fd00::1]/hook")).toMatch(/private/);
    expect(explainWebhookUrl("https://[fe80::1]/hook")).toMatch(/private/);
    expect(explainWebhookUrl(`https://[::ffff:${"10.1.2.3"}]/hook`)).toMatch(/private/);
    expect(explainWebhookUrl("https://metadata.google.internal/computeMetadata/v1/")).toMatch(/private/);
    expect(explainWebhookUrl("http://8.8.8.8/hook")).toMatch(/https/);
    expect(explainWebhookUrl("not a url")).toMatch(/not a URL/);
    expect(explainWebhookUrl("https://10.1.2.3/hook", "Webhook URL")).toMatch(/^Webhook URL points at a private/);
  });
});

describe("agent names", () => {
  it("accepts the original names and hyphenated slugs", () => {
    for (const name of ["grokbot", "claude", "gpt", "cursor", "gemini", "gpt4", "claude-right-hand", "someone-else", "a".repeat(32)]) {
      expect(isAgentName(name)).toBe(true);
    }
    for (const name of ["Claude", "grok bot", "gpt.bot", "a", "4gpt", "claude--bot", "claude-", "-claude", "a".repeat(33), "сlaude", "../x", ""]) {
      expect(isAgentName(name)).toBe(false);
    }
  });

  it("normalizes assignees softly and senders from legacy labels", () => {
    expect(normalizeAssignee(" Claude ")).toBe("claude");
    expect(normalizeAssignee("Grokbot")).toBe("grokbot");
    expect(normalizeAssignee("claude-right-hand")).toBe("claude-right-hand");
    expect(normalizeAssignee("Grok Bot")).toBeNull();
    expect(normalizeAssignee("claude--bot")).toBeNull();

    expect(normalizeSender("Claude")).toBe("claude");
    expect(normalizeSender("Grok Bot")).toBe("grok-bot");
    expect(normalizeSender("claude-right-hand")).toBe("claude-right-hand");
    expect(normalizeSender("Grok__Bot")).toBe("grok-bot");
    expect(normalizeSender("  (Grok Bot!)  ")).toBe("grok-bot");
    expect(normalizeSender("!!!")).toBeNull();
    expect(normalizeSender("a")).toBeNull();
  });

  it("still reads a non-slug assignee as claude", () => {
    const row: TaskRow = {
      id: "00000000-0000-4000-8000-000000000001",
      assignee: "not a slug",
      author: "grokbot",
      title: "Old",
      instructions: "Kept",
      status: "pending",
      result: null,
      error: null,
      created_at: "2024-01-15T12:00:00.000Z",
      updated_at: "2024-01-15T12:00:00.000Z",
      claimed_at: null,
      completed_at: null,
      webhook_attempted: 0,
      webhook_ok: null,
      webhook_http_status: null,
      webhook_error: null,
    };
    expect(toTask(row).to).toBe("claude");
    expect(toTask(row).webhook).toBeNull();
  });
});

describe("per-agent webhook config", () => {
  it("keeps grokbot on its own secrets and drops bad entries", () => {
    const config = readAgentWebhooks(
      JSON.stringify({
        cursor: { url: " https://hooks.example/cursor ", token: " cursor-token " },
        gpt: { url: "https://hooks.example/gpt" },
        grokbot: { url: "https://hooks.example/should-not-win", token: "nope" },
        "Not A Name": { url: "https://hooks.example/bad" },
        claude: { url: "" },
        gemini: "https://hooks.example/gemini",
      }),
    );
    expect(config.error).toBeNull();
    expect(config.targets.size).toBe(2);
    expect(config.targets.get("cursor")).toEqual({ url: "https://hooks.example/cursor", token: "cursor-token" });
    expect(config.targets.get("gpt")).toEqual({ url: "https://hooks.example/gpt", token: null });
    expect(config.targets.has("grokbot")).toBe(false);

    expect(readAgentWebhooks(undefined)).toEqual({ targets: new Map(), error: null });
    expect(readAgentWebhooks("[]").error).toMatch(/JSON object/);
    expect(readAgentWebhooks("{").error).toMatch(/not valid JSON/);
    expect(readAgentWebhooks("x".repeat(16_385)).error).toMatch(/too large/);

    const many: Record<string, { url: string }> = {};
    for (let index = 0; index < 40; index += 1) many[`agent${index}`] = { url: "https://hooks.example/x" };
    expect(readAgentWebhooks(JSON.stringify(many)).targets.size).toBe(32);
  });
});

describe("dynamic client registration flag", () => {
  it("stays on unless the operator turns it off", () => {
    expect(dcrEnabled({})).toBe(true);
    expect(dcrEnabled({ MCP_DISABLE_DCR: "true" })).toBe(false);
    expect(dcrEnabled({ MCP_DISABLE_DCR: "1" })).toBe(false);
    expect(dcrEnabled({ MCP_DISABLE_DCR: "no" })).toBe(true);
  });
});

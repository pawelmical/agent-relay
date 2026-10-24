import { describe, expect, it } from "vitest";
import { dcrEnabled } from "../src/policy";
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

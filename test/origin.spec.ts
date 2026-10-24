import { describe, expect, it } from "vitest";
import { OriginError, canonicalOrigin } from "../src/origin";
import { authConfigurationError, configuredToken, secretsEqual } from "../src/secrets";

describe("canonical origins", () => {
  it("accepts https and loopback http, and rejects a path", () => {
    expect(canonicalOrigin("https://Example.COM")).toBe("https://example.com");
    expect(canonicalOrigin("http://localhost:8788/")).toBe("http://localhost:8788");
    expect(canonicalOrigin("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
    expect(() => canonicalOrigin("http://192.168.1.20:8788")).toThrow(OriginError);
    expect(() => canonicalOrigin("https://example.com/mcp")).toThrow(OriginError);
    expect(() => canonicalOrigin("https://user:pw@example.com")).toThrow(OriginError);
  });
});

describe("mailbox token", () => {
  it("rejects short tokens and compares the rest in constant time", async () => {
    expect(configuredToken({ MCP_AUTH_TOKEN: "too-short" })).toBe("");
    expect(authConfigurationError({})).toMatch(/not set/);
    expect(configuredToken({ MCP_AUTH_TOKEN: "0123456789abcdef" })).toBe("0123456789abcdef");
    expect(await secretsEqual("0123456789abcdef", "0123456789abcdef")).toBe(true);
    expect(await secretsEqual("0123456789abcdef", "0123456789abcdee")).toBe(false);
    expect(await secretsEqual("", "0123456789abcdef")).toBe(false);
  });
});

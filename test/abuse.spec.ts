import { exports, env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, TOKEN, rpc } from "./mcp-client";
import { REGISTER_LIMIT, SECRET_FAILURE_LIMIT } from "../src/policy";

describe("authentication rate limits", () => {
  it("stops guessing the bearer token after eight failures", async () => {
    const ip = "203.0.113.21";
    await env.MAILBOX.getByName("shared").clearRate(`secret:${ip}`);
    for (let attempt = 0; attempt < SECRET_FAILURE_LIMIT; attempt += 1) {
      const wrong = await rpc("tools/list", {}, "not-the-mailbox-token", attempt + 1, { "cf-connecting-ip": ip });
      expect(wrong.status).toBe(401);
    }
    const locked = await rpc("tools/list", {}, TOKEN, 100, { "cf-connecting-ip": ip });
    expect(locked.status).toBe(429);
    expect(locked.retryAfter).toBeTruthy();

    const otherNetwork = await rpc("tools/list", {}, TOKEN, 101, { "cf-connecting-ip": "203.0.113.22" });
    expect(otherNetwork.status).toBe(200);
  });

  it("stops anonymous client registration after twenty creates", async () => {
    const ip = "203.0.113.30";
    await env.MAILBOX.getByName("shared").clearRate(`register:${ip}`);
    for (let attempt = 0; attempt < REGISTER_LIMIT; attempt += 1) {
      const registered = await exports.default.fetch(
        new Request(`${BASE}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": ip },
          body: JSON.stringify({
            client_name: `Flood ${attempt}`,
            redirect_uris: [`${BASE}/callback`],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        }),
      );
      expect(registered.status).toBe(201);
    }
    const blocked = await exports.default.fetch(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({
          client_name: "Flood overflow",
          redirect_uris: [`${BASE}/callback`],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("stops guessing the mailbox token on the consent form", async () => {
    const ip = "203.0.113.40";
    await env.MAILBOX.getByName("shared").clearRate(`consent:${ip}`);
    const registered = await exports.default.fetch(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.41" },
        body: JSON.stringify({
          client_name: "Consent limit",
          redirect_uris: [`${BASE}/callback`],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const client = (await registered.json()) as { client_id: string };
    const authorizeUrl = new URL(`${BASE}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", `${BASE}/callback`);
    authorizeUrl.searchParams.set("code_challenge", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "limit");
    authorizeUrl.searchParams.set("resource", `${BASE}/mcp`);
    const consent = await exports.default.fetch(authorizeUrl);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
    const cookies = consent.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0] ?? "")
      .filter((cookie) => cookie.length > 0)
      .join("; ");

    for (let attempt = 0; attempt < SECRET_FAILURE_LIMIT; attempt += 1) {
      const rejected = await exports.default.fetch(
        new Request(`${BASE}/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies, "cf-connecting-ip": ip },
          body: new URLSearchParams({
            handle,
            decision: "approve",
            mailbox_token: "wrong-mailbox-token",
            scope: "mailbox",
          }),
        }),
      );
      expect(rejected.status).toBe(200);
    }

    const locked = await exports.default.fetch(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies, "cf-connecting-ip": ip },
        body: new URLSearchParams({
          handle,
          decision: "approve",
          mailbox_token: TOKEN,
          scope: "mailbox",
        }),
      }),
    );
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    expect(await locked.text()).toContain("Too many attempts");
  });
});

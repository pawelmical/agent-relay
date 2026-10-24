import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, TOKEN, rpc } from "./mcp-client";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((cookie) => cookie.length > 0)
    .join("; ");
}

describe("OAuth connector flow", () => {
  it("registers a public client, rejects a bad mailbox token, then issues a refreshable access token", async () => {
    const registered = await exports.default.fetch(
      new Request(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Mailbox test",
          redirect_uris: [`${BASE}/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    expect(client.client_id).toBeTruthy();

    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = base64url(verifierBytes);
    const challenge = await codeChallenge(verifier);
    const authorizeUrl = new URL(`${BASE}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", `${BASE}/callback`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "mailbox offline_access");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("resource", `${BASE}/mcp`);

    const consent = await exports.default.fetch(authorizeUrl);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain("Mailbox test");
    expect(html).toContain("localhost");
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    const cookies = cookieHeader(consent);

    const rejected = await exports.default.fetch(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
        body: new URLSearchParams({
          handle: handle ?? "",
          decision: "approve",
          mailbox_token: "wrong-mailbox-token",
          scope: "mailbox",
        }),
      }),
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).toContain("does not match");

    const approvedBody = new URLSearchParams();
    approvedBody.set("handle", handle ?? "");
    approvedBody.set("decision", "approve");
    approvedBody.set("mailbox_token", TOKEN);
    approvedBody.append("scope", "mailbox");
    approvedBody.append("scope", "offline_access");
    const approved = await exports.default.fetch(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies },
        body: approvedBody,
      }),
    );
    if (approved.status !== 302) {
      throw new Error(`approve returned ${approved.status}: ${await approved.text()}`);
    }
    const location = approved.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location ?? "").searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await exports.default.fetch(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: `${BASE}/callback`,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: `${BASE}/mcp`,
        }),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const issued = (await tokenResponse.json()) as { access_token: string; refresh_token?: string; token_type: string };
    expect(issued.token_type.toLowerCase()).toBe("bearer");
    expect(issued.access_token).toBeTruthy();
    expect(issued.refresh_token).toBeTruthy();

    const listed = await rpc("tools/list", {}, issued.access_token);
    expect(listed.status).toBe(200);
    const names = ((listed.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("create_task");
  });
});

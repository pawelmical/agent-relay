import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, TOKEN, rpc } from "./mcp-client";

describe("public routes", () => {
  it("serves a bilingual home page and a health check without a token", async () => {
    const home = await exports.default.fetch(`${BASE}/`);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Task mailbox");
    expect(html).toContain("Skrzynka zadań");
    expect(html).toContain(`${BASE}/mcp`);

    const health = await exports.default.fetch(`${BASE}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as {
      ready: boolean;
      auth: string[];
      webhookConfigured: boolean;
      service: string;
      agentWebhooks: number;
      agentWebhooksError: string | null;
    };
    expect(body.ready).toBe(true);
    expect(body.auth).toEqual(["bearer", "oauth"]);
    expect(body.webhookConfigured).toBe(true);
    expect(body.service).toBe("task-mailbox");
    expect(body.agentWebhooks).toBe(2);
    expect(body.agentWebhooksError).toBeNull();
  });
});

describe("MCP discovery", () => {
  it("challenges anonymous clients and publishes OAuth metadata", async () => {
    const anonymous = await exports.default.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(anonymous.status).toBe(401);
    const challenge = anonymous.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource/mcp");

    const resource = await exports.default.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    const resourceDoc = (await resource.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(resourceDoc.resource).toBe(`${BASE}/mcp`);
    expect(resourceDoc.authorization_servers).toEqual([BASE]);
    expect(resourceDoc.scopes_supported).toContain("mailbox");

    const authorization = await exports.default.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(authorization.status).toBe(200);
    const metadata = (await authorization.json()) as {
      issuer: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported?: boolean;
    };
    expect(metadata.issuer).toBe(BASE);
    expect(metadata.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.client_id_metadata_document_supported).toBe(true);
  });

  it("rejects a wrong bearer token and lists tools for the right one", async () => {
    const wrong = await rpc("tools/list", {}, "not-the-mailbox-token");
    expect(wrong.status).toBe(401);

    const listed = await rpc("tools/list", {}, TOKEN);
    expect(listed.status).toBe(200);
    const payload = listed.body as { result?: { tools?: { name: string }[] } };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name).sort();
    expect(names).toEqual(["claim_task", "complete_task", "create_task", "delete_task", "get_task", "list_tasks"]);
  });
});

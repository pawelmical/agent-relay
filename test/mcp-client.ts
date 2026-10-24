import { exports } from "cloudflare:workers";

export const BASE = "http://localhost:8788";
export const TOKEN = "test-mailbox-token-0123456789";

export function parseRpc(text: string, contentType: string | null): unknown {
  if (contentType?.includes("application/json")) return JSON.parse(text);
  const lines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  const last = lines.at(-1);
  if (!last) throw new Error(`No JSON-RPC payload in response: ${text.slice(0, 500)}`);
  return JSON.parse(last);
}

export async function rpc(method: string, params: unknown, token = TOKEN, id = 1): Promise<{ status: number; body: unknown; wwwAuthenticate: string | null }> {
  const response = await exports.default.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        host: "localhost:8788",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? parseRpc(text, response.headers.get("content-type")) : null,
    wwwAuthenticate: response.headers.get("www-authenticate"),
  };
}

interface ToolPayload {
  result?: { content?: { text?: string }[]; isError?: boolean };
  error?: { message?: string };
}

export async function callTool(name: string, args: Record<string, unknown>, token = TOKEN): Promise<{ isError: boolean; text: string; json: unknown }> {
  const response = await rpc("tools/call", { name, arguments: args }, token);
  if (response.status !== 200) {
    throw new Error(`tools/call HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const payload = response.body as ToolPayload;
  if (payload.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  const text = payload.result?.content?.[0]?.text ?? "";
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { isError: payload.result?.isError === true, text, json };
}

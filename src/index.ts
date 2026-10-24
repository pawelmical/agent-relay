import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./consent";
import { homePage } from "./home";
import { mcpHandler } from "./mcp";
import { OriginError, canonicalOrigin, requestOrigin } from "./origin";
import { authConfigurationError, configuredToken, secretsEqual } from "./secrets";
import { webhookConfigured } from "./webhook";

export { Mailbox } from "./mailbox";

type WorkerEnv = Env & {
  MCP_AUTH_TOKEN?: string;
  MCP_PUBLIC_URL?: string;
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_TOKEN?: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function readPin(env: WorkerEnv): { origin: string | null; error: string | null } {
  const raw = env.MCP_PUBLIC_URL?.trim() ?? "";
  if (!raw) return { origin: null, error: null };
  try {
    return { origin: canonicalOrigin(raw), error: null };
  } catch (error) {
    return { origin: null, error: error instanceof Error ? error.message : "MCP_PUBLIC_URL is invalid." };
  }
}

function resolveOrigin(request: Request, env: WorkerEnv): { origin: string } | { error: string; status: number } {
  const pin = readPin(env);
  if (pin.error) return { error: pin.error, status: 500 };
  let incoming: string;
  try {
    incoming = requestOrigin(request.url);
  } catch (error) {
    const message = error instanceof OriginError ? error.message : "This host cannot issue OAuth tokens.";
    return { error: message, status: 400 };
  }
  if (pin.origin && pin.origin !== incoming) {
    return {
      error: `This mailbox is pinned to ${pin.origin}. Send MCP and OAuth requests to ${pin.origin}/mcp.`,
      status: 400,
    };
  }
  return { origin: pin.origin ?? incoming };
}

function createProvider(origin: string): OAuthProvider<WorkerEnv> {
  const resource = `${origin}/mcp`;
  return new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch(request, env, ctx) {
        return mcpHandler(env)(request, env, ctx);
      },
    },
    defaultHandler: {
      fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === "/authorize") {
          const oauth = (env as WorkerEnv & { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
          if (!oauth) {
            return Response.json({ error: "OAuth is not available on this request." }, { status: 500, headers: JSON_HEADERS });
          }
          return handleAuthorize(request, oauth, env);
        }
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["mailbox", "offline_access"],
    requiredScopes: ["mailbox"],
    clientIdMetadataDocumentEnabled: true,
    allowPrivateUseRedirectUris: true,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      resource_name: "Task mailbox",
      bearer_methods_supported: ["header"],
    },
    resolveExternalToken: async ({ token, env: tokenEnv }) => {
      const expected = configuredToken(tokenEnv);
      const matches = await secretsEqual(token, expected);
      if (!matches) return null;
      return { props: { method: "bearer" }, audience: resource };
    },
  });
}

function health(request: Request, env: WorkerEnv): Response {
  const pin = readPin(env);
  let incoming: string | null = null;
  try {
    incoming = requestOrigin(request.url);
  } catch {
    incoming = null;
  }
  const ready = authConfigurationError(env) === null && pin.error === null;
  return Response.json(
    {
      ok: true,
      ready,
      service: "task-mailbox",
      mcp: "/mcp",
      auth: ["bearer", "oauth"],
      authConfigured: authConfigurationError(env) === null,
      webhookConfigured: webhookConfigured(env),
      pinnedOrigin: pin.origin,
      pinError: pin.error,
      requestOrigin: incoming,
    },
    { headers: JSON_HEADERS },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const workerEnv = env as WorkerEnv;
    const url = new URL(request.url);
    if (url.pathname === "/health") return health(request, workerEnv);
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const pin = readPin(workerEnv);
      let incoming: string | null = null;
      try {
        incoming = requestOrigin(request.url);
      } catch {
        incoming = null;
      }
      const html = homePage({
        requestOrigin: incoming,
        pinnedOrigin: pin.origin,
        pinError: pin.error,
        ready: authConfigurationError(workerEnv) === null,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const resolved = resolveOrigin(request, workerEnv);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: resolved.status, headers: JSON_HEADERS });
    }

    try {
      return await createProvider(resolved.origin).fetch(request, workerEnv, ctx);
    } catch (error) {
      const message = error instanceof OriginError || error instanceof TypeError ? error.message : "The mailbox could not handle this request.";
      console.error(JSON.stringify({ event: "request_failed", name: error instanceof Error ? error.name : "Error" }));
      return Response.json({ error: message }, { status: 500, headers: JSON_HEADERS });
    }
  },
} satisfies ExportedHandler<Env>;

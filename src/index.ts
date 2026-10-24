import { ExternalTokenError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./consent";
import { homePage } from "./home";
import { mailboxStub } from "./mailbox";
import { mcpHandler } from "./mcp";
import { OriginError, canonicalOrigin, requestOrigin } from "./origin";
import { dcrEnabled, rateBucket, REGISTER_GLOBAL_LIMIT, REGISTER_LIMIT, SECRET_FAILURE_LIMIT } from "./policy";
import { authConfigurationError, configuredToken, secretsEqual } from "./secrets";
import { webhookConfigured } from "./webhook";

export { Mailbox } from "./mailbox";

type WorkerEnv = Env & {
  MCP_AUTH_TOKEN?: string;
  MCP_PUBLIC_URL?: string;
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_TOKEN?: string;
  MCP_DISABLE_DCR?: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many attempts from this network. Try again later." },
    { status: 429, headers: { ...JSON_HEADERS, "retry-after": String(retryAfterSeconds) } },
  );
}

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

function createProvider(origin: string, env: WorkerEnv): OAuthProvider<WorkerEnv> {
  const resource = `${origin}/mcp`;
  const registration = dcrEnabled(env) ? { clientRegistrationEndpoint: "/oauth/register" as const } : {};
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
    ...registration,
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
    resolveExternalToken: async ({ token, request, env: tokenEnv }) => {
      const mailbox = mailboxStub(tokenEnv);
      const bucket = rateBucket(request, "secret");
      const gate = await mailbox.peekRate(bucket, SECRET_FAILURE_LIMIT);
      if (!gate.allowed) {
        throw new ExternalTokenError("temporarily_unavailable", {
          description: "Too many authentication attempts. Try again later.",
          statusCode: 429,
          headers: { "retry-after": String(gate.retryAfterSeconds) },
        });
      }
      const expected = configuredToken(tokenEnv);
      const matches = await secretsEqual(token, expected);
      if (!matches) {
        await mailbox.hitRate(bucket, SECRET_FAILURE_LIMIT);
        return null;
      }
      await mailbox.clearRate(bucket);
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
      dynamicClientRegistration: dcrEnabled(env),
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

    if (url.pathname === "/oauth/register") {
      if (!dcrEnabled(workerEnv)) {
        return Response.json(
          { error: "Dynamic client registration is disabled. Set MCP_DISABLE_DCR empty to turn it back on." },
          { status: 404, headers: JSON_HEADERS },
        );
      }
      if (request.method === "POST") {
        const mailbox = mailboxStub(workerEnv);
        const charge = await mailbox.hitRate(rateBucket(request, "register"), REGISTER_LIMIT);
        if (!charge.allowed) return tooMany(charge.retryAfterSeconds);
        const globalCharge = await mailbox.hitRate("register:global", REGISTER_GLOBAL_LIMIT);
        if (!globalCharge.allowed) return tooMany(globalCharge.retryAfterSeconds);
      }
    }

    try {
      return await createProvider(resolved.origin, workerEnv).fetch(request, workerEnv, ctx);
    } catch (error) {
      const message = error instanceof OriginError || error instanceof TypeError ? error.message : "The mailbox could not handle this request.";
      console.error(JSON.stringify({ event: "request_failed", name: error instanceof Error ? error.name : "Error" }));
      return Response.json({ error: message }, { status: 500, headers: JSON_HEADERS });
    }
  },
} satisfies ExportedHandler<Env>;

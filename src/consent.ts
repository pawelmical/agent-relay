import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { mailboxStub } from "./mailbox";
import { rateBucket, SECRET_FAILURE_LIMIT } from "./policy";
import { authConfigurationError, configuredToken, secretsEqual } from "./secrets";

const SCOPES = ["mailbox", "offline_access"] as const;
const FRAME_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(body: string, headers: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("referrer-policy", "no-referrer");
  responseHeaders.set("x-frame-options", "DENY");
  responseHeaders.set("content-security-policy", FRAME_POLICY);
  return new Response(body, { status: 200, headers: responseHeaders });
}

function layout(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, "Iowan Old Style", serif; background: #f3efe6; color: #1d1a16; }
  main { max-width: 38rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  h1 { font-size: 1.7rem; line-height: 1.2; margin: 0 0 0.75rem; }
  p, li { margin: 0.6rem 0; }
  .note { background: #fff; border: 1px solid #d9d0c1; padding: 0.8rem 1rem; }
  label { display: block; margin: 0.4rem 0; }
  input[type="password"] { width: 100%; box-sizing: border-box; font: 16px/1.4 ui-monospace, monospace; padding: 0.55rem 0.6rem; }
  button { font: 16px/1.2 Georgia, serif; padding: 0.45rem 0.9rem; margin-right: 0.4rem; }
  .warn { color: #7a2e12; }
</style>
</head>
<body>
<main>
${inner}
</main>
</body>
</html>`;
}

function scopeFields(selected: readonly string[]): string {
  const chosen = new Set(selected.length > 0 ? selected : SCOPES);
  return SCOPES.map((scope) => {
    const checked = chosen.has(scope) ? " checked" : "";
    return `<label><input type="checkbox" name="scope" value="${scope}"${checked}> ${scope}</label>`;
  }).join("");
}

function consentInner(details: ConsentDescription, handle: string, authError: string | null): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong>. The name comes from that domain.</p>`
    : "<p>This app registered itself. Its name is not verified.</p>";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>Access will be sent to an app on this computer.</strong> Continue only if you just started the connection.</p>`
    : "";
  const config = authError ? `<p class="warn">${escapeHtml(authError)}</p>` : "";
  return `
<h1>Allow ${name} to use the task mailbox?</h1>
<p>Pozwolić aplikacji ${name} korzystać ze skrzynki zadań?</p>
${origin}
<p>Tokens will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
${config}
<p>Enter the mailbox token (<code>MCP_AUTH_TOKEN</code>). Claude stores its own OAuth token after this; you paste the shared secret only here.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <label>Mailbox token
    <input type="password" name="mailbox_token" autocomplete="current-password" required>
  </label>
  <fieldset>
    <legend>Scopes</legend>
    ${scopeFields(details.scope)}
  </fieldset>
  <p><button name="decision" value="approve">Allow / Pozwól</button> <button name="decision" value="deny">Deny / Odmów</button></p>
</form>`;
}

function retryInner(handle: string, scopes: string[], message: string, polish: string, checkboxes: boolean): string {
  const fields = checkboxes
    ? scopeFields(scopes)
    : scopes
        .filter((scope) => (SCOPES as readonly string[]).includes(scope))
        .map((scope) => `<input type="hidden" name="scope" value="${escapeHtml(scope)}">`)
        .join("");
  const scopeBlock = checkboxes ? `<fieldset><legend>Scopes</legend>${fields}</fieldset>` : fields;
  return `
<h1>Mailbox token was not accepted</h1>
<p class="warn">${escapeHtml(message)}</p>
<p>${escapeHtml(polish)}</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopeBlock}
  <label>Mailbox token
    <input type="password" name="mailbox_token" autocomplete="current-password" required>
  </label>
  <p><button name="decision" value="approve">Allow / Pozwól</button> <button name="decision" value="deny">Deny / Odmów</button></p>
</form>`;
}

function limitedResponse(seconds: number): Response {
  const body = layout(
    "Too many attempts",
    `<h1>Too many attempts</h1>
<p class="warn">The mailbox token was refused too many times from this network. Try again in ${seconds} seconds.</p>
<p>Za dużo nieudanych prób z tej sieci. Spróbuj ponownie za ${seconds} sekund.</p>`,
  );
  const headers = new Headers();
  headers.set("retry-after", String(seconds));
  const response = page(body, headers);
  return new Response(response.body, { status: 429, headers: response.headers });
}

function plainProblem(message: string, status: number): Response {
  return new Response(escapeHtml(message), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleAuthorize(request: Request, oauth: OAuthHelpers, env: Env & { MCP_AUTH_TOKEN?: string }): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return page(layout("Authorize the task mailbox", consentInner(details, consent.handle, authConfigurationError(env))), consent.headers);
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
    }

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    const decision = String(form.get("decision") ?? "");
    const scopes = form.getAll("scope").map((value) => String(value)).filter((scope) => (SCOPES as readonly string[]).includes(scope));

    if (decision !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      const headers = new Headers(denied.headers);
      if (!headers.has("location")) headers.set("location", denied.redirectTo);
      return new Response(null, { status: 302, headers });
    }

    const mailbox = mailboxStub(env);
    const bucket = rateBucket(request, "consent");
    const gate = await mailbox.peekRate(bucket, SECRET_FAILURE_LIMIT);
    if (!gate.allowed) return limitedResponse(gate.retryAfterSeconds);

    if (!scopes.includes("mailbox")) {
      return page(
        layout(
          "Authorize the task mailbox",
          retryInner(
            handle,
            scopes,
            "Select the mailbox scope. offline_access is added only when its box is checked.",
            "Zaznacz zakres mailbox. offline_access dochodzi tylko wtedy, gdy jego pole jest zaznaczone.",
            true,
          ),
        ),
        new Headers(),
      );
    }

    const configurationError = authConfigurationError(env);
    if (configurationError) {
      return page(
        layout(
          "Authorize the task mailbox",
          retryInner(handle, scopes, configurationError, "Token skrzynki nie jest skonfigurowany.", false),
        ),
        new Headers(),
      );
    }
    const accepted = await secretsEqual(String(form.get("mailbox_token") ?? ""), configuredToken(env));
    if (!accepted) {
      await mailbox.hitRate(bucket, SECRET_FAILURE_LIMIT);
      return page(
        layout(
          "Authorize the task mailbox",
          retryInner(
            handle,
            scopes,
            "That token does not match MCP_AUTH_TOKEN.",
            "Token skrzynki nie pasuje. Wpisz go jeszcze raz. Nazwa klienta była na poprzedniej stronie.",
            false,
          ),
        ),
        new Headers(),
      );
    }
    await mailbox.clearRate(bucket);

    const approved = await oauth.approveConsent(request, handle, { scope: scopes });
    const completed = await oauth.completeAuthorization({
      request: approved.request,
      userId: "mailbox",
      metadata: { connector: "task-mailbox" },
      scope: approved.request.scope.length > 0 ? approved.request.scope : scopes,
      props: { method: "oauth" },
    });
    approved.headers.set("location", completed.redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) return plainProblem(error.description, 400);
    if (error instanceof CimdFetchError) return plainProblem("This app could not be verified.", 400);
    throw error;
  }
}

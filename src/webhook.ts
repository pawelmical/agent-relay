import type { Task } from "./tasks";
import type { WebhookReceipt } from "./mailbox";

const WEBHOOK_TIMEOUT_MS = 8_000;

interface WebhookEnv {
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_TOKEN?: string;
}

export function webhookConfigured(env: WebhookEnv): boolean {
  return Boolean(env.GROKBOT_WEBHOOK_URL?.trim());
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Wake the Grok Bot routine. The URL is operator configuration, not task
 * input. Redirects are not followed, so the webhook token stays on the host
 * that was configured.
 */
export async function postGrokWebhook(env: WebhookEnv, task: Task): Promise<WebhookReceipt> {
  const raw = env.GROKBOT_WEBHOOK_URL?.trim() ?? "";
  if (!raw) {
    return {
      attempted: false,
      ok: null,
      httpStatus: null,
      error: "GROKBOT_WEBHOOK_URL is not set.",
    };
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return {
      attempted: false,
      ok: null,
      httpStatus: null,
      error: "GROKBOT_WEBHOOK_URL is not a URL.",
    };
  }
  const loopback = isLoopback(target.hostname);
  const allowed =
    target.protocol === "https:" || (target.protocol === "http:" && loopback);
  if (!allowed) {
    return {
      attempted: false,
      ok: null,
      httpStatus: null,
      error: "GROKBOT_WEBHOOK_URL must be https, or http on localhost.",
    };
  }

  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "task-mailbox/1.0",
  });
  const token = env.GROKBOT_WEBHOOK_TOKEN?.trim();
  if (token) headers.set("authorization", `Bearer ${token}`);

  const body = JSON.stringify({
    event: "task.created",
    task_id: task.id,
    to: task.to,
    from: task.from,
    title: task.title,
    instructions: task.instructions,
    status: task.status,
    created_at: task.created_at,
  });

  try {
    const response = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) {
      console.log(JSON.stringify({ event: "webhook_redirect_refused", taskId: task.id, httpStatus: response.status }));
      return {
        attempted: true,
        ok: false,
        httpStatus: response.status,
        error: "Webhook redirected and was not followed.",
      };
    }
    const ok = response.status >= 200 && response.status < 300;
    console.log(JSON.stringify({ event: "webhook_delivery", taskId: task.id, ok, httpStatus: response.status }));
    return {
      attempted: true,
      ok,
      httpStatus: response.status,
      error: ok ? null : `Webhook returned HTTP ${response.status}.`,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "webhook_failed",
        taskId: task.id,
        name: error instanceof Error ? error.name : "Error",
      }),
    );
    return {
      attempted: true,
      ok: false,
      httpStatus: null,
      error: error instanceof Error && error.name === "TimeoutError" ? "Webhook timed out after 8s." : "Webhook request failed.",
    };
  }
}

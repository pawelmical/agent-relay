import type { WebhookReceipt } from "./mailbox";
import { isAgentName, type Task } from "./tasks";
import { explainWebhookUrl } from "./webhook-guard";

const WEBHOOK_TIMEOUT_MS = 8_000;
const AGENT_WEBHOOKS_MAX_CHARS = 16_384;
const AGENT_WEBHOOKS_MAX_ENTRIES = 32;

interface WebhookEnv {
  GROKBOT_WEBHOOK_URL?: string;
  GROKBOT_WEBHOOK_TOKEN?: string;
  AGENT_WEBHOOKS?: string;
}

export interface AgentWebhookTarget {
  url: string;
  token: string | null;
}

export interface AgentWebhookConfig {
  targets: Map<string, AgentWebhookTarget>;
  error: string | null;
}

export function webhookConfigured(env: WebhookEnv): boolean {
  return Boolean(env.GROKBOT_WEBHOOK_URL?.trim());
}

/**
 * Optional wake-up URLs for agents other than grokbot. grokbot stays on
 * GROKBOT_WEBHOOK_URL / GROKBOT_WEBHOOK_TOKEN, and a grokbot key in this JSON
 * is ignored so those two secrets cannot be overridden.
 *
 * Shape: { "cursor": { "url": "https://example.com/hook", "token": "optional" } }
 */
export function readAgentWebhooks(raw: string | undefined): AgentWebhookConfig {
  const text = raw?.trim() ?? "";
  if (!text) return { targets: new Map(), error: null };
  if (text.length > AGENT_WEBHOOKS_MAX_CHARS) {
    return { targets: new Map(), error: "AGENT_WEBHOOKS is too large." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { targets: new Map(), error: "AGENT_WEBHOOKS is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { targets: new Map(), error: "AGENT_WEBHOOKS must be a JSON object." };
  }

  const targets = new Map<string, AgentWebhookTarget>();
  for (const [name, value] of Object.entries(parsed)) {
    if (targets.size >= AGENT_WEBHOOKS_MAX_ENTRIES) break;
    if (name === "grokbot" || !isAgentName(name)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as { url?: unknown; token?: unknown };
    if (typeof record.url !== "string") continue;
    const url = record.url.trim();
    if (!url) continue;
    const token = typeof record.token === "string" && record.token.trim() ? record.token.trim() : null;
    targets.set(name, { url, token });
  }
  return { targets, error: null };
}

export function agentWebhookFor(raw: string | undefined, agent: string): AgentWebhookTarget | null {
  if (agent === "grokbot") return null;
  return readAgentWebhooks(raw).targets.get(agent) ?? null;
}

interface DeliveryTarget {
  url: string;
  token: string | null;
  label: string;
}

/**
 * POST a doorbell. The body is event, task_id, and title only. Redirects are
 * not followed, private hosts are refused before fetch, and the call waits
 * at most 8 seconds. The same rules apply to every agent.
 */
export async function deliverWebhook(target: DeliveryTarget, task: Pick<Task, "id" | "title">): Promise<WebhookReceipt> {
  const refused = explainWebhookUrl(target.url, target.label);
  if (refused) {
    return {
      attempted: false,
      ok: null,
      httpStatus: null,
      error: refused,
    };
  }
  const url = new URL(target.url);

  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "task-mailbox/1.0",
  });
  if (target.token) headers.set("authorization", `Bearer ${target.token}`);

  const body = JSON.stringify({
    event: "task.created",
    task_id: task.id,
    title: task.title,
  });

  try {
    const response = await fetch(url, {
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

/**
 * Wake the Grok Bot routine. The URL is operator configuration, not task
 * input. Instructions stay in the mailbox so the routine has to read them
 * with get_task.
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
  const token = env.GROKBOT_WEBHOOK_TOKEN?.trim() ?? "";
  return deliverWebhook(
    { url: raw, token: token || null, label: "GROKBOT_WEBHOOK_URL" },
    task,
  );
}

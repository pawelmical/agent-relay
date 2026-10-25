export const STATUSES = ["pending", "in_progress", "done", "failed"] as const;

/**
 * Canonical agent name: a letter, then letters, digits, or single hyphens.
 * 2–32 characters. No leading, trailing, or doubled hyphen.
 * `grokbot` and `claude` match this exactly.
 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
/** Raw `to` / `for` / `from` input cap. Matches the old `from` label limit. */
export const AGENT_INPUT_MAX = 80;

export type TaskStatus = (typeof STATUSES)[number];

export const LIMITS = {
  title: 200,
  instructions: 16_000,
  result: 64_000,
  list: 50,
  maxTasks: 500,
  settledRetentionMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface WebhookState {
  attempted: boolean;
  ok: boolean | null;
  http_status: number | null;
  error: string | null;
}

export interface Task {
  id: string;
  to: string;
  from: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  webhook: WebhookState | null;
}

export interface TaskRow {
  id: string;
  assignee: string;
  author: string;
  title: string;
  instructions: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  webhook_attempted: number;
  webhook_ok: number | null;
  webhook_http_status: number | null;
  webhook_error: string | null;
}

export type MailboxResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): MailboxResult<T> {
  return { ok: true, value };
}

export function fail<T>(error: string): MailboxResult<T> {
  return { ok: false, error };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentName(value: string): boolean {
  return AGENT_NAME_PATTERN.test(value) && !value.endsWith("-") && !value.includes("--");
}

export function agentNameError(field: string): string {
  return `${field} must be an agent name of 2-32 characters: a letter, then letters, digits, or hyphens, with no leading, trailing, or doubled hyphen. It is trimmed and lowercased. Examples: grokbot, claude, claude-right-hand.`;
}

export function senderNameError(): string {
  return "from did not contain an agent name. Letters, digits, and hyphens are kept; spaces and underscores become hyphens.";
}

/** Trim and lowercase `to` / `for`. Returns the canonical name, or null. */
export function normalizeAssignee(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > AGENT_INPUT_MAX) return null;
  return isAgentName(normalized) ? normalized : null;
}

/**
 * Legacy `from` labels are not rejected when they can be turned into a slug.
 * Lowercase, spaces and underscores become hyphens, other characters drop,
 * repeats and edge hyphens collapse, then the result is cut to 32 characters.
 */
export function normalizeSender(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > AGENT_INPUT_MAX) return null;
  let name = trimmed.toLowerCase();
  name = name.replace(/[\s_]+/g, "-");
  name = name.replace(/[^a-z0-9-]/g, "");
  name = name.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (name.length > 32) name = name.slice(0, 32).replace(/-+$/g, "");
  return isAgentName(name) ? name : null;
}

export function isStatus(value: string): value is TaskStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function validateTaskId(id: string): string | null {
  if (!UUID.test(id)) return "Task id must be a UUID.";
  return null;
}

function hasControlChars(value: string, allowNewlines: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0) return true;
    if (allowNewlines && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function validateLabel(value: string, field: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${field} is required.`;
  if (trimmed.length > max) return `${field} must be at most ${max} characters.`;
  if (hasControlChars(trimmed, false)) return `${field} contains unsupported control characters.`;
  return null;
}

export function validateBody(value: string, field: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${field} is required.`;
  if (trimmed.length > max) return `${field} must be at most ${max} characters.`;
  if (hasControlChars(value, true)) return `${field} contains unsupported control characters.`;
  return null;
}

export function toTask(row: TaskRow): Task {
  // Rows written before agent names were opened are grokbot or claude, both of
  // which match AGENT_NAME_PATTERN. Anything else stored by a hand edit still
  // reads back as claude, which is what this function did for unknown values.
  const assignee = isAgentName(row.assignee) ? row.assignee : "claude";
  const status = isStatus(row.status) ? row.status : "pending";
  let webhook: WebhookState | null = null;
  if (row.webhook_attempted === 1 || row.webhook_error !== null) {
    webhook = {
      attempted: row.webhook_attempted === 1,
      ok: row.webhook_ok === null ? null : row.webhook_ok === 1,
      http_status: row.webhook_http_status,
      error: row.webhook_error,
    };
  }
  return {
    id: row.id,
    to: assignee,
    from: row.author,
    title: row.title,
    instructions: row.instructions,
    status,
    result: row.result,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    webhook,
  };
}

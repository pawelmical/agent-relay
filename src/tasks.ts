export const PARTIES = ["grokbot", "claude"] as const;
export const STATUSES = ["pending", "in_progress", "done", "failed"] as const;

export type Party = (typeof PARTIES)[number];
export type TaskStatus = (typeof STATUSES)[number];

export const LIMITS = {
  title: 200,
  instructions: 16_000,
  result: 64_000,
  from: 80,
  list: 50,
} as const;

export interface WebhookState {
  attempted: boolean;
  ok: boolean | null;
  http_status: number | null;
  error: string | null;
}

export interface Task {
  id: string;
  to: Party;
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

export function isParty(value: string): value is Party {
  return (PARTIES as readonly string[]).includes(value);
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
  const assignee = isParty(row.assignee) ? row.assignee : "claude";
  const status = isStatus(row.status) ? row.status : "pending";
  let webhook: WebhookState | null = null;
  if (assignee === "grokbot" && (row.webhook_attempted === 1 || row.webhook_error !== null)) {
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

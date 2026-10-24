import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  fail,
  isParty,
  isStatus,
  ok,
  toTask,
  validateBody,
  validateLabel,
  validateTaskId,
  type MailboxResult,
  type Party,
  type Task,
  type TaskRow,
  type TaskStatus,
} from "./tasks";

export interface CreateTaskInput {
  to: string;
  from: string;
  title: string;
  instructions: string;
}

export interface WebhookReceipt {
  attempted: boolean;
  ok: boolean | null;
  httpStatus: number | null;
  error: string | null;
}

/**
 * One SQLite object holds the whole mailbox. Claude and the Grok Bot share a
 * single queue, so one Durable Object is the coordination atom: claims and
 * status changes stay consistent without a second index.
 */
export class Mailbox extends DurableObject<Env> {
  private lastMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          assignee TEXT NOT NULL,
          author TEXT NOT NULL,
          title TEXT NOT NULL,
          instructions TEXT NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          webhook_attempted INTEGER NOT NULL DEFAULT 0,
          webhook_ok INTEGER,
          webhook_http_status INTEGER,
          webhook_error TEXT
        )
      `);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_tasks_lookup ON tasks (assignee, status, created_at)",
      );
    });
  }

  async create(input: CreateTaskInput): Promise<MailboxResult<Task>> {
    if (!isParty(input.to)) return fail("to must be grokbot or claude.");
    const authorError = validateLabel(input.from, "from", LIMITS.from);
    if (authorError) return fail(authorError);
    const titleError = validateLabel(input.title, "title", LIMITS.title);
    if (titleError) return fail(titleError);
    const instructionsError = validateBody(input.instructions, "instructions", LIMITS.instructions);
    if (instructionsError) return fail(instructionsError);

    const now = this.nowIso();
    const id = crypto.randomUUID();
    const rows = this.query(
      `INSERT INTO tasks (
        id, assignee, author, title, instructions, status, result, error,
        created_at, updated_at, claimed_at, completed_at,
        webhook_attempted, webhook_ok, webhook_http_status, webhook_error
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL, 0, NULL, NULL, NULL)
      RETURNING *`,
      id,
      input.to,
      input.from.trim(),
      input.title.trim(),
      input.instructions.trim(),
      now,
      now,
    );
    const row = rows[0];
    if (!row) return fail("The task could not be stored.");
    console.log(JSON.stringify({ event: "task_created", taskId: id, to: input.to }));
    return ok(toTask(row));
  }

  async list(assignee: string | null, status: string | null, limit: number): Promise<MailboxResult<Task[]>> {
    if (assignee !== null && !isParty(assignee)) return fail("for must be grokbot or claude.");
    if (status !== null && !isStatus(status)) {
      return fail("status must be pending, in_progress, done, or failed.");
    }
    const bounded = Number.isFinite(limit) ? Math.trunc(limit) : 20;
    if (bounded < 1 || bounded > LIMITS.list) {
      return fail(`limit must be between 1 and ${LIMITS.list}.`);
    }

    const clauses: string[] = [];
    const binds: string[] = [];
    if (assignee) {
      clauses.push("assignee = ?");
      binds.push(assignee);
    }
    if (status) {
      clauses.push("status = ?");
      binds.push(status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.query(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`,
      ...binds,
      bounded,
    );
    return ok(rows.map(toTask));
  }

  async get(id: string): Promise<MailboxResult<Task>> {
    const idError = validateTaskId(id);
    if (idError) return fail(idError);
    const row = this.row(id);
    if (!row) return fail(`No task with id ${id}.`);
    return ok(toTask(row));
  }

  async claim(id: string): Promise<MailboxResult<Task>> {
    const idError = validateTaskId(id);
    if (idError) return fail(idError);
    const now = this.nowIso();
    const updated = this.query(
      `UPDATE tasks
       SET status = 'in_progress', claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'
       RETURNING *`,
      now,
      now,
      id,
    );
    const row = updated[0];
    if (row) {
      console.log(JSON.stringify({ event: "task_claimed", taskId: id }));
      return ok(toTask(row));
    }
    return this.transitionError(id, "claimed", "pending");
  }

  async complete(id: string, result: string, outcome: string): Promise<MailboxResult<Task>> {
    const idError = validateTaskId(id);
    if (idError) return fail(idError);
    if (outcome !== "done" && outcome !== "failed") return fail("outcome must be done or failed.");
    const resultError = validateBody(result, "result", LIMITS.result);
    if (resultError) return fail(resultError);

    const now = this.nowIso();
    const storedResult = result.trim();
    const updated = this.query(
      `UPDATE tasks
       SET status = ?, result = ?, error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`,
      outcome,
      storedResult,
      outcome === "failed" ? storedResult : null,
      now,
      now,
      id,
    );
    const row = updated[0];
    if (row) {
      console.log(JSON.stringify({ event: "task_completed", taskId: id, outcome }));
      return ok(toTask(row));
    }
    return this.transitionError(id, "completed", "in_progress");
  }

  async recordWebhook(id: string, receipt: WebhookReceipt): Promise<MailboxResult<Task>> {
    const idError = validateTaskId(id);
    if (idError) return fail(idError);
    const updated = this.query(
      `UPDATE tasks
       SET webhook_attempted = ?, webhook_ok = ?, webhook_http_status = ?, webhook_error = ?
       WHERE id = ?
       RETURNING *`,
      receipt.attempted ? 1 : 0,
      receipt.ok === null ? null : receipt.ok ? 1 : 0,
      receipt.httpStatus,
      receipt.error,
      id,
    );
    const row = updated[0];
    if (!row) return fail(`No task with id ${id}.`);
    return ok(toTask(row));
  }

  /** Test helper. Not registered as an MCP tool. */
  async reset(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM tasks");
  }

  private transitionError(id: string, verb: string, required: TaskStatus): MailboxResult<Task> {
    const row = this.row(id);
    if (!row) return fail(`No task with id ${id}.`);
    return fail(`Task ${id} is ${row.status} and cannot be ${verb}. Only ${required} tasks can be ${verb}.`);
  }

  private query(sql: string, ...bindings: Array<string | number | null>): TaskRow[] {
    return this.ctx.storage.sql.exec(sql, ...bindings).toArray().map(readTaskRow);
  }

  private row(id: string): TaskRow | undefined {
    return this.query("SELECT * FROM tasks WHERE id = ?", id)[0];
  }

  private nowIso(): string {
    const ms = Math.max(Date.now(), this.lastMs + 1);
    this.lastMs = ms;
    return new Date(ms).toISOString();
  }
}

function textOrNull(value: SqlStorageValue): string | null {
  return value === null ? null : String(value);
}

function numberOrNull(value: SqlStorageValue): number | null {
  return value === null ? null : Number(value);
}

function readTaskRow(value: Record<string, SqlStorageValue>): TaskRow {
  return {
    id: String(value.id),
    assignee: String(value.assignee),
    author: String(value.author),
    title: String(value.title),
    instructions: String(value.instructions),
    status: String(value.status),
    result: textOrNull(value.result),
    error: textOrNull(value.error),
    created_at: String(value.created_at),
    updated_at: String(value.updated_at),
    claimed_at: textOrNull(value.claimed_at),
    completed_at: textOrNull(value.completed_at),
    webhook_attempted: Number(value.webhook_attempted),
    webhook_ok: numberOrNull(value.webhook_ok),
    webhook_http_status: numberOrNull(value.webhook_http_status),
    webhook_error: textOrNull(value.webhook_error),
  };
}

export function mailboxStub(env: Env) {
  return env.MAILBOX.getByName("shared");
}

export type { Party, Task };

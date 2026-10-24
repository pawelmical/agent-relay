import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./mcp-client";
import { setWebhookBehavior, webhookCalls } from "./webhook-capture";

interface TaskJson {
  id: string;
  to: string;
  from: string;
  title: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  webhook: { attempted: boolean; ok: boolean | null; http_status: number | null; error: string | null } | null;
}

describe("task lifecycle", () => {
  beforeEach(async () => {
    webhookCalls.length = 0;
    setWebhookBehavior("ok");
    await env.MAILBOX.getByName("shared").reset();
  });

  it("moves a Claude task from pending to done and keeps a second claim from succeeding", async () => {
    const created = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: 'Review "login" notes',
      instructions: "Read the notes and say what should change.",
    });
    expect(created.isError).toBe(false);
    const task = created.json as TaskJson;
    expect(task.status).toBe("pending");
    expect(task.webhook).toBeNull();
    expect(webhookCalls).toHaveLength(0);
    expect(task.created_at).toMatch(/Z$/);

    const listed = await callTool("list_tasks", { for: "claude", status: "pending" });
    const list = listed.json as { tasks: TaskJson[]; count: number };
    expect(list.count).toBe(1);
    expect(list.tasks[0]?.id).toBe(task.id);

    const other = await callTool("list_tasks", { for: "grokbot" });
    expect((other.json as { count: number }).count).toBe(0);

    const beforeClaim = await callTool("complete_task", { id: task.id, result: "too soon" });
    expect(beforeClaim.isError).toBe(true);
    expect(beforeClaim.text).toContain("pending");

    const claimed = await callTool("claim_task", { id: task.id });
    const claimedTask = claimed.json as TaskJson;
    expect(claimedTask.status).toBe("in_progress");
    expect(claimedTask.claimed_at).toBeTruthy();

    const secondClaim = await callTool("claim_task", { id: task.id });
    expect(secondClaim.isError).toBe(true);
    expect(secondClaim.text).toContain("in_progress");

    const finishedCall = await callTool("complete_task", { id: task.id, result: "done already" });
    expect(finishedCall.isError).toBe(false);

    const again = await callTool("complete_task", { id: task.id, result: "again" });
    expect(again.isError).toBe(true);

    const fetched = await callTool("get_task", { id: task.id });
    const finished = fetched.json as TaskJson;
    expect(finished.status).toBe("done");
    expect(finished.result).toBe("done already");
    expect(finished.error).toBeNull();
    expect(finished.completed_at).toBeTruthy();
  });

  it("wakes the Grok webhook, records a failure without losing the task, and can mark work failed", async () => {
    const created = await callTool("create_task", {
      to: "grokbot",
      from: "claude",
      title: "Audit the rate limiter",
      instructions: "Check src/auth and report the missing limits.",
    });
    const task = created.json as TaskJson;
    expect(task.webhook?.attempted).toBe(true);
    expect(task.webhook?.ok).toBe(true);
    expect(task.webhook?.http_status).toBe(204);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.authorization).toBe("Bearer crsr_test_key");
    const payload = JSON.parse(webhookCalls[0]?.body ?? "{}") as { event: string; task_id: string; instructions: string };
    expect(payload.event).toBe("task.created");
    expect(payload.task_id).toBe(task.id);
    expect(payload.instructions).toContain("src/auth");

    setWebhookBehavior("down");
    const broken = await callTool("create_task", {
      to: "grokbot",
      from: "claude",
      title: "Retry later",
      instructions: "This delivery will fail.",
    });
    const brokenTask = broken.json as TaskJson;
    expect(brokenTask.status).toBe("pending");
    expect(brokenTask.webhook?.ok).toBe(false);
    expect(brokenTask.webhook?.http_status).toBe(503);

    setWebhookBehavior("redirect");
    const redirected = await callTool("create_task", {
      to: "grokbot",
      from: "claude",
      title: "Do not follow",
      instructions: "The webhook redirects.",
    });
    expect((redirected.json as TaskJson).webhook?.error).toContain("not followed");
    expect(webhookCalls.filter((call) => call.url.startsWith("https://hooks.test/"))).toHaveLength(3);

    const missing = await callTool("get_task", { id: "not-a-uuid" });
    expect(missing.isError).toBe(true);

    const badParty = await callTool("create_task", {
      to: "someone-else",
      from: "claude",
      title: "Nope",
      instructions: "This party is not allowed.",
    });
    expect(badParty.isError).toBe(true);

    await callTool("claim_task", { id: task.id });
    const failed = await callTool("complete_task", {
      id: task.id,
      outcome: "failed",
      result: "The limiter file is not in this repo.",
    });
    const failedTask = failed.json as TaskJson;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.error).toContain("limiter");
    expect(failedTask.result).toContain("limiter");
  });
});

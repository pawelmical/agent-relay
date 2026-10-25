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
    const payload = JSON.parse(webhookCalls[0]?.body ?? "{}") as {
      event: string;
      task_id: string;
      title: string;
      instructions?: string;
    };
    expect(payload.event).toBe("task.created");
    expect(payload.task_id).toBe(task.id);
    expect(payload.title).toBe("Audit the rate limiter");
    expect(payload.instructions).toBeUndefined();

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
      to: "not a name",
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

  it("deletes a task, drops finished tasks after 30 days, and refuses a 501st row", async () => {
    const created = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "Keep me",
      instructions: "Still needed.",
    });
    const task = created.json as TaskJson;
    const removed = await callTool("delete_task", { id: task.id });
    expect(removed.isError).toBe(false);
    const gone = await callTool("get_task", { id: task.id });
    expect(gone.isError).toBe(true);

    const aging = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "Old result",
      instructions: "This result should age out.",
    });
    const recent = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "Fresh result",
      instructions: "This result stays.",
    });
    const oldId = (aging.json as TaskJson).id;
    const freshId = (recent.json as TaskJson).id;
    const mailbox = env.MAILBOX.getByName("shared");
    const oldStamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const freshStamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await mailbox.backdateForTests(oldId, oldStamp);
    await mailbox.backdateForTests(freshId, freshStamp);
    await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "Trigger purge",
      instructions: "Creating this runs retention.",
    });
    expect((await callTool("get_task", { id: oldId })).isError).toBe(true);
    expect((await callTool("get_task", { id: freshId })).isError).toBe(false);

    await mailbox.reset();
    await mailbox.seedForTests(500);
    const overflow = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "One too many",
      instructions: "The cap should refuse this.",
    });
    expect(overflow.isError).toBe(true);
    expect(overflow.text).toContain("500");
  });
});

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { callTool, rpc, TOKEN } from "./mcp-client";
import { setWebhookBehavior, webhookCalls } from "./webhook-capture";

interface TaskJson {
  id: string;
  to: string;
  from: string;
  title: string;
  instructions: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  webhook: { attempted: boolean; ok: boolean | null; http_status: number | null; error: string | null } | null;
}

describe("any agent", () => {
  beforeEach(async () => {
    webhookCalls.length = 0;
    setWebhookBehavior("ok");
    await env.MAILBOX.getByName("shared").reset();
  });

  it("rejects assignee names that are not slugs after trim and lowercase", async () => {
    for (const name of ["grok bot", "gpt.bot", "a", "4gpt", "claude--bot", "claude-", "сlaude"]) {
      const created = await callTool("create_task", {
        to: name,
        from: "claude",
        title: "Nope",
        instructions: "This name is not allowed.",
      });
      expect(created.isError).toBe(true);
    }
    const badFrom = await callTool("create_task", {
      to: "claude",
      from: "!!!",
      title: "Nope",
      instructions: "Sender name has no letters.",
    });
    expect(badFrom.isError).toBe(true);
    const badFilter = await callTool("list_tasks", { for: "not a name" });
    expect(badFilter.isError).toBe(true);
  });

  it("accepts Claude, Grok Bot, and hyphenated names without changing grokbot or claude", async () => {
    const claudeTask = await callTool("create_task", {
      to: "Claude",
      from: "Claude",
      title: "Same claude",
      instructions: "Upper case is the same assignee.",
    });
    expect(claudeTask.isError).toBe(false);
    const claude = claudeTask.json as TaskJson;
    expect(claude.to).toBe("claude");
    expect(claude.from).toBe("claude");
    expect(claude.webhook).toBeNull();
    const listed = await callTool("list_tasks", { for: " Claude " });
    const ids = (listed.json as { tasks: TaskJson[] }).tasks.map((task) => task.id);
    expect(ids).toContain(claude.id);

    const labeled = await callTool("create_task", {
      to: "claude-right-hand",
      from: "Grok Bot",
      title: "Hyphenated assignee",
      instructions: "The sender label becomes a slug.",
    });
    expect(labeled.isError).toBe(false);
    const hand = labeled.json as TaskJson;
    expect(hand.to).toBe("claude-right-hand");
    expect(hand.from).toBe("grok-bot");
    expect(hand.webhook).toBeNull();

    const woken = await callTool("create_task", {
      to: " Grokbot ",
      from: "claude-right-hand",
      title: "Still grokbot",
      instructions: "Trim and lowercase keep the grokbot webhook.",
    });
    const grok = woken.json as TaskJson;
    expect(grok.to).toBe("grokbot");
    expect(grok.from).toBe("claude-right-hand");
    expect(grok.webhook?.ok).toBe(true);
    expect(webhookCalls.map((call) => call.url)).toEqual(["https://hooks.test/grok"]);
  });

  it("runs a cursor task and wakes only that agent's webhook", async () => {
    const created = await callTool("create_task", {
      to: "cursor",
      from: "gpt",
      title: "Check the header",
      instructions: "Read the login page and stop.",
    });
    expect(created.isError).toBe(false);
    const task = created.json as TaskJson;
    expect(task.to).toBe("cursor");
    expect(task.from).toBe("gpt");
    expect(task.status).toBe("pending");
    expect(task.webhook?.attempted).toBe(true);
    expect(task.webhook?.ok).toBe(true);
    expect(task.webhook?.http_status).toBe(204);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.url).toBe("https://hooks.test/cursor");
    expect(webhookCalls[0]?.authorization).toBe("Bearer cursor-token");
    const payload = JSON.parse(webhookCalls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["event", "task_id", "title"]);
    expect(payload).toEqual({ event: "task.created", task_id: task.id, title: "Check the header" });

    const listed = await callTool("list_tasks", { for: "cursor", status: "pending" });
    expect((listed.json as { count: number }).count).toBe(1);
    const other = await callTool("list_tasks", { for: "gpt" });
    expect((other.json as { count: number }).count).toBe(0);

    const claimed = await callTool("claim_task", { id: task.id });
    expect((claimed.json as TaskJson).status).toBe("in_progress");
    const finished = await callTool("complete_task", { id: task.id, result: "Header is fine." });
    const done = finished.json as TaskJson;
    expect(done.status).toBe("done");
    expect(done.result).toBe("Header is fine.");
    expect(done.error).toBeNull();
  });

  it("refuses a private per-agent URL and still wakes grokbot through GROKBOT_WEBHOOK_URL", async () => {
    const blocked = await callTool("create_task", {
      to: "gemini",
      from: "cursor",
      title: "Do not fetch",
      instructions: "The wake URL is a private address.",
    });
    const blockedTask = blocked.json as TaskJson;
    expect(blockedTask.status).toBe("pending");
    expect(blockedTask.webhook?.attempted).toBe(false);
    expect(blockedTask.webhook?.error).toMatch(/private/);
    expect(webhookCalls).toHaveLength(0);

    const legacy = await callTool("create_task", {
      to: "grokbot",
      from: "claude",
      title: "Still the grok doorbell",
      instructions: "Use the original webhook secrets.",
    });
    const grok = legacy.json as TaskJson;
    expect(grok.webhook?.ok).toBe(true);
    expect(grok.webhook?.http_status).toBe(204);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]?.url).toBe("https://hooks.test/grok");
    expect(webhookCalls[0]?.authorization).toBe("Bearer crsr_test_key");
    const payload = JSON.parse(webhookCalls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({ event: "task.created", task_id: grok.id, title: "Still the grok doorbell" });

    const quiet = await callTool("create_task", {
      to: "claude",
      from: "grokbot",
      title: "No doorbell",
      instructions: "Claude has no wake URL.",
    });
    expect((quiet.json as TaskJson).webhook).toBeNull();
    expect(webhookCalls).toHaveLength(1);
  });

  it("keeps historical grokbot and claude rows after the schema SQL runs again", async () => {
    const seeded = await env.MAILBOX.getByName("shared").seedHistoricalTasksForTests();
    const grok = (await callTool("get_task", { id: seeded.grokbotId })).json as TaskJson;
    expect(grok.to).toBe("grokbot");
    expect(grok.from).toBe("claude");
    expect(grok.title).toBe("Legacy grok");
    expect(grok.instructions).toBe("Old grok instructions");
    expect(grok.status).toBe("pending");
    expect(grok.created_at).toBe("2024-01-15T12:00:00.000Z");
    expect(grok.webhook).toEqual({ attempted: true, ok: true, http_status: 204, error: null });

    const claude = (await callTool("get_task", { id: seeded.claudeId })).json as TaskJson;
    expect(claude.to).toBe("claude");
    expect(claude.from).toBe("grokbot");
    expect(claude.title).toBe("Legacy claude");
    expect(claude.instructions).toBe("Old claude instructions");
    expect(claude.status).toBe("in_progress");
    expect(claude.claimed_at).toBe("2024-01-15T12:00:00.000Z");
    expect(claude.webhook).toBeNull();

    const listed = await callTool("list_tasks", { for: "grokbot" });
    const ids = (listed.json as { tasks: TaskJson[] }).tasks.map((task) => task.id);
    expect(ids).toContain(seeded.grokbotId);
    expect(ids).not.toContain(seeded.claudeId);
  });

  it("tells a generic agent to list tasks for its own name", async () => {
    const listed = await rpc("tools/list", {}, TOKEN);
    const tools = (listed.body as { result?: { tools?: { name: string; description?: string }[] } }).result?.tools ?? [];
    const listTasks = tools.find((tool) => tool.name === "list_tasks");
    const createTask = tools.find((tool) => tool.name === "create_task");
    expect(listTasks?.description).toMatch(/your own agent name/);
    expect(createTask?.description).toMatch(/grokbot/);
    expect(createTask?.description).toMatch(/cursor/);
  });
});

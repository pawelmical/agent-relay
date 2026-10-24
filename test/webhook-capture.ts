export interface CapturedWebhook {
  url: string;
  body: string;
  authorization: string | null;
}

export const webhookCalls: CapturedWebhook[] = [];
export let webhookBehavior: "ok" | "down" | "redirect" = "ok";

export function setWebhookBehavior(next: "ok" | "down" | "redirect"): void {
  webhookBehavior = next;
}

const installed = Symbol.for("task-mailbox.webhook-capture");

export function installWebhookCapture(): void {
  const globalState = globalThis as typeof globalThis & { [installed]?: boolean };
  if (globalState[installed]) return;
  globalState[installed] = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://hooks.test/")) {
      const headers = new Headers(init?.headers);
      webhookCalls.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        authorization: headers.get("authorization"),
      });
      if (webhookBehavior === "redirect") {
        return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
      }
      if (webhookBehavior === "down") return new Response("nope", { status: 503 });
      return new Response(null, { status: 204 });
    }
    return original(input, init);
  };
}

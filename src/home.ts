import { escapeHtml } from "./consent";

export function homePage(options: {
  requestOrigin: string | null;
  pinnedOrigin: string | null;
  pinError: string | null;
  ready: boolean;
}): string {
  const mcp = options.pinnedOrigin
    ? `${options.pinnedOrigin}/mcp`
    : options.requestOrigin
      ? `${options.requestOrigin}/mcp`
      : "/mcp";
  const ready = options.ready ? "The mailbox token is set." : "MCP_AUTH_TOKEN is missing or shorter than 16 characters.";
  const pin = options.pinError
    ? `<p class="warn">${escapeHtml(options.pinError)}</p>`
    : options.pinnedOrigin
      ? `<p>Pinned origin: <code>${escapeHtml(options.pinnedOrigin)}</code></p>`
      : "<p>No pinned origin. OAuth uses the host of each request.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Task mailbox</title>
<style>
  body { margin: 0; background: #f3efe6; color: #1d1a16; font: 17px/1.5 Georgia, "Iowan Old Style", serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  h1 { font-size: 2rem; line-height: 1.15; margin: 0 0 0.4rem; }
  h2 { font-size: 1.15rem; margin: 1.6rem 0 0.4rem; }
  p { margin: 0.5rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .card { background: #fffdf8; border: 1px solid #d9d0c1; padding: 0.9rem 1rem; margin: 1rem 0; }
  .warn { color: #7a2e12; }
</style>
</head>
<body>
<main>
  <h1>Task mailbox</h1>
  <p>Skrzynka zadań dla agentów MCP. Ten adres to serwer MCP, nie panel.</p>
  <div class="card">
    <p>MCP endpoint</p>
    <p><code>${escapeHtml(mcp)}</code></p>
    <p>${escapeHtml(ready)}</p>
    ${pin}
  </div>
  <h2>How a task moves</h2>
  <p>pending, then claim_task, then complete_task. Any lowercase agent name can leave or receive a task. grokbot and claude still work. A wake URL, when that agent has one, is POSTed the task id and title only. Instructions stay in the mailbox until the assignee calls get_task.</p>
  <p>pending, potem claim_task, potem complete_task. Zadanie dla grokbot budzi webhook samym identyfikatorem i tytułem. Instrukcja zostaje w skrzynce, dopóki odbiorca nie wywoła get_task. Zadanie dla claude czeka, aż Claude odczyta skrzynkę.</p>
  <h2>Auth</h2>
  <p>Claude’s custom connector uses OAuth and asks for the mailbox token once. The Grok Bot sends <code>Authorization: Bearer</code> with that same token. <a href="/health">Health</a> does not require either.</p>
</main>
</body>
</html>`;
}

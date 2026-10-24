/** Shared limits for auth guesses, registration, and the task table. */
export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const SECRET_FAILURE_LIMIT = 8;
export const REGISTER_LIMIT = 20;
export const REGISTER_GLOBAL_LIMIT = 100;

export function dcrEnabled(env: { MCP_DISABLE_DCR?: string }): boolean {
  const raw = env.MCP_DISABLE_DCR?.trim().toLowerCase() ?? "";
  return raw !== "1" && raw !== "true" && raw !== "yes";
}

export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  const ip = forwarded.length > 0 ? forwarded : "unknown";
  return ip.slice(0, 80);
}

export function rateBucket(request: Request, surface: "secret" | "consent" | "register"): string {
  return `${surface}:${clientAddress(request)}`;
}

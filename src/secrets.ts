const MINIMUM_TOKEN_LENGTH = 16;

export function configuredToken(env: { MCP_AUTH_TOKEN?: string }): string {
  const token = env.MCP_AUTH_TOKEN?.trim() ?? "";
  if (token.length < MINIMUM_TOKEN_LENGTH) return "";
  return token;
}

export function authConfigurationError(env: { MCP_AUTH_TOKEN?: string }): string | null {
  const token = env.MCP_AUTH_TOKEN?.trim() ?? "";
  if (token.length === 0) return "MCP_AUTH_TOKEN is not set.";
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    return "MCP_AUTH_TOKEN must be at least 16 characters.";
  }
  return null;
}

/** Compare secrets without leaking length or prefix through timing. */
export async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  if (expected.length === 0 || provided.length === 0) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

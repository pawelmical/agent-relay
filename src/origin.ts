export class OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OriginError";
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Canonical origin for OAuth resource metadata. HTTPS, or HTTP on loopback.
 * No path, query, fragment, userinfo, or default port.
 */
export function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OriginError("The public URL must be absolute.");
  }
  if (url.username || url.password) {
    throw new OriginError("The public URL cannot include a username or password.");
  }
  if (url.search || url.hash) {
    throw new OriginError("The public URL cannot include a query or fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new OriginError("The public URL must be an origin, without a path.");
  }
  if (url.protocol === "http:") {
    if (!isLoopback(url.hostname)) {
      throw new OriginError("http is only allowed on localhost.");
    }
  } else if (url.protocol !== "https:") {
    throw new OriginError("The public URL must use https, or http on localhost.");
  }
  return url.origin;
}

export function requestOrigin(requestUrl: string): string {
  return canonicalOrigin(new URL(requestUrl).origin);
}

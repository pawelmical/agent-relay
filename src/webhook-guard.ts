/**
 * Decide whether a configured webhook URL is safe to POST to.
 * Loopback stays allowed so `wrangler dev` can wake a local receiver.
 * Every other literal private, link-local, metadata, or special-use host is refused
 * before fetch. `global_fetch_strictly_public` still blocks names that resolve
 * to a private address; this check is for the literal the operator pasted.
 */

function stripHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** Private, link-local, documentation, multicast, and reserved IPv4. Loopback is allowed. */
function isDisallowedIPv4(value: number): boolean {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  if (a === 127) return false;
  if (a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIPv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const v4 = ipv4ToInt(part);
        if (v4 === null) return null;
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = parseSide(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseSide(halves[1] ?? "");
  if (!right || left.length + right.length > 8) return null;
  const zeros = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

function isIpv6Loopback(groups: number[]): boolean {
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

function embeddedIPv4(groups: number[]): number | null {
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!compatible && !mapped) return null;
  return ((groups[6] ?? 0) << 16) | (groups[7] ?? 0);
}

function isDisallowedIPv6(groups: number[]): boolean {
  if (isIpv6Loopback(groups)) return false;
  if (groups.every((group) => group === 0)) return true;
  const embedded = embeddedIPv4(groups);
  if (embedded !== null && !isIpv6Loopback(groups)) return isDisallowedIPv4(embedded);
  const head = groups[0] ?? 0;
  if ((head & 0xffc0) === 0xfe80) return true;
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xff00) === 0xff00) return true;
  if (head === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = stripHost(hostname);
  if (host === "localhost" || host === "::1") return true;
  const v4 = ipv4ToInt(host);
  if (v4 !== null) return ((v4 >>> 24) & 255) === 127;
  const v6 = parseIPv6(host);
  return v6 !== null && isIpv6Loopback(v6);
}

export function isDisallowedWebhookHost(hostname: string): boolean {
  const host = stripHost(hostname);
  if (host.length === 0 || host === "localhost" || isLoopbackHost(host)) return false;
  const v4 = ipv4ToInt(host);
  if (v4 !== null) return isDisallowedIPv4(v4);
  const v6 = parseIPv6(host);
  if (v6) return isDisallowedIPv6(v6);
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

export function explainWebhookUrl(raw: string, label = "GROKBOT_WEBHOOK_URL"): string | null {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return `${label} is not a URL.`;
  }
  if (isDisallowedWebhookHost(target.hostname)) {
    return `${label} points at a private, link-local, or special-use host.`;
  }
  const allowed = target.protocol === "https:" || (target.protocol === "http:" && isLoopbackHost(target.hostname));
  if (!allowed) {
    return `${label} must be https, or http on localhost.`;
  }
  return null;
}

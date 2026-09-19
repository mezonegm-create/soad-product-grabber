import dns from "node:dns";
import net from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Returns true if the given IP address (v4 or v6) is loopback, private,
 * link-local, multicast, or otherwise not a legitimate public target.
 */
export function isDisallowedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined || parts.some((n) => Number.isNaN(n))) return true;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // IETF protocol assignments / benchmarking (192.0.0.0/24, 192.0.2.0/24)
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // TEST-NET-2
    if (a === 203 && b === 0) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (type === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true; // loopback
    if (normalized === "::") return true; // unspecified
    if (normalized.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 address, unwrap and re-check
      const mapped = normalized.slice("::ffff:".length);
      if (net.isIP(mapped) === 4) return isDisallowedIp(mapped);
    }
    if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
      return true; // link-local fe80::/10
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
    if (normalized.startsWith("ff")) return true; // multicast
    return false;
  }
  // Not a recognizable IP literal -- treat as unsafe by default.
  return true;
}

/**
 * Validates that a user-supplied string is a well-formed, publicly routable
 * http(s) URL. Throws UnsafeUrlError otherwise. Does not perform DNS
 * resolution (see resolveSafeAddress for the rebinding-safe follow-up check).
 */
export function validateCandidateUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError("The URL is not well-formed.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are supported.");
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed.");
  }

  const hostname = stripBrackets(url.hostname.toLowerCase().replace(/\.$/, ""));
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError("Requests to localhost are not allowed.");
  }
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localdomain")) {
    throw new UnsafeUrlError("Requests to internal-only hostnames are not allowed.");
  }

  const ipType = net.isIP(hostname);
  if (ipType && isDisallowedIp(hostname)) {
    throw new UnsafeUrlError("Requests to private, loopback, or link-local addresses are not allowed.");
  }

  return url;
}

/**
 * Resolves a hostname and asserts every resolved address is a public,
 * routable address. Used both before connecting and, since DNS can be
 * re-resolved between the check and the actual connection (DNS rebinding),
 * the resolved address is also passed explicitly to the socket connect call
 * by the caller so the checked address is the address actually used.
 */
export async function resolveSafeAddress(rawHostname: string): Promise<{ address: string; family: number }> {
  const hostname = stripBrackets(rawHostname);
  const ipType = net.isIP(hostname);
  if (ipType) {
    if (isDisallowedIp(hostname)) {
      throw new UnsafeUrlError("Requests to private, loopback, or link-local addresses are not allowed.");
    }
    return { address: hostname, family: ipType };
  }

  const results = await dns.promises.lookup(hostname, { all: true, verbatim: false });
  if (results.length === 0) {
    throw new UnsafeUrlError("The hostname could not be resolved.");
  }
  for (const result of results) {
    if (isDisallowedIp(result.address)) {
      throw new UnsafeUrlError("The hostname resolves to a private or internal address and cannot be fetched.");
    }
  }
  const first = results[0]!;
  return { address: first.address, family: first.family };
}

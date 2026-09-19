import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { resolveSafeAddress, validateCandidateUrl, UnsafeUrlError } from "./ssrf.js";

export { UnsafeUrlError };

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; SOADProductGrabber/1.0; +https://github.com/mezonegm-create/soad-product-grabber)";

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
}

export interface SafeFetchResult {
  finalUrl: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024; // 30MB safety cap per resource

/**
 * Fetches a URL while defending against SSRF: the target scheme/host is
 * validated up front, DNS is resolved once, the resolved (pinned) address is
 * used for the actual socket connection so a second DNS lookup during the
 * TCP handshake cannot rebind to an internal address, and every redirect hop
 * is independently re-validated before being followed.
 */
export async function safeFetch(inputUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let currentUrl = validateCandidateUrl(inputUrl);
  let redirects = 0;

  for (;;) {
    const pinned = await resolveSafeAddress(currentUrl.hostname);
    const result = await performRequest(currentUrl, pinned, {
      timeoutMs,
      maxBytes,
      headers: options.headers,
      method: options.method ?? "GET",
    });

    if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new UnsafeUrlError("Too many redirects.");
      }
      const nextUrl = new URL(result.headers.location, currentUrl);
      currentUrl = validateCandidateUrl(nextUrl.toString());
      continue;
    }

    return { ...result, finalUrl: currentUrl.toString() };
  }
}

/**
 * Builds a `net`/`http`-compatible `lookup` function that always resolves to
 * the single, already-SSRF-validated address (DNS pinning), regardless of
 * how Node's connection logic invokes it. Node's `dns.lookup`-compatible
 * lookup contract has two distinct calling conventions depending on the
 * caller's `options.all`:
 *   - all falsy (or omitted): callback(err, address: string, family: number)
 *   - all: true             : callback(err, addresses: LookupAddress[])
 * `net.connect`'s Happy-Eyeballs dual-stack path (`autoSelectFamily`,
 * default-on since Node 18/20) requests `{ all: true }`. Only handling the
 * single-address form there makes Node read `addresses[0].address` off a
 * bare string, yielding "Invalid IP address: undefined".
 */
export function createPinnedLookup(pinned: { address: string; family: number }): LookupFunction {
  return (_hostname, options, callback) => {
    const wantsAll = typeof options === "object" && options !== null && options.all === true;
    if (wantsAll) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

function performRequest(
  url: URL,
  pinned: { address: string; family: number },
  opts: { timeoutMs: number; maxBytes: number; headers?: Record<string, string>; method: string },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const lookup = createPinnedLookup(pinned);

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
          ...opts.headers,
        },
        servername: isHttps ? url.hostname : undefined,
        lookup,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(new Error("Response exceeded the maximum allowed size."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

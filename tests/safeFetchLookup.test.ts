import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import type { Server } from "node:http";
import { createPinnedLookup } from "../src/lib/safeFetch.js";

/**
 * Regression coverage for a real bug found testing against
 * https://www.allbirds.com/products/mens-trail-runners-swt on Windows:
 * `safeFetch` failed with `Invalid IP address: undefined`.
 *
 * Root cause: the DNS-pinning `lookup` shim always invoked its callback as
 * `(err, address, family)`. Node's `net.connect` Happy-Eyeballs dual-stack
 * path (`autoSelectFamily`, on by default since Node 18/20 for hostnames
 * that are not already IP literals) instead calls `lookup` with
 * `{ all: true }` and expects `(err, addresses: LookupAddress[])`. Getting a
 * bare string back where an array was expected surfaces deep inside Node as
 * `TypeError [ERR_INVALID_IP_ADDRESS]: Invalid IP address: undefined`.
 *
 * `createPinnedLookup` is exercised here through real `http.request` /
 * `net.connect` internals (not just called directly) against a local
 * server, with `autoSelectFamily: true` forced, which is the exact code
 * path that reproduced the bug.
 */

/** The pre-fix implementation, reproduced verbatim to prove it actually fails. */
function brokenLookup(
  _hostname: string,
  _options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  callback(null, "127.0.0.1", 4);
}

let server: Server;
let port: number;

async function startServer(): Promise<void> {
  server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A hostname that is not itself an IP literal is required to reproduce the
// bug: net.connect() skips the custom `lookup` function entirely when the
// target host is already an IP address, so the contract mismatch never
// triggers in that case.
const NON_IP_HOSTNAME = "definitely-not-a-real-host.example.invalid";

function requestWithLookup(lookup: http.RequestOptions["lookup"]): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: NON_IP_HOSTNAME,
        port,
        path: "/",
        method: "GET",
        lookup,
        // Forces Node's Happy-Eyeballs dual-stack path, which is what
        // invokes `lookup` with `{ all: true }`.
        autoSelectFamily: true,
      } as http.RequestOptions,
      (res) => {
        res.resume();
        res.on("end", () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("DNS-pinned lookup contract (autoSelectFamily / all:true)", () => {
  it("reproduces the exact reported failure with the pre-fix single-address-only lookup", async () => {
    await startServer();
    await expect(requestWithLookup(brokenLookup)).rejects.toThrow(/Invalid IP address/i);
  });

  it("succeeds with the fixed createPinnedLookup, which handles the all:true form", async () => {
    await startServer();
    const lookup = createPinnedLookup({ address: "127.0.0.1", family: 4 });
    const result = await requestWithLookup(lookup);
    expect(result.statusCode).toBe(200);
  });
});

describe("createPinnedLookup contract", () => {
  it("calls back with a single address/family when all is not requested", () => {
    const lookup = createPinnedLookup({ address: "203.0.113.5", family: 4 });
    const callback = vi.fn();
    lookup("any-host", {}, callback as never);
    expect(callback).toHaveBeenCalledWith(null, "203.0.113.5", 4);
  });

  it("calls back with a LookupAddress[] when options.all is true", () => {
    const lookup = createPinnedLookup({ address: "2001:db8::1", family: 6 });
    const callback = vi.fn();
    lookup("any-host", { all: true }, callback as never);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "2001:db8::1", family: 6 }]);
  });

  it("treats a non-object options value the same as all:false", () => {
    const lookup = createPinnedLookup({ address: "198.51.100.9", family: 4 });
    const callback = vi.fn();
    // Some callers invoke the legacy 2-arg dns.lookup form where the second
    // positional argument is a bare family number rather than an options
    // object; the shim must not crash or misinterpret that as `all: true`.
    lookup("any-host", 4 as never, callback as never);
    expect(callback).toHaveBeenCalledWith(null, "198.51.100.9", 4);
  });
});

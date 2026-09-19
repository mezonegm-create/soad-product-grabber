import { describe, it, expect } from "vitest";
import { validateCandidateUrl, isDisallowedIp, UnsafeUrlError, resolveSafeAddress } from "../src/lib/ssrf.js";

describe("validateCandidateUrl", () => {
  it("accepts well-formed public http/https URLs", () => {
    expect(() => validateCandidateUrl("https://example.com/product/1")).not.toThrow();
    expect(() => validateCandidateUrl("http://shop.example.com/x")).not.toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => validateCandidateUrl("not a url")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("")).toThrow(UnsafeUrlError);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateCandidateUrl("ftp://example.com/file")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("file:///etc/passwd")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("javascript:alert(1)")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("gopher://example.com")).toThrow(UnsafeUrlError);
  });

  it("rejects localhost and internal-only hostnames", () => {
    expect(() => validateCandidateUrl("http://localhost/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://localhost.localdomain/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://myhost.local/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://service.internal/")).toThrow(UnsafeUrlError);
  });

  it("rejects loopback and private IP literals", () => {
    expect(() => validateCandidateUrl("http://127.0.0.1/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://127.0.0.1:8080/admin")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://10.0.0.5/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://172.16.0.1/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://192.168.1.1/")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://169.254.169.254/latest/meta-data")).toThrow(UnsafeUrlError);
    expect(() => validateCandidateUrl("http://[::1]/")).toThrow(UnsafeUrlError);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => validateCandidateUrl("http://user:pass@example.com/")).toThrow(UnsafeUrlError);
  });

  it("allows public IP literals", () => {
    expect(() => validateCandidateUrl("http://8.8.8.8/")).not.toThrow();
  });
});

describe("isDisallowedIp", () => {
  it("flags private IPv4 ranges", () => {
    expect(isDisallowedIp("10.1.2.3")).toBe(true);
    expect(isDisallowedIp("172.20.0.1")).toBe(true);
    expect(isDisallowedIp("192.168.0.1")).toBe(true);
    expect(isDisallowedIp("100.64.0.1")).toBe(true);
    expect(isDisallowedIp("127.0.0.1")).toBe(true);
    expect(isDisallowedIp("169.254.1.1")).toBe(true);
    expect(isDisallowedIp("0.0.0.0")).toBe(true);
  });

  it("flags private/loopback IPv6 ranges", () => {
    expect(isDisallowedIp("::1")).toBe(true);
    expect(isDisallowedIp("fe80::1")).toBe(true);
    expect(isDisallowedIp("fc00::1")).toBe(true);
    expect(isDisallowedIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isDisallowedIp("93.184.216.34")).toBe(false);
    expect(isDisallowedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("resolveSafeAddress", () => {
  it("rejects IP-literal hostnames that are private", async () => {
    await expect(resolveSafeAddress("127.0.0.1")).rejects.toThrow(UnsafeUrlError);
  });

  it("passes through a public IP literal without a DNS lookup", async () => {
    const result = await resolveSafeAddress("93.184.216.34");
    expect(result.address).toBe("93.184.216.34");
  });
});

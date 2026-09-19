import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("POST /api/extract", () => {
  it("rejects a request with no url", async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a URL that targets a private/loopback address (SSRF protection)", async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:1/whatever" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/private|loopback|localhost/i);
  });

  it("rejects a non-http(s) scheme", async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a cloud metadata address", async () => {
    const res = await fetch(`${baseUrl}/api/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/download", () => {
  it("requires a url query parameter", async () => {
    const res = await fetch(`${baseUrl}/api/download`);
    expect(res.status).toBe(400);
  });

  it("rejects private-network download targets", async () => {
    const res = await fetch(`${baseUrl}/api/download?url=${encodeURIComponent("http://10.0.0.5/secret.png")}`);
    expect(res.status).toBe(400);
  });

  it("streams an embedded data: URL logo directly", async () => {
    const svg = Buffer.from("<svg></svg>").toString("base64");
    const res = await fetch(`${baseUrl}/api/download?url=${encodeURIComponent(`data:image/svg+xml;base64,${svg}`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });
});

describe("POST /api/download-all", () => {
  it("rejects an empty batch", async () => {
    const res = await fetch(`${baseUrl}/api/download-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("builds a zip containing only an embedded data: URL logo", async () => {
    const svg = Buffer.from("<svg></svg>").toString("base64");
    const res = await fetch(`${baseUrl}/api/download-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [], logo: `data:image/svg+xml;base64,${svg}` }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });
});

describe("static frontend", () => {
  it("serves the index page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SOAD Product Grabber");
  });
});

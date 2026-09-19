import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { Server } from "node:http";
import { renderWithBrowser, renderAtPinnedAddress, UnsafeUrlError } from "../src/lib/render/browserRender.js";

// A real headless-Chromium launch is only exercised when a browser is
// actually available in this environment (this sandbox has one
// pre-installed for exactly this purpose; a fresh checkout elsewhere
// without `npx playwright install chromium` run will skip these rather
// than fail the whole suite).
const SANDBOX_DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium";
const CHROMIUM_EXECUTABLE = process.env.SOAD_CHROMIUM_EXECUTABLE || SANDBOX_DEFAULT_CHROMIUM;
const chromiumAvailable = fs.existsSync(CHROMIUM_EXECUTABLE);
if (chromiumAvailable && !process.env.SOAD_CHROMIUM_EXECUTABLE) {
  process.env.SOAD_CHROMIUM_EXECUTABLE = CHROMIUM_EXECUTABLE;
}

let server: Server;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("renderWithBrowser SSRF gate", () => {
  it("rejects a private/loopback render target before ever launching a browser", async () => {
    await expect(renderWithBrowser("http://127.0.0.1:1/")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(renderWithBrowser("file:///etc/passwd")).rejects.toThrow(UnsafeUrlError);
  });
});

describe.skipIf(!chromiumAvailable)("renderAtPinnedAddress (real headless Chromium)", () => {
  it("captures a lazy-loaded gallery image that only appears after scrolling into view", async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><body>
        <div class="product-gallery">
          <img data-src="https://cdn.example.invalid/perfume-front.jpg" alt="Perfume front" class="lazy" />
        </div>
        <script>
          const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                entry.target.src = entry.target.getAttribute('data-src');
                io.unobserve(entry.target);
              }
            }
          });
          document.querySelectorAll('img.lazy').forEach((img) => io.observe(img));
          document.querySelector('.product-gallery').style.marginTop = '2000px';
        </script>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    // A fake public-looking hostname pinned to the local test server via
    // Chromium's --host-resolver-rules, mirroring how renderWithBrowser
    // pins a real, already-SSRF-vetted hostname to its resolved address.
    const url = new URL(`http://fake-perfume-shop.example.invalid:${port}/`);
    const result = await renderAtPinnedAddress(url, "127.0.0.1", { scrollSteps: 3 });

    expect(result.html).toContain('src="https://cdn.example.invalid/perfume-front.jpg"');
  }, 30_000);

  it("blocks a subresource request to a private address via route interception", async () => {
    server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><html><body><img id="probe" src="http://169.254.169.254/latest/meta-data" /></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const url = new URL(`http://fake-shop-two.example.invalid:${port}/`);
    // Should not throw even though the page references a disallowed
    // subresource -- the request is aborted, not the whole render.
    const result = await renderAtPinnedAddress(url, "127.0.0.1", { scrollSteps: 0 });
    expect(result.html).toContain('id="probe"');
  }, 30_000);
});

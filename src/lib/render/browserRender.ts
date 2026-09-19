import { chromium } from "playwright";
import { validateCandidateUrl, resolveSafeAddress, UnsafeUrlError } from "../ssrf.js";

export { UnsafeUrlError };

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

export interface RenderOptions {
  /** Hard cap on the whole render (navigation + scroll + settle). */
  timeoutMs?: number;
  /** Number of scroll-and-wait steps used to trigger lazy loading. */
  scrollSteps?: number;
}

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_SCROLL_STEPS = 6;
const GALLERY_SELECTOR_TIMEOUT_MS = 4_000;
const NETWORK_IDLE_TIMEOUT_MS = 5_000;
const SCROLL_STEP_DELAY_MS = 300;

// Deliberately generic (not tied to any single storefront's markup), the
// same vocabulary the static DOM extractor treats as a product gallery.
const GALLERY_WAIT_SELECTOR = [
  '[class*="gallery" i]',
  '[class*="product-media" i]',
  '[class*="product-image" i]',
  '[id*="gallery" i]',
  '[class*="product-photo" i]',
].join(", ");

/**
 * Renders a page with a real (headless) browser for product pages whose
 * gallery is populated by client-side JavaScript after the initial HTML
 * load -- static `fetch()` + Cheerio parsing can never see those images
 * because they simply aren't in the HTML the server sent. This is used
 * ONLY as a fallback when static extraction fails to find credible product
 * images (see `extractAssetsWithFallback`), never as the default path, so
 * a browser is not launched on every request.
 *
 * SSRF protections mirror `safeFetch`: the URL is validated the same way
 * and DNS is resolved once up front (`validateCandidateUrl` +
 * `resolveSafeAddress`) before anything is ever passed to Chromium. The
 * actual browser work happens in `renderAtPinnedAddress`, kept as a
 * separate exported function -- exactly the same split `safeFetch.ts` uses
 * between its SSRF gate and `createPinnedLookup`/`performRequest` -- so the
 * rendering mechanics (DNS pinning, subresource validation, scroll-based
 * lazy-load triggering) can be exercised directly in tests against a local
 * server without needing a real public DNS name.
 */
export async function renderWithBrowser(inputUrl: string, options: RenderOptions = {}): Promise<RenderedPage> {
  const url = validateCandidateUrl(inputUrl);
  const pinned = await resolveSafeAddress(url.hostname);
  return renderAtPinnedAddress(url, pinned.address, options);
}

/**
 * Renders `url` with Chromium pinned (via `--host-resolver-rules`) to
 * `pinnedAddress` for the navigation, and validates every subresource
 * request (images, scripts, XHR, redirects) through `validateCandidateUrl`
 * before allowing it -- a real browser fetches far more than the single
 * HTML document a plain HTTP request would, so every one of those
 * additional fetches needs the same scheme/private-IP checks. Callers are
 * responsible for having already validated `url` and resolved
 * `pinnedAddress` as a safe, public address (see `renderWithBrowser`).
 */
export async function renderAtPinnedAddress(
  url: URL,
  pinnedAddress: string,
  options: RenderOptions = {},
): Promise<RenderedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scrollSteps = options.scrollSteps ?? DEFAULT_SCROLL_STEPS;

  const launchOptions: LaunchOptions = {
    headless: true,
    args: [`--host-resolver-rules=MAP ${url.hostname} ${pinnedAddress}`],
  };
  // Only set when explicitly configured (e.g. a sandboxed dev/test
  // environment pointing at a pre-installed browser); production
  // deployments should run `npx playwright install chromium` and use
  // Playwright's own managed browser via the default (unset) executablePath.
  const executablePath = process.env.SOAD_CHROMIUM_EXECUTABLE;
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; SOADProductGrabber/1.0; +https://github.com/mezonegm-create/soad-product-grabber)",
    });

    await context.route("**/*", (route) => {
      try {
        validateCandidateUrl(route.request().url());
        void route.continue();
      } catch {
        void route.abort();
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Best-effort: a missing gallery container should not fail the whole
    // render, since the DOM might still hold usable images elsewhere.
    await page
      .waitForSelector(GALLERY_WAIT_SELECTOR, { timeout: GALLERY_SELECTOR_TIMEOUT_MS })
      .catch(() => undefined);

    // Trigger lazy-loading libraries that only swap in the real image
    // source once their element scrolls into the viewport.
    for (let i = 0; i < scrollSteps; i += 1) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(SCROLL_STEP_DELAY_MS);
    }
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);

    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await browser.close();
  }
}

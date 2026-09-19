/// <reference lib="dom" />
import { chromium, type Page } from "playwright";
import { validateCandidateUrl, resolveSafeAddress, UnsafeUrlError } from "../ssrf.js";

export { UnsafeUrlError };

export interface RenderDiagnostics {
  /** Which of GALLERY_WAIT_SELECTORS actually matched at least one element. */
  gallerySelectorsMatched: string[];
  imgCountAfterHydration: number;
  sourceCountAfterHydration: number;
  /** Every image URL found directly in the hydrated DOM (src/currentSrc/srcset/data-src/data-srcset/background-image/anchor href/embedded script state). */
  domImageUrls: string[];
  /** Every successful (2xx, image/*) HTTP response observed while the page rendered. */
  networkImageUrls: string[];
  screenshotPath?: string;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
  diagnostics: RenderDiagnostics;
}

export interface RenderOptions {
  /** Hard cap on the whole render (navigation + scroll + settle). */
  timeoutMs?: number;
  /** Number of scroll-and-wait steps used to trigger lazy loading. */
  scrollSteps?: number;
  /** When set, a full-page screenshot is saved to this path (debug mode only). */
  screenshotPath?: string;
}

type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_SCROLL_STEPS = 8;
const GALLERY_SELECTOR_TIMEOUT_MS = 4_000;
const INITIAL_NETWORK_IDLE_TIMEOUT_MS = 4_000;
const FINAL_NETWORK_IDLE_TIMEOUT_MS = 5_000;
const HYDRATION_SETTLE_MS = 800;
const SCROLL_STEP_DELAY_MS = 350;
const SCROLL_STEP_PIXELS = 1200;

// Deliberately generic (not tied to any single storefront's markup), the
// same vocabulary the static DOM extractor treats as a product gallery.
// Kept as an array (rather than one joined selector) so diagnostics can
// report exactly which pattern matched, if any.
const GALLERY_WAIT_SELECTORS = [
  '[class*="gallery" i]',
  '[class*="product-media" i]',
  '[class*="product-image" i]',
  '[id*="gallery" i]',
  '[class*="product-photo" i]',
  '[class*="carousel" i]',
  '[class*="slider" i]',
];

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
 *
 * Evidence is gathered from multiple angles rather than trusting a single
 * signal (a prior version relied on `page.content()` alone, which missed
 * storefronts whose gallery images never end up reflected as a static DOM
 * attribute at all): the serialized DOM after hydration+scrolling, a
 * direct in-page inspection of every img/source/background-image/anchor
 * and a best-effort scan of embedded <script> state, AND every image HTTP
 * response actually observed on the network while the page rendered.
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
  // environment pointing at a pre-installed browser, or a Windows machine
  // pointing SOAD_CHROMIUM_EXECUTABLE at its own install); production
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

    const networkImageUrls = new Set<string>();
    context.on("response", (response) => {
      try {
        if (!response.ok()) return;
        const contentType = response.headers()["content-type"] ?? "";
        if (contentType.toLowerCase().startsWith("image/")) {
          networkImageUrls.add(response.url());
        }
      } catch {
        // Response may already be gone (navigation, redirect); not fatal.
      }
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // A first, best-effort settle: network requests fired by inline
    // scripts on initial load (fetching product/media JSON) typically
    // finish here, before we even try scrolling.
    await page.waitForLoadState("networkidle", { timeout: INITIAL_NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
    await page.waitForTimeout(HYDRATION_SETTLE_MS);

    // A single bounded wait for ANY gallery-like selector, not one
    // sequential wait per selector (which would multiply the timeout by
    // the number of patterns on pages with no matching gallery at all).
    // Which specific pattern(s) matched is determined cheaply afterwards.
    await page
      .waitForSelector(GALLERY_WAIT_SELECTORS.join(", "), { timeout: GALLERY_SELECTOR_TIMEOUT_MS })
      .catch(() => undefined);

    // Progressive scrolling to trigger lazy-loading libraries that only
    // swap in the real image source once their element scrolls into the
    // viewport. Re-reads scroll position/height each step so it also makes
    // progress on pages that grow (infinite-scroll-style hydration).
    for (let i = 0; i < scrollSteps; i += 1) {
      const atBottom = await page
        .evaluate(() => window.scrollY + window.innerHeight >= document.body.scrollHeight - 4)
        .catch(() => true);
      if (atBottom && i > 0) break;
      await page.mouse.wheel(0, SCROLL_STEP_PIXELS);
      await page.waitForTimeout(SCROLL_STEP_DELAY_MS);
    }
    await page.waitForLoadState("networkidle", { timeout: FINAL_NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);

    // Cheap per-selector existence checks (a count query, not a wait) now
    // that the page has scrolled and settled -- used only for diagnostics,
    // to report exactly which gallery-ish pattern(s) matched.
    const gallerySelectorsMatched: string[] = [];
    for (const selector of GALLERY_WAIT_SELECTORS) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) gallerySelectorsMatched.push(selector);
    }

    const domInspection = await inspectHydratedDom(page);

    let screenshotPath: string | undefined;
    if (options.screenshotPath) {
      try {
        await page.screenshot({ path: options.screenshotPath, fullPage: true, timeout: 10_000 });
        screenshotPath = options.screenshotPath;
      } catch {
        // Best-effort only; a failed screenshot must not fail the render.
      }
    }

    const html = await page.content();
    const finalUrl = page.url();

    return {
      html,
      finalUrl,
      diagnostics: {
        gallerySelectorsMatched,
        imgCountAfterHydration: domInspection.imgCount,
        sourceCountAfterHydration: domInspection.sourceCount,
        domImageUrls: domInspection.imageUrls,
        networkImageUrls: Array.from(networkImageUrls),
        screenshotPath,
      },
    };
  } finally {
    await browser.close();
  }
}

interface DomInspection {
  imgCount: number;
  sourceCount: number;
  imageUrls: string[];
}

/**
 * Runs entirely inside the page (via `page.evaluate`) to read the DOM the
 * way a real browser sees it, not just the serialized attribute strings
 * `page.content()` returns: `img.currentSrc` (the resolved URL a
 * responsive image actually loaded, which can differ from a stale `src`
 * attribute), every lazy-load attribute convention, `<picture><source>`
 * srcset, CSS `background-image`, anchors that wrap a gallery image, and a
 * best-effort regex scan of inline `<script>` text for image URLs embedded
 * in hydration/state JSON that never gets attached to any DOM attribute.
 */
async function inspectHydratedDom(page: Page): Promise<DomInspection> {
  return page.evaluate(() => {
    const urls = new Set<string>();
    const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-zoom-image", "data-hi-res"];
    const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

    function bestFromSrcset(value: string | null): string | undefined {
      if (!value) return undefined;
      const entries = value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const match = part.match(/^(\S+)(?:\s+([\d.]+)w)?$/);
          return match ? { url: match[1] as string, width: match[2] ? parseFloat(match[2]) : 0 } : null;
        })
        .filter((e): e is { url: string; width: number } => e !== null);
      if (entries.length === 0) return undefined;
      return entries.reduce((best, cur) => (cur.width > best.width ? cur : best)).url;
    }

    document.querySelectorAll("img").forEach((img) => {
      if (img.currentSrc) urls.add(img.currentSrc);
      if (img.src) urls.add(img.src);
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) urls.add(v);
      }
      const srcsetBest = bestFromSrcset(img.getAttribute("srcset"));
      if (srcsetBest) urls.add(srcsetBest);
      for (const attr of LAZY_SRCSET_ATTRS) {
        const best = bestFromSrcset(img.getAttribute(attr));
        if (best) urls.add(best);
      }
    });

    document.querySelectorAll("picture source, source").forEach((source) => {
      const best = bestFromSrcset(source.getAttribute("srcset"));
      if (best) urls.add(best);
    });

    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(href) && a.querySelector("img")) {
        urls.add(href);
      }
    });

    document.querySelectorAll("[style*='background-image']").forEach((el) => {
      const style = el.getAttribute("style") ?? "";
      const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
      if (match?.[2]) urls.add(match[2]);
    });

    // Elements can also carry a background-image only via computed style
    // (set through CSSOM, a stylesheet rule, or a framework's inline style
    // object) rather than the raw `style` attribute string matched above.
    // Capped to bound worst-case cost on a very large DOM.
    const MAX_COMPUTED_STYLE_SCAN = 5_000;
    Array.from(document.querySelectorAll("body *"))
      .slice(0, MAX_COMPUTED_STYLE_SCAN)
      .forEach((el) => {
        const bg = window.getComputedStyle(el).backgroundImage;
        const match = bg.match(/url\((['"]?)(.*?)\1\)/i);
        if (match?.[2] && !match[2].startsWith("data:")) urls.add(match[2]);
      });

    // Best-effort scan of embedded hydration/state JSON for image-like
    // URLs that never get attached to any DOM attribute at all.
    const urlPattern = /https?:\/\/[^\s"'<>\\]+\.(?:jpe?g|png|webp|avif|gif)/gi;
    document.querySelectorAll("script").forEach((script) => {
      const text = script.textContent ?? "";
      if (text.length > 2_000_000) return; // guard against pathological bundle scripts
      const matches = text.match(urlPattern);
      if (matches) for (const m of matches) urls.add(m);
    });

    return {
      imgCount: document.images.length,
      sourceCount: document.querySelectorAll("source").length,
      imageUrls: Array.from(urls),
    };
  });
}

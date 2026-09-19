import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAssets, hasCredibleProductImages, NO_PRODUCT_IMAGES_WARNING } from "../src/lib/extract/index.js";
import { extractAssetsWithFallback, extractAssetsWithFallbackDiagnostics } from "../src/lib/extract/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

/**
 * Regression coverage for a real production bug: a Heaven Moon (Saudi
 * perfume storefront) product page's downloaded ZIP contained only the
 * brand logo (twice, under two URLs) and none of the actual perfume bottle
 * photos. Root cause: the theme's og:image and JSON-LD Product.image both
 * defaulted to brand artwork instead of a real product photo, and the
 * actual gallery was populated entirely by client-side JavaScript, so it
 * never appeared in the static HTML at all.
 */
describe("Heaven Moon failure case", () => {
  const baseUrl = "https://heaven-moon.example.com/products/perfume-8842";

  it("static extraction alone finds no credible product image (both candidates are logo artwork)", () => {
    const html = loadFixture("heaven-moon-style.html");
    const result = extractAssets(html, baseUrl);

    expect(result.images).toHaveLength(0);
    expect(result.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
    expect(hasCredibleProductImages(result)).toBe(false);
    // The logo itself must still be found -- it just must not be reported
    // as a product image.
    expect(result.logo?.url).toBe("https://cdn.heaven-moon.example.com/branding/logo.jpg");
  });

  it("the rendered-DOM fallback recovers the real product photos once static extraction is not credible", async () => {
    const staticHtml = loadFixture("heaven-moon-style.html");
    const renderedHtml = loadFixture("heaven-moon-rendered.html");

    const result = await extractAssetsWithFallback(staticHtml, baseUrl, {
      renderDynamic: async () => ({ html: renderedHtml, finalUrl: baseUrl }),
    });

    const urls = result.images.map((i) => i.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.heaven-moon.example.com/products/8842/bottle-front.jpg",
        "https://cdn.heaven-moon.example.com/products/8842/bottle-box.jpg",
        "https://cdn.heaven-moon.example.com/products/8842/bottle-side.jpg",
      ]),
    );
    expect(result.images).toHaveLength(3);
    // The logo must never appear alongside the product photos.
    expect(urls.some((u) => u.includes("logo"))).toBe(false);
    expect(result.logo?.url).toBe("https://cdn.heaven-moon.example.com/branding/logo.jpg");
  });

  it("does not launch the fallback at all when static extraction already succeeded", async () => {
    const html = loadFixture("salla-style.html");
    let renderCalled = false;

    const result = await extractAssetsWithFallback(html, "https://perfume-store.salla.sa/products/luxury-perfume", {
      renderDynamic: async () => {
        renderCalled = true;
        return { html: "<html></html>", finalUrl: "https://perfume-store.salla.sa/products/luxury-perfume" };
      },
    });

    expect(renderCalled).toBe(false);
    expect(result.images.length).toBeGreaterThan(0);
  });

  it("falls back to reporting NO_PRODUCT_IMAGES_WARNING, never the logo, when rendering also finds nothing credible", async () => {
    const staticHtml = loadFixture("heaven-moon-style.html");

    const result = await extractAssetsWithFallback(staticHtml, baseUrl, {
      // Simulates a render that still doesn't surface a real gallery (e.g.
      // the product genuinely has no photos, or rendering timed out).
      renderDynamic: async () => ({ html: staticHtml, finalUrl: baseUrl }),
    });

    expect(result.images).toHaveLength(0);
    expect(result.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
  });

  it("falls back to the static result (rather than throwing) when the render itself fails", async () => {
    const staticHtml = loadFixture("heaven-moon-style.html");

    const result = await extractAssetsWithFallback(staticHtml, baseUrl, {
      renderDynamic: async () => {
        throw new Error("render timed out");
      },
    });

    expect(result.images).toHaveLength(0);
    expect(result.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
  });

  it("the diagnostics-producing pipeline explains exactly why static extraction failed and confirms the render was triggered and succeeded", async () => {
    const staticHtml = loadFixture("heaven-moon-style.html");
    const renderedHtml = loadFixture("heaven-moon-rendered.html");

    const { result, diagnostics, renderedHtml: capturedRenderedHtml } = await extractAssetsWithFallbackDiagnostics(
      "https://heaven-moon.com/products/perfume-8842",
      staticHtml,
      baseUrl,
      { renderDynamic: async () => ({ html: renderedHtml, finalUrl: baseUrl }) },
    );

    // Static pass: both candidates rejected as logo artwork, tier "none".
    expect(diagnostics.staticPass.tierUsed).toBe("none");
    expect(diagnostics.staticPass.hasCredibleProductImages).toBe(false);
    expect(diagnostics.staticPass.logoUrl).toBe("https://cdn.heaven-moon.example.com/branding/logo.jpg");
    expect(diagnostics.staticPass.candidates.every((c) => !c.accepted)).toBe(true);
    expect(diagnostics.staticPass.candidates.some((c) => c.rejectionReasons.includes("logo-artwork-filename"))).toBe(
      true,
    );

    // Render pass: triggered, ran, and this time found real product photos.
    expect(diagnostics.renderPass.attempted).toBe(true);
    expect(diagnostics.renderPass.triggered).toBe(true);
    expect(diagnostics.renderPass.error).toBeUndefined();
    expect(diagnostics.renderPass.hasCredibleProductImages).toBe(true);
    expect(diagnostics.renderPass.tierUsed).toBe("structured+gallery");

    expect(capturedRenderedHtml).toBe(renderedHtml);
    expect(diagnostics.finalImageUrls).toHaveLength(3);
    expect(result.images).toHaveLength(3);
  });

  it("the diagnostics pipeline reports the render error message when rendering throws", async () => {
    const staticHtml = loadFixture("heaven-moon-style.html");

    const { diagnostics, renderedHtml } = await extractAssetsWithFallbackDiagnostics(
      "https://heaven-moon.com/products/perfume-8842",
      staticHtml,
      baseUrl,
      {
        renderDynamic: async () => {
          throw new Error("Chromium executable not found");
        },
      },
    );

    expect(diagnostics.renderPass.triggered).toBe(true);
    expect(diagnostics.renderPass.error).toBe("Chromium executable not found");
    expect(renderedHtml).toBeNull();
    expect(diagnostics.finalImageUrls).toHaveLength(0);
    expect(diagnostics.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
  });
});

describe("Lazy-loaded gallery requiring the render fallback (generic, non-Heaven-Moon site)", () => {
  it("static extraction finds nothing in an empty hydration placeholder", () => {
    const html = loadFixture("lazy-gallery-empty.html");
    const result = extractAssets(html, "https://furnitureco.example.com/products/oak-table");
    expect(result.images).toHaveLength(0);
    expect(hasCredibleProductImages(result)).toBe(false);
  });

  it("the fallback recovers images once the DOM has hydrated and lazy attributes resolved", async () => {
    const staticHtml = loadFixture("lazy-gallery-empty.html");
    const renderedHtml = loadFixture("lazy-gallery-rendered.html");
    const baseUrl = "https://furnitureco.example.com/products/oak-table";

    const result = await extractAssetsWithFallback(staticHtml, baseUrl, {
      renderDynamic: async () => ({ html: renderedHtml, finalUrl: baseUrl }),
    });

    const urls = result.images.map((i) => i.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.furnitureco.example.com/products/oak-table/full-1.jpg",
        "https://cdn.furnitureco.example.com/products/oak-table/full-2.jpg",
      ]),
    );
  });
});

describe("Original-quality selection", () => {
  it("prefers the anchor-linked/srcset original over a 200px thumbnail", () => {
    const html = loadFixture("thumbnail-vs-original.html");
    const result = extractAssets(html, "https://scarfshop.example.com/products/silk-scarf");

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.url).toBe("https://cdn.scarfshop.example.com/products/scarf_2400x2400.jpg");
    expect(result.images[0]!.width).toBe(2400);
  });

  it("collapses duplicate CDN width-transform query params into one result but keeps a genuinely different angle", () => {
    const html = loadFixture("duplicate-cdn-transforms.html");
    const result = extractAssets(html, "https://kitchenshop.example.com/products/espresso-machine");

    expect(result.images).toHaveLength(2);
    const main = result.images.find((i) => i.url.startsWith("https://cdn.kitchenshop.example.com/products/espresso-machine.jpg"));
    expect(main?.width).toBe(2000);
    expect(result.images.some((i) => i.url.includes("espresso-machine-back"))).toBe(true);
  });
});

describe("Logo appearing before product images in DOM order", () => {
  it("still separates the logo from the product gallery correctly", () => {
    // salla-style.html renders <header> (logo) before <main> (gallery) --
    // the common case -- and must not let document order affect the split.
    const html = loadFixture("salla-style.html");
    const result = extractAssets(html, "https://perfume-store.salla.sa/products/luxury-perfume");

    expect(result.logo?.url).toBe("https://cdn.salla.sa/stores/perfume-store/branding/logo.png");
    expect(result.images.some((i) => i.url.includes("branding/logo"))).toBe(false);
    expect(result.images).toHaveLength(2);
  });
});

describe("Page where no product image exists anywhere", () => {
  it("reports NO_PRODUCT_IMAGES_WARNING and never substitutes the logo or chrome images", () => {
    const html = loadFixture("no-product-image.html");
    const result = extractAssets(html, "https://emptyshop.example.com/products/discontinued");

    expect(result.images).toHaveLength(0);
    expect(result.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
    expect(result.logo?.url).toBe("https://cdn.emptyshop.example.com/branding/logo.png");
  });
});

describe("Logo/product collision without a 'logo' keyword in the filename", () => {
  it("still excludes a product-image candidate that is byte-identical to the detected logo asset", () => {
    // The brand asset is named "brand-mark" (no "logo" substring at all) and
    // its alt text is just the store name, ruling out the filename/alt
    // "logo" keyword check for the PRODUCT-image candidate (og:image below).
    // The header image is only identified as the logo via its wrapper's
    // ".brand-logo" class -- so the only thing that can stop the identical
    // asset from also being reported as a product photo is the
    // canonical-URL cross-check against the separately-detected logo.
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://cdn.example.com/assets/brand-mark_100x100.png" />
        </head>
        <body>
          <div class="brand-logo">
            <img src="https://cdn.example.com/assets/brand-mark_400x400.png" alt="Acme" />
          </div>
        </body>
      </html>`;
    const result = extractAssets(html, "https://shop.example.com/products/widget");

    expect(result.logo?.url).toBe("https://cdn.example.com/assets/brand-mark_400x400.png");
    expect(result.images).toHaveLength(0);
    expect(result.warnings).toContain(NO_PRODUCT_IMAGES_WARNING);
  });
});

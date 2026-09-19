import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAssets } from "../src/lib/extract/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

/**
 * Regression coverage for a real-world extraction-quality bug: an Apple
 * product page returned ~60 images, most of them unrelated (other
 * products, accessories, promotional/editorial imagery, tiny icons
 * mislabeled "2px wide"). Root causes and fixes:
 *
 *  1. Every source (JSON-LD/OpenGraph/platform data/generic DOM scan) was
 *     flatly merged into one result set with no confidence tiering, so an
 *     unscoped full-page DOM scan could pollute an otherwise-correct
 *     structured-data result. Fixed by only falling back to the unscoped
 *     generic DOM scan when structured/gallery-scoped sources produce
 *     nothing at all (src/lib/extract/index.ts).
 *  2. `imageUrl.ts`'s CDN resize-suffix regex matched the unrelated
 *     `_2x`/`@2x` pixel-density (retina) naming convention and misread the
 *     density multiplier as an absolute pixel width, mislabeling ordinary
 *     assets as e.g. "2px wide".
 */

describe("Confidence tiering: structured data suppresses generic DOM pollution", () => {
  const html = loadFixture("apple-style.html");
  const result = extractAssets(html, "https://techstore.example.com/products/megaphone-pro");

  it("returns only the two JSON-LD product images", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.techstore.example.com/megaphone-pro/hero.jpg",
        "https://cdn.techstore.example.com/megaphone-pro/back.jpg",
      ]),
    );
    expect(result.images).toHaveLength(2);
  });

  it("excludes unrelated other-product photos even outside any nav/related/carousel keyword match", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("megabook-air"))).toBe(false);
    expect(urls.some((u) => u.includes("megapods-pro"))).toBe(false);
    expect(urls.some((u) => u.includes("person-holding-phone"))).toBe(false);
  });

  it("excludes recommendation/comparison-carousel and footer/social imagery", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("megawatch"))).toBe(false);
    expect(urls.some((u) => u.includes("megatab"))).toBe(false);
    expect(urls.some((u) => u.includes("megaphone-standard"))).toBe(false);
    expect(urls.some((u) => u.includes("megaphone-mini"))).toBe(false);
    expect(urls.some((u) => u.includes("app-store-badge"))).toBe(false);
    expect(urls.some((u) => u.includes("play-store-badge"))).toBe(false);
  });

  it("still finds the header logo, separately from productImages", () => {
    expect(result.logo?.url).toBe("https://cdn.techstore.example.com/branding/techstore-logo.svg");
    expect(result.images.some((i) => i.url.includes("techstore-logo"))).toBe(false);
  });
});

describe("Gallery-scoped DOM images are trusted even without structured data", () => {
  const html = loadFixture("gallery-only.html");
  const result = extractAssets(html, "https://potteryhouse.example.com/products/vase");

  it("keeps all legitimate gallery images", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.potteryhouse.example.com/vase/angle-1.jpg",
        "https://cdn.potteryhouse.example.com/vase/angle-2.jpg",
        "https://cdn.potteryhouse.example.com/vase/angle-3.jpg",
      ]),
    );
    expect(result.images).toHaveLength(3);
  });

  it("excludes unrelated images from an ambiguously-named section once the gallery is trusted", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("/other/bowl"))).toBe(false);
    expect(urls.some((u) => u.includes("/other/plate"))).toBe(false);
  });
});

describe("Generic DOM fallback still works when there is no structured data or gallery", () => {
  const html = loadFixture("generic-fallback.html");
  const result = extractAssets(html, "https://leathercraft.example.com/products/belt");

  it("finds the plain product photo", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://cdn.leathercraft.example.com/belt-main.jpg");
  });

  it("does not mislabel a retina-named (_2x) photo with a bogus tiny width", () => {
    const detail = result.images.find((i) => i.url.includes("belt-buckle-detail_2x"));
    expect(detail).toBeDefined();
    expect(detail?.width).toBeUndefined();
  });

  it("rejects a genuinely tiny icon with real small dimensions", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("swatch-icon"))).toBe(false);
  });

  it("excludes the header/nav icon", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("menu_2x"))).toBe(false);
  });
});

describe("Salla-style page keeps returning exactly its two structured product images", () => {
  const html = loadFixture("salla-style.html");
  const result = extractAssets(html, "https://perfume-store.salla.sa/products/luxury-perfume");

  it("returns exactly the two JSON-LD product images", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://cdn.salla.sa/stores/perfume-store/products/perfume-front.jpg",
        "https://cdn.salla.sa/stores/perfume-store/products/perfume-box.jpg",
      ]),
    );
    expect(result.images).toHaveLength(2);
  });

  it("excludes the also-bought carousel and footer badge", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("other-perfume"))).toBe(false);
    expect(urls.some((u) => u.includes("app-store-badge"))).toBe(false);
  });

  it("still detects the store logo", () => {
    expect(result.logo?.url).toBe("https://cdn.salla.sa/stores/perfume-store/branding/logo.png");
  });
});

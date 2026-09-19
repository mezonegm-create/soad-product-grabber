import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAssets } from "../src/lib/extract/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("Shopify-style fixture", () => {
  const html = loadFixture("shopify.html");
  const result = extractAssets(html, "https://acmefootwear.com/products/classic-canvas-sneaker");

  it("extracts the highest-resolution variant of each gallery photo", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://cdn.shopify.com/s/files/1/0001/products/sneaker-front_2000x2000.jpg");
    expect(urls).not.toContain("https://cdn.shopify.com/s/files/1/0001/products/sneaker-front_300x300.jpg");
    expect(urls).not.toContain("https://cdn.shopify.com/s/files/1/0001/products/sneaker-front_800x800.jpg");
  });

  it("includes images only referenced via the embedded ProductJson blob", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://cdn.shopify.com/s/files/1/0001/products/sneaker-back_2000x2000.jpg");
  });

  it("excludes unrelated recommended-product and chrome images", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("other-product"))).toBe(false);
    expect(urls.some((u) => u.includes("cart-icon"))).toBe(false);
  });

  it("detects the header logo, not the cart icon", () => {
    expect(result.logo?.url).toBe("https://cdn.acmefootwear.com/assets/acme-logo.svg");
  });
});

describe("WooCommerce-style fixture", () => {
  const html = loadFixture("woocommerce.html");
  const result = extractAssets(html, "https://shop.example.com/product/ceramic-mug");

  it("prefers data-large_image / gallery link over the cropped thumbnail src", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://shop.example.com/wp-content/uploads/2023/mug-full.jpg");
    expect(urls).toContain("https://shop.example.com/wp-content/uploads/2023/mug-handle.jpg");
    expect(urls.some((u) => u.includes("-300x300"))).toBe(false);
  });

  it("excludes the related-products thumbnail", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls.some((u) => u.includes("other-item"))).toBe(false);
  });

  it("detects the WordPress custom logo", () => {
    expect(result.logo?.url).toBe("https://shop.example.com/wp-content/uploads/2023/logo-pottery-barnhouse.png");
  });
});

describe("JSON-LD only fixture", () => {
  const html = loadFixture("jsonld-only.html");
  const result = extractAssets(html, "https://nordichome.example.com/products/wool-throw");

  it("extracts images purely from schema.org Product JSON-LD", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://assets.example.com/products/blanket-main.jpg");
    expect(urls).toContain("https://assets.example.com/products/blanket-folded.jpg");
  });

  it("extracts the logo from the Organization node", () => {
    expect(result.logo?.url).toBe("https://assets.example.com/branding/nordic-home-logo.png");
  });
});

describe("OpenGraph fallback fixture", () => {
  const html = loadFixture("opengraph-only.html");
  const result = extractAssets(html, "https://legacyshop.example.net/wallet");

  it("falls back to og:image when no structured product data exists", () => {
    const urls = result.images.map((i) => i.url);
    expect(urls).toContain("https://images.example.net/wallet-hero.jpg");
    expect(urls).toContain("https://images.example.net/wallet-hero-alt.jpg");
  });

  it("reports no logo found without failing image extraction", () => {
    expect(result.logo).toBeNull();
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.warnings).toContain("No brand logo was found on this page.");
  });
});

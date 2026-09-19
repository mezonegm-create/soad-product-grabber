import { describe, it, expect } from "vitest";
import { isLikelyDecorativeOrTracking, isTooSmallForProductImage, looksLikeLogoHint } from "../src/lib/extract/filters.js";

describe("isLikelyDecorativeOrTracking", () => {
  it("flags known UI/tracking asset filenames", () => {
    expect(isLikelyDecorativeOrTracking("https://a.com/icons/visa-payment.png")).toBe(true);
    expect(isLikelyDecorativeOrTracking("https://a.com/img/sprite.png")).toBe(true);
    expect(isLikelyDecorativeOrTracking("https://a.com/badges/trustpilot-stars.svg")).toBe(true);
    expect(isLikelyDecorativeOrTracking("https://a.com/favicon.ico")).toBe(true);
  });

  it("flags known tracking pixel hosts", () => {
    expect(isLikelyDecorativeOrTracking("https://www.google-analytics.com/collect")).toBe(true);
  });

  it("does not flag genuine product photo URLs", () => {
    expect(isLikelyDecorativeOrTracking("https://cdn.shopify.com/files/product-front.jpg")).toBe(false);
  });
});

describe("isTooSmallForProductImage", () => {
  it("flags very small dimensions", () => {
    expect(isTooSmallForProductImage(40, 40)).toBe(true);
    expect(isTooSmallForProductImage(1, 1)).toBe(true);
  });

  it("does not flag reasonably sized or unknown dimensions", () => {
    expect(isTooSmallForProductImage(800, 800)).toBe(false);
    expect(isTooSmallForProductImage(undefined, undefined)).toBe(false);
  });
});

describe("looksLikeLogoHint", () => {
  it("matches text containing 'logo'", () => {
    expect(looksLikeLogoHint("site-logo header-brand")).toBe(true);
    expect(looksLikeLogoHint("Acme Footwear Logo")).toBe(true);
  });

  it("excludes payment/badge logos", () => {
    expect(looksLikeLogoHint("visa-payment-logo")).toBe(false);
    expect(looksLikeLogoHint("trustpilot-badge-logo")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(looksLikeLogoHint("product-gallery-image")).toBe(false);
  });
});

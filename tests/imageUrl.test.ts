import { describe, it, expect } from "vitest";
import { canonicalizeImageKey, upgradeToOriginalUrl, dimensionHintFromUrl, guessFormatFromUrl } from "../src/lib/imageUrl.js";

describe("dimensionHintFromUrl", () => {
  it("reads Shopify-style _WIDTHxHEIGHT suffixes", () => {
    expect(dimensionHintFromUrl("https://cdn.shopify.com/files/shoe_800x800.jpg")).toEqual({ width: 800, height: 800 });
  });

  it("reads WordPress-style -WIDTHxHEIGHT suffixes", () => {
    expect(dimensionHintFromUrl("https://shop.example.com/uploads/mug-300x300.jpg")).toEqual({ width: 300, height: 300 });
  });

  it("reads a width query parameter", () => {
    expect(dimensionHintFromUrl("https://images.example.com/a.jpg?width=1200")).toEqual({ width: 1200 });
  });

  it("returns an empty hint when nothing is present", () => {
    expect(dimensionHintFromUrl("https://images.example.com/a.jpg")).toEqual({});
  });
});

describe("upgradeToOriginalUrl", () => {
  it("strips a Shopify resize suffix", () => {
    expect(upgradeToOriginalUrl("https://cdn.shopify.com/files/shoe_800x800.jpg")).toBe(
      "https://cdn.shopify.com/files/shoe.jpg",
    );
  });

  it("strips a WordPress resize suffix", () => {
    expect(upgradeToOriginalUrl("https://shop.example.com/uploads/mug-300x300.jpg")).toBe(
      "https://shop.example.com/uploads/mug.jpg",
    );
  });

  it("removes sizing query parameters", () => {
    expect(upgradeToOriginalUrl("https://images.example.com/a.jpg?width=300&quality=80")).toBe(
      "https://images.example.com/a.jpg",
    );
  });

  it("leaves URLs with no known resize pattern unchanged", () => {
    expect(upgradeToOriginalUrl("https://images.example.com/original-photo.jpg")).toBe(
      "https://images.example.com/original-photo.jpg",
    );
  });
});

describe("canonicalizeImageKey", () => {
  it("treats different resolutions of the same Shopify image as one key", () => {
    const a = canonicalizeImageKey("https://cdn.shopify.com/files/shoe_300x300.jpg");
    const b = canonicalizeImageKey("https://cdn.shopify.com/files/shoe_2000x2000.jpg");
    expect(a).toBe(b);
  });

  it("treats different filenames as different keys", () => {
    const a = canonicalizeImageKey("https://cdn.shopify.com/files/shoe-front.jpg");
    const b = canonicalizeImageKey("https://cdn.shopify.com/files/shoe-back.jpg");
    expect(a).not.toBe(b);
  });
});

describe("guessFormatFromUrl", () => {
  it("reads the file extension", () => {
    expect(guessFormatFromUrl("https://a.com/img.WEBP")).toBe("webp");
    expect(guessFormatFromUrl("https://a.com/img.jpg?x=1")).toBe("jpg");
  });

  it("returns undefined when there is no extension", () => {
    expect(guessFormatFromUrl("https://a.com/img")).toBeUndefined();
  });
});

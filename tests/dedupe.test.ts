import { describe, it, expect } from "vitest";
import { dedupeCandidates } from "../src/lib/dedupe.js";
import type { ImageCandidate } from "../src/lib/types.js";

describe("dedupeCandidates", () => {
  it("keeps only the highest resolution among same-image variants", () => {
    const candidates: ImageCandidate[] = [
      { url: "https://cdn.shopify.com/files/shoe_300x300.jpg", source: "img", score: 50 },
      { url: "https://cdn.shopify.com/files/shoe_800x800.jpg", source: "img-srcset", score: 55 },
      { url: "https://cdn.shopify.com/files/shoe_2000x2000.jpg", source: "img-srcset", score: 55 },
    ];
    const result = dedupeCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.url).toBe("https://cdn.shopify.com/files/shoe_2000x2000.jpg");
  });

  it("keeps genuinely different product angles as separate entries", () => {
    const candidates: ImageCandidate[] = [
      { url: "https://cdn.shopify.com/files/shoe-front_2000x2000.jpg", source: "img", score: 50 },
      { url: "https://cdn.shopify.com/files/shoe-back_2000x2000.jpg", source: "img", score: 50 },
    ];
    const result = dedupeCandidates(candidates);
    expect(result).toHaveLength(2);
  });

  it("uses width/height fields when provided instead of URL hints", () => {
    const candidates: ImageCandidate[] = [
      { url: "https://shop.example.com/uploads/mug-300x300.jpg", width: 300, height: 300, source: "a", score: 10 },
      { url: "https://shop.example.com/uploads/mug-300x300.jpg?v=2", width: 1600, height: 1600, source: "b", score: 10 },
    ];
    const result = dedupeCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.width).toBe(1600);
  });

  it("breaks ties on score when resolution is equal/unknown", () => {
    const candidates: ImageCandidate[] = [
      { url: "https://example.com/a.jpg", source: "og", score: 60 },
      { url: "https://example.com/a.jpg", source: "jsonld", score: 90 },
    ];
    const result = dedupeCandidates(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(90);
  });
});

import { describe, it, expect } from "vitest";
import { parseSrcset, highestResolutionFromSrcset } from "../src/lib/srcset.js";

describe("parseSrcset", () => {
  it("parses width descriptors", () => {
    const entries = parseSrcset(
      "https://cdn.example.com/a_300.jpg 300w, https://cdn.example.com/a_800.jpg 800w, https://cdn.example.com/a_2000.jpg 2000w",
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ url: "https://cdn.example.com/a_300.jpg", width: 300 });
    expect(entries[2]).toMatchObject({ url: "https://cdn.example.com/a_2000.jpg", width: 2000 });
  });

  it("parses density descriptors", () => {
    const entries = parseSrcset("a.jpg 1x, a@2x.jpg 2x, a@3x.jpg 3x");
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({ url: "a@3x.jpg", density: 3 });
  });

  it("parses a bare URL with no descriptor", () => {
    const entries = parseSrcset("a.jpg");
    expect(entries).toEqual([{ url: "a.jpg" }]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseSrcset("")).toEqual([]);
  });
});

describe("highestResolutionFromSrcset", () => {
  it("selects the largest width descriptor", () => {
    const entries = parseSrcset("a_300.jpg 300w, a_2000.jpg 2000w, a_800.jpg 800w");
    const best = highestResolutionFromSrcset(entries);
    expect(best?.url).toBe("a_2000.jpg");
  });

  it("falls back to density when no width descriptors exist", () => {
    const entries = parseSrcset("a.jpg 1x, a@2x.jpg 2x");
    const best = highestResolutionFromSrcset(entries);
    expect(best?.url).toBe("a@2x.jpg");
  });

  it("returns undefined for an empty list", () => {
    expect(highestResolutionFromSrcset([])).toBeUndefined();
  });
});

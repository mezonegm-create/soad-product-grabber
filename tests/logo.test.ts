import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { extractLogoCandidates } from "../src/lib/extract/logo.js";

describe("extractLogoCandidates", () => {
  it("captures an inline SVG header logo as serialized markup", () => {
    const html = `
      <header class="site-header">
        <svg class="site-logo" viewBox="0 0 10 10"><path d="M0 0h10v10H0z" /></svg>
      </header>`;
    const $ = cheerio.load(html);
    const candidates = extractLogoCandidates($);
    const svgCandidate = candidates.find((c) => c.isSvgMarkup);
    expect(svgCandidate).toBeDefined();
    expect(svgCandidate?.svgMarkup).toContain("<svg");
  });

  it("does not treat a payment icon in the header as the brand logo", () => {
    const html = `
      <header class="site-header">
        <img class="payment-logo" src="/visa-logo.png" alt="Visa payment logo" />
      </header>`;
    const $ = cheerio.load(html);
    const candidates = extractLogoCandidates($);
    expect(candidates.some((c) => c.url.includes("visa-logo"))).toBe(false);
  });

  it("finds a class-based logo link outside of a <header> tag", () => {
    const html = `<div class="site-logo"><img src="/brand.png" alt="Brand" /></div>`;
    const $ = cheerio.load(html);
    const candidates = extractLogoCandidates($);
    expect(candidates.some((c) => c.url === "/brand.png")).toBe(true);
  });
});

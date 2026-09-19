import type { CheerioAPI } from "cheerio";
import type { ImageCandidate } from "../types.js";

/**
 * Extracts OpenGraph product images. Used as a fallback signal when
 * structured JSON-LD data and DOM gallery heuristics come up short.
 */
export function extractFromOpenGraph($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  $('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').each(
    (_i, el) => {
      const url = $(el).attr("content");
      if (url) candidates.push({ url, source: "opengraph", score: 60 });
    },
  );

  return candidates;
}

export function extractLogoFromOpenGraph($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const url = $('meta[property="og:logo"]').attr("content");
  if (url) candidates.push({ url, source: "opengraph-logo", score: 70 });
  return candidates;
}

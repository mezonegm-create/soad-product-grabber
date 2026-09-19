import type { CheerioAPI } from "cheerio";
import type { ImageCandidate } from "../types.js";
import { extractLogoFromJsonLd } from "./jsonld.js";
import { extractLogoFromOpenGraph } from "./opengraph.js";
import { looksLikeLogoHint } from "./filters.js";

export interface LogoCandidate extends ImageCandidate {
  isSvgMarkup?: boolean;
  svgMarkup?: string;
}

const HEADER_SCOPES = ["header", ".header", "#header", ".site-header", ".site-branding", "nav", ".navbar", ".masthead"];

function scoped(suffix: string): string {
  return HEADER_SCOPES.map((scope) => `${scope} ${suffix}`).join(", ");
}

/**
 * Finds the brand/site logo. Structured metadata (JSON-LD Organization.logo,
 * og:logo) is preferred since it is explicitly curated by the site; DOM
 * heuristics (header <img>/<svg> with a "logo" hint) are the fallback.
 * Inline <svg> logos are captured as serialized markup so they can be
 * offered for download without a network round-trip.
 */
export function extractLogoCandidates($: CheerioAPI): LogoCandidate[] {
  const candidates: LogoCandidate[] = [...extractLogoFromJsonLd($), ...extractLogoFromOpenGraph($)];

  $(scoped("img")).each((_i, el) => {
    const $img = $(el);
    const hint = `${$img.attr("class") ?? ""} ${$img.attr("id") ?? ""} ${$img.attr("alt") ?? ""} ${$img.attr("src") ?? ""}`;
    if (!looksLikeLogoHint(hint)) return;
    const url = $img.attr("src") || $img.attr("data-src");
    if (!url || url.startsWith("data:")) return;
    candidates.push({ url, source: "dom-logo-img", score: 65 });
  });

  $(scoped("svg")).each((_i, el) => {
    const $svg = $(el);
    const hint = `${$svg.attr("class") ?? ""} ${$svg.attr("id") ?? ""} ${$svg.attr("aria-label") ?? ""}`;
    if (!looksLikeLogoHint(hint)) return;
    const markup = $.html(el);
    candidates.push({
      url: `inline-svg:${$svg.attr("id") ?? $svg.attr("class") ?? "logo"}`,
      source: "dom-logo-svg",
      score: 80,
      isSvgMarkup: true,
      svgMarkup: markup,
    });
  });

  // Common "logo" link wrapping an <img> even outside a <header> tag.
  $("a.logo img, a#logo img, .logo img, .brand-logo img, .site-logo img").each((_i, el) => {
    const $img = $(el);
    const url = $img.attr("src") || $img.attr("data-src");
    if (!url || url.startsWith("data:")) return;
    candidates.push({ url, source: "dom-logo-class", score: 68 });
  });

  return candidates;
}

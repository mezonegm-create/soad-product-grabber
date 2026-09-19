import * as cheerio from "cheerio";
import type { ImageCandidate, ExtractedAsset, ExtractResult } from "../types.js";
import { extractFromJsonLd } from "./jsonld.js";
import { extractFromOpenGraph } from "./opengraph.js";
import { extractFromShopifyProductJson } from "./shopify.js";
import { extractFromWooCommerce } from "./woocommerce.js";
import { extractFromDom } from "./domImages.js";
import { extractLogoCandidates, type LogoCandidate } from "./logo.js";
import { isLikelyDecorativeOrTracking, isTooSmallForProductImage } from "./filters.js";
import { dedupeCandidates } from "../dedupe.js";
import { dimensionHintFromUrl, guessFormatFromUrl } from "../imageUrl.js";

const MAX_IMAGES = 60;

/**
 * Resolves a candidate URL (which may be relative, protocol-relative, or
 * already absolute) against the page's URL, and fills in width/height from
 * a CDN filename/query-string hint whenever the DOM didn't already supply
 * one. Filling the hint in HERE (rather than later, only when building the
 * final display asset) matters: it means every size-based filter downstream
 * -- including the tiny-image rejection -- sees the same effective
 * dimensions that will ultimately be reported, so a bogus or genuinely tiny
 * hint can't slip past the filter by arriving after it ran.
 *
 * Deliberately does NOT rewrite the URL by stripping CDN resize suffixes:
 * doing so would fabricate a "presumed original" URL that was never
 * actually observed on the page and that may not even resolve. Instead,
 * every resolution variant actually seen (via srcset, embedded JSON,
 * data-large_image, etc.) is kept as its own candidate and
 * `dedupeCandidates` picks the largest one that is confirmed to exist.
 */
function resolveAndNormalize(candidate: ImageCandidate, baseUrl: string): ImageCandidate | null {
  let absolute: string;
  try {
    absolute = new URL(candidate.url, baseUrl).toString();
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(absolute)) return null;

  if (candidate.width !== undefined && candidate.height !== undefined) {
    return { ...candidate, url: absolute };
  }
  const hint = dimensionHintFromUrl(absolute);
  return {
    ...candidate,
    url: absolute,
    width: candidate.width ?? hint.width,
    height: candidate.height ?? hint.height,
  };
}

function toExtractedAsset(candidate: ImageCandidate): ExtractedAsset {
  return {
    url: candidate.url,
    width: candidate.width,
    height: candidate.height,
    format: guessFormatFromUrl(candidate.url),
  };
}

function filterCandidates(candidates: ImageCandidate[], baseUrl: string): ImageCandidate[] {
  return candidates
    .map((c) => resolveAndNormalize(c, baseUrl))
    .filter((c): c is ImageCandidate => c !== null)
    .filter((c) => !isLikelyDecorativeOrTracking(c.url))
    .filter((c) => !isTooSmallForProductImage(c.width, c.height));
}

function pickBestLogo(candidates: LogoCandidate[], baseUrl: string): ExtractedAsset | null {
  if (candidates.length === 0) return null;

  const svgCandidate = candidates.find((c) => c.isSvgMarkup && c.svgMarkup);
  if (svgCandidate?.svgMarkup) {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgCandidate.svgMarkup, "utf-8").toString("base64")}`;
    return { url: dataUrl, format: "svg" };
  }

  const resolved = candidates
    .map((c) => resolveAndNormalize(c, baseUrl))
    .filter((c): c is ImageCandidate => c !== null)
    .filter((c) => !isLikelyDecorativeOrTracking(c.url));

  if (resolved.length === 0) return null;

  const deduped = dedupeCandidates(resolved);
  const best = deduped.reduce((a, b) => (b.score > a.score ? b : a));
  return toExtractedAsset(best);
}

/**
 * Runs the full static extraction pipeline against already-fetched HTML.
 *
 * Product-image sources are combined with a confidence-tiered policy, not a
 * flat merge: structured, explicitly product-scoped data (JSON-LD, Shopify
 * embedded product JSON, WooCommerce gallery data, OpenGraph) and DOM
 * candidates found inside a recognized product-gallery container are far
 * more likely to actually belong to the submitted product than an
 * unscoped scan of every <img> on the page. When those higher-confidence
 * sources produce a usable result, the unscoped generic DOM scan is
 * dropped entirely rather than merged in -- otherwise a content-heavy page
 * (marketing sites with dozens of unrelated/related-product/promotional
 * images) pollutes a perfectly good result with unrelated site imagery.
 * The unscoped generic scan is only used as a last-resort fallback, for
 * pages that expose no structured product data and no recognizable
 * gallery container at all.
 */
export function extractAssets(html: string, baseUrl: string): ExtractResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const structuredRaw: ImageCandidate[] = [
    ...extractFromJsonLd($),
    ...extractFromOpenGraph($),
    ...extractFromShopifyProductJson($),
    ...extractFromWooCommerce($),
  ];
  const domRaw = extractFromDom($);

  const structuredAndGallery = filterCandidates(
    [...structuredRaw, ...domRaw.filter((c) => c.confidence !== "generic")],
    baseUrl,
  );
  const generic = filterCandidates(
    domRaw.filter((c) => c.confidence === "generic"),
    baseUrl,
  );

  // Prefer the high-confidence set whenever it produced anything at all;
  // only fall back to the unscoped generic scan when it is truly empty.
  const chosen = structuredAndGallery.length > 0 ? structuredAndGallery : generic;

  const deduped = dedupeCandidates(chosen)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_IMAGES);

  const images = deduped.map(toExtractedAsset);
  if (images.length === 0) {
    warnings.push("No product images were found on this page.");
  }

  const logoCandidates = extractLogoCandidates($);
  const logo = pickBestLogo(logoCandidates, baseUrl);
  if (!logo) {
    warnings.push("No brand logo was found on this page.");
  }

  return {
    sourceUrl: baseUrl,
    images,
    logo,
    warnings,
  };
}

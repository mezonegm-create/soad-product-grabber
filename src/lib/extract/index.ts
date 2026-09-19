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
 * already absolute) against the page's URL. Deliberately does NOT rewrite
 * the URL by stripping CDN resize suffixes: doing so would fabricate a
 * "presumed original" URL that was never actually observed on the page and
 * that may not even resolve. Instead, every resolution variant actually
 * seen (via srcset, embedded JSON, data-large_image, etc.) is kept as its
 * own candidate and `dedupeCandidates` picks the largest one that is
 * confirmed to exist.
 */
function resolveAndNormalize(candidate: ImageCandidate, baseUrl: string): ImageCandidate | null {
  let absolute: string;
  try {
    absolute = new URL(candidate.url, baseUrl).toString();
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(absolute)) return null;
  return { ...candidate, url: absolute };
}

function toExtractedAsset(candidate: ImageCandidate): ExtractedAsset {
  const hint = dimensionHintFromUrl(candidate.url);
  return {
    url: candidate.url,
    width: candidate.width ?? hint.width,
    height: candidate.height ?? hint.height,
    format: guessFormatFromUrl(candidate.url),
  };
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
 * Runs the full static extraction pipeline against already-fetched HTML:
 * structured data (JSON-LD, OpenGraph), platform-specific heuristics
 * (Shopify embedded product JSON, WooCommerce gallery markup), and generic
 * DOM scanning (img/srcset/lazy-load attributes/background-image), then
 * filters out non-product chrome, resolves each URL to its highest-quality
 * original, and deduplicates same-image-different-resolution results.
 */
export function extractAssets(html: string, baseUrl: string): ExtractResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const rawImageCandidates: ImageCandidate[] = [
    ...extractFromJsonLd($),
    ...extractFromOpenGraph($),
    ...extractFromShopifyProductJson($),
    ...extractFromWooCommerce($),
    ...extractFromDom($),
  ];

  const resolvedImages = rawImageCandidates
    .map((c) => resolveAndNormalize(c, baseUrl))
    .filter((c): c is ImageCandidate => c !== null)
    .filter((c) => !isLikelyDecorativeOrTracking(c.url))
    .filter((c) => !isTooSmallForProductImage(c.width, c.height));

  const deduped = dedupeCandidates(resolvedImages)
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

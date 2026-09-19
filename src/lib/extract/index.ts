import * as cheerio from "cheerio";
import type { ImageCandidate, ExtractedAsset, ExtractResult } from "../types.js";
import type { CandidateTrace, StaticPassDiagnostics } from "./diagnostics.js";
import { extractFromJsonLd } from "./jsonld.js";
import { extractFromOpenGraph } from "./opengraph.js";
import { extractFromShopifyProductJson } from "./shopify.js";
import { extractFromWooCommerce } from "./woocommerce.js";
import { extractFromDom } from "./domImages.js";
import { extractLogoCandidates, type LogoCandidate } from "./logo.js";
import { isLikelyDecorativeOrTracking, isTooSmallForProductImage, isLikelyLogoArtwork } from "./filters.js";
import { dedupeCandidates } from "../dedupe.js";
import { dimensionHintFromUrl, guessFormatFromUrl, canonicalizeImageKey } from "../imageUrl.js";

export const NO_PRODUCT_IMAGES_WARNING = "No product images detected";

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

function stageFor(candidate: ImageCandidate): CandidateTrace["stage"] {
  if (candidate.confidence === "structured") return "structured";
  if (candidate.confidence === "gallery") return "dom-gallery";
  if (candidate.source === "network-response") return "network-response";
  return "dom-generic";
}

interface Evaluated {
  trace: CandidateTrace;
  resolved: ImageCandidate | null;
}

/**
 * Resolves one raw candidate and runs the same filters the production
 * pipeline applies, recording a full trace regardless of outcome. This is
 * the single place accept/reject logic lives -- both the production result
 * and the diagnostics view are built from these traces, so there is no way
 * for the two to silently disagree.
 */
function evaluateCandidate(candidate: ImageCandidate, baseUrl: string): Evaluated {
  const stage = stageFor(candidate);
  const resolved = resolveAndNormalize(candidate, baseUrl);

  if (!resolved) {
    return {
      resolved: null,
      trace: {
        url: candidate.url,
        source: candidate.source,
        confidence: candidate.confidence,
        score: candidate.score,
        width: candidate.width,
        height: candidate.height,
        stage,
        accepted: false,
        rejectionReasons: ["unresolvable-or-non-http-url"],
      },
    };
  }

  const reasons: string[] = [];
  if (isLikelyDecorativeOrTracking(resolved.url)) reasons.push("decorative-or-tracking-pattern");
  if (isLikelyLogoArtwork(resolved.url)) reasons.push("logo-artwork-filename");
  if (isTooSmallForProductImage(resolved.width, resolved.height)) {
    reasons.push(`too-small(${resolved.width ?? "?"}x${resolved.height ?? "?"})`);
  }

  const trace: CandidateTrace = {
    url: resolved.url,
    source: resolved.source,
    confidence: resolved.confidence,
    score: resolved.score,
    width: resolved.width,
    height: resolved.height,
    stage,
    accepted: reasons.length === 0,
    rejectionReasons: reasons,
  };

  return { resolved: reasons.length === 0 ? resolved : null, trace };
}

/**
 * Whether an extraction result contains at least one image that is
 * genuinely a product photo (i.e. survived logo/decorative/tiny
 * filtering). Used to decide whether a rendered-DOM fallback pass is
 * needed: static extraction that only ever turned up branding imagery is
 * not "credible" and must not be reported as the product gallery.
 */
export function hasCredibleProductImages(result: Pick<ExtractResult, "images">): boolean {
  return result.images.length > 0;
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

interface PipelineOutput {
  result: ExtractResult;
  diagnostics: StaticPassDiagnostics;
}

/**
 * The single extraction pipeline implementation. `extractAssets` and
 * `extractAssetsWithDiagnostics` are both thin wrappers around this, so the
 * production result and its diagnostic trace can never drift apart.
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
 *
 * `extraCandidates` lets a caller (the rendered-DOM fallback pipeline) feed
 * in additional candidates discovered outside the HTML itself -- e.g.
 * images observed as network responses during a headless-browser render --
 * which are evaluated through the exact same filters as everything else.
 */
function runPipeline(html: string, baseUrl: string, extraCandidates: ImageCandidate[] = []): PipelineOutput {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  // Resolved before the image pipeline so product-image candidates can be
  // cross-checked against it (see excludeLogoDuplicate) -- a logo is never
  // simultaneously a product photo, however confidently a source reported it.
  const logoCandidates = extractLogoCandidates($);
  const logo = pickBestLogo(logoCandidates, baseUrl);

  const structuredRaw: ImageCandidate[] = [
    ...extractFromJsonLd($),
    ...extractFromOpenGraph($),
    ...extractFromShopifyProductJson($),
    ...extractFromWooCommerce($),
  ];
  const domRaw = extractFromDom($);
  const allRaw = [...structuredRaw, ...domRaw, ...extraCandidates];

  const evaluated = allRaw.map((c) => evaluateCandidate(c, baseUrl));
  const traces = evaluated.map((e) => e.trace);

  const structuredAndGallery: ImageCandidate[] = [];
  const generic: ImageCandidate[] = [];
  for (const e of evaluated) {
    if (!e.resolved) continue;
    if (e.trace.stage === "structured" || e.trace.stage === "dom-gallery") {
      structuredAndGallery.push(e.resolved);
    } else {
      generic.push(e.resolved);
    }
  }

  // Prefer the high-confidence set whenever it produced anything at all;
  // only fall back to the unscoped generic scan when it is truly empty.
  const tierUsed: StaticPassDiagnostics["tierUsed"] =
    structuredAndGallery.length > 0 ? "structured+gallery" : generic.length > 0 ? "generic" : "none";
  const chosen = structuredAndGallery.length > 0 ? structuredAndGallery : generic;

  const winners = dedupeCandidates(chosen);
  const winnerUrls = new Set(winners.map((w) => w.url));

  // Anything that was accepted by every filter but lost to a
  // higher-resolution duplicate of the same underlying asset is not a
  // rejection in the usual sense, but it explains why that exact URL isn't
  // in the final list -- record it as such rather than leaving it looking
  // like an unexplained silent drop.
  for (const trace of traces) {
    if (trace.accepted && chosen.some((c) => c.url === trace.url) && !winnerUrls.has(trace.url)) {
      const winner = winners.find((w) => canonicalizeImageKey(w.url) === canonicalizeImageKey(trace.url));
      trace.accepted = false;
      trace.rejectionReasons.push(
        winner ? `duplicate-lower-resolution-than:${winner.url}` : "duplicate-lower-resolution-variant",
      );
    }
  }

  const logoKey = logo && !logo.url.startsWith("data:") ? canonicalizeImageKey(logo.url) : null;
  const finalWinners = logoKey ? winners.filter((w) => canonicalizeImageKey(w.url) !== logoKey) : winners;
  if (logoKey) {
    for (const trace of traces) {
      if (trace.accepted && winnerUrls.has(trace.url) && canonicalizeImageKey(trace.url) === logoKey) {
        trace.accepted = false;
        trace.rejectionReasons.push("same-asset-as-detected-logo");
      }
    }
  }

  const deduped = finalWinners.sort((a, b) => b.score - a.score).slice(0, MAX_IMAGES);

  const images = deduped.map(toExtractedAsset);
  if (images.length === 0) {
    warnings.push(NO_PRODUCT_IMAGES_WARNING);
  }

  if (!logo) {
    warnings.push("No brand logo was found on this page.");
  }

  const result: ExtractResult = {
    sourceUrl: baseUrl,
    images,
    logo,
    warnings,
  };

  const diagnostics: StaticPassDiagnostics = {
    finalUrl: baseUrl,
    htmlLength: html.length,
    logoUrl: logo?.url ?? null,
    logoCandidateCount: logoCandidates.length,
    candidates: traces,
    tierUsed,
    finalImageUrls: images.map((i) => i.url),
    hasCredibleProductImages: hasCredibleProductImages(result),
  };

  return { result, diagnostics };
}

/**
 * Runs the full static extraction pipeline against already-fetched HTML and
 * returns only the result, for callers that don't need the diagnostic
 * trace (this is what every extractor test in this repo uses).
 */
export function extractAssets(html: string, baseUrl: string, extraCandidates: ImageCandidate[] = []): ExtractResult {
  return runPipeline(html, baseUrl, extraCandidates).result;
}

/**
 * Same extraction as `extractAssets`, but also returns a full per-candidate
 * diagnostic trace: every source's raw candidates, whether each survived
 * filtering and exactly why not if it didn't, which confidence tier was
 * used, and the final credibility verdict. Used by the debug-mode request
 * path (`DEBUG_EXTRACTION=true`) to explain a specific extraction failure
 * without guessing.
 */
export function extractAssetsWithDiagnostics(
  html: string,
  baseUrl: string,
  extraCandidates: ImageCandidate[] = [],
): PipelineOutput {
  return runPipeline(html, baseUrl, extraCandidates);
}

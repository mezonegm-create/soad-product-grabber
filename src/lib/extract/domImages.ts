import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { ImageCandidate } from "../types.js";
import { parseSrcset, highestResolutionFromSrcset } from "../srcset.js";

const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-zoom-image", "data-hi-res"];
const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

const GALLERY_HINT = /(product[-_ ]?(gallery|image|photo|media)|gallery[-_ ]?(image|item|thumb)|main[-_ ]?image|pdp[-_ ]?(image|gallery)|zoom)/i;

// Generic, platform-agnostic vocabulary for sections that are never the
// current product's own photos: site chrome (nav/header/footer), and
// merchandising/editorial sections that link to OTHER products (related
// items, recommendations, comparison tables, carousels, promotional
// banners, lifestyle/editorial imagery, store-wide badges). Deliberately
// vocabulary-based rather than tied to any one retailer's class names, so
// it generalizes across Shopify/WooCommerce/Salla/Apple-style storefronts
// alike instead of overfitting to a single site observed during testing.
const NAV_OR_CHROME_HINT =
  /(header|footer|nav|menu|\bcart\b|sidebar|breadcrumb|related|upsell|cross-sell|recommend|similar|also-like|also[-_ ]?bought|compare|comparison|carousel|slider|\bslides?\b|banner|\bpromo\b|promotion|editorial|lifestyle|storefront|store-locator|newsletter|subscribe|social[-_ ]?(share|link|icon)|app-badge|app-store|play-store|store-badge|testimonial|review-widget|trust-badge|chat-widget|cookie|consent|accessor(?:y|ies)|bundle|you[-_ ]?may[-_ ]?also|shop[-_ ]?the[-_ ]?look|more[-_ ]?to[-_ ]?explore|explore[-_ ]?more)/i;

function closestClassChainMatches($: CheerioAPI, el: AnyNode, pattern: RegExp): boolean {
  let node = $(el);
  for (let depth = 0; depth < 6 && node.length; depth += 1) {
    const cls = `${node.attr("class") ?? ""} ${node.attr("id") ?? ""}`;
    if (pattern.test(cls)) return true;
    node = node.parent();
  }
  return false;
}

/**
 * Scans rendered <img>, <picture><source>, and background-image styles for
 * candidate product photos, honoring common lazy-loading attributes and
 * srcset resolution switching. Assigns a heuristic score based on whether
 * the element sits inside a recognizable product-gallery container versus
 * navigation/recommendation chrome.
 */
export function extractFromDom($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  $("img").each((_i, el) => {
    const $img = $(el);
    const inGallery = closestClassChainMatches($, el, GALLERY_HINT);
    const inChrome = closestClassChainMatches($, el, NAV_OR_CHROME_HINT);
    if (inChrome && !inGallery) return;
    let baseScore = inGallery ? 75 : 45;

    const alt = ($img.attr("alt") ?? "").toLowerCase();
    if (/logo|icon/.test(alt) && !inGallery) baseScore -= 15;

    const directSrc = $img.attr("src");
    const lazySrc = LAZY_SRC_ATTRS.map((a) => $img.attr(a)).find(Boolean);
    const url = lazySrc || directSrc;

    const widthAttr = numOrUndefined($img.attr("width"));
    const heightAttr = numOrUndefined($img.attr("height"));

    const confidence = inGallery ? "gallery" : "generic";

    if (url && !url.startsWith("data:")) {
      candidates.push({ url, width: widthAttr, height: heightAttr, source: "img", score: baseScore, confidence });
    }

    for (const attr of ["srcset", ...LAZY_SRCSET_ATTRS]) {
      const value = $img.attr(attr);
      if (!value) continue;
      const best = highestResolutionFromSrcset(parseSrcset(value));
      if (best) {
        candidates.push({
          url: best.url,
          width: best.width,
          source: "img-srcset",
          score: baseScore + 5,
          confidence,
        });
      }
    }
  });

  $("picture source").each((_i, el) => {
    const $source = $(el);
    const inGallery = closestClassChainMatches($, el, GALLERY_HINT);
    const inChrome = closestClassChainMatches($, el, NAV_OR_CHROME_HINT);
    if (inChrome && !inGallery) return;
    const baseScore = inGallery ? 78 : 48;

    const value = $source.attr("srcset") ?? $source.attr("data-srcset");
    if (!value) return;
    const best = highestResolutionFromSrcset(parseSrcset(value));
    if (best) {
      candidates.push({
        url: best.url,
        width: best.width,
        source: "picture-source",
        score: baseScore,
        confidence: inGallery ? "gallery" : "generic",
      });
    }
  });

  // Anchors that wrap a gallery thumbnail and link straight to the
  // full-resolution image (a very common lightbox/zoom pattern). Only
  // trusted when the anchor sits inside a recognized gallery container --
  // this source is never used as part of the unscoped generic fallback.
  $("a").each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href || !/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(href)) return;
    if (!$a.find("img").length) return;
    const inGallery = closestClassChainMatches($, el, GALLERY_HINT);
    if (!inGallery) return;
    candidates.push({ url: href, source: "gallery-anchor", score: 82, confidence: "gallery" });
  });

  // CSS background-image, restricted to elements that are clearly part of a
  // product gallery to avoid picking up decorative page backgrounds.
  $("[style*='background-image']").each((_i, el) => {
    const $el = $(el);
    const inGallery = closestClassChainMatches($, el, GALLERY_HINT);
    if (!inGallery) return;
    const style = $el.attr("style") ?? "";
    const match = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    if (match?.[2]) {
      candidates.push({ url: match[2], source: "css-background", score: 70, confidence: "gallery" });
    }
  });

  return candidates;
}

function numOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

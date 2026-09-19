import type { CheerioAPI } from "cheerio";
import type { ImageCandidate } from "../types.js";

/**
 * WooCommerce's default product gallery renders thumbnails as
 * `<img class="wp-post-image" ... data-large_image="https://.../full.jpg"
 * data-large_image_width="1600" data-large_image_height="1600">` inside
 * `.woocommerce-product-gallery__image` wrappers, and often also wraps the
 * thumbnail in `<a href="full-size-image.jpg">` for a lightbox. Both encode
 * the original, non-cropped image URL directly, which is more reliable than
 * the cropped `-100x100`/`-300x300` thumbnail `src`.
 */
export function extractFromWooCommerce($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  $(".woocommerce-product-gallery__image, .woocommerce-product-gallery__wrapper .woocommerce-product-gallery__image")
    .each((_i, el) => {
      const $el = $(el);
      const anchorHref = $el.find("a").attr("href");
      if (anchorHref) candidates.push({ url: anchorHref, source: "woocommerce-gallery-link", score: 88 });

      const img = $el.find("img").first();
      const dataLarge = img.attr("data-large_image");
      if (dataLarge) {
        const width = numOrUndefined(img.attr("data-large_image_width"));
        const height = numOrUndefined(img.attr("data-large_image_height"));
        candidates.push({ url: dataLarge, width, height, source: "woocommerce-data-large", score: 90 });
      }
    });

  $("img[data-large_image]").each((_i, el) => {
    const $el = $(el);
    const url = $el.attr("data-large_image");
    if (!url) return;
    const width = numOrUndefined($el.attr("data-large_image_width"));
    const height = numOrUndefined($el.attr("data-large_image_height"));
    candidates.push({ url, width, height, source: "woocommerce-data-large", score: 90 });
  });

  return candidates;
}

function numOrUndefined(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

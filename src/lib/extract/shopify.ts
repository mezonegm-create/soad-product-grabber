import type { CheerioAPI } from "cheerio";
import type { ImageCandidate } from "../types.js";

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.src === "string") out.push(obj.src);
    else if (typeof obj.url === "string") out.push(obj.url);
  }
}

/**
 * Shopify themes commonly embed the full product record (including every
 * media/image variant) as JSON in a <script> tag -- either
 * `<script id="ProductJson-...">`, `<script type="application/json"
 * data-product-json>`, or a `var meta = {...}` / `ShopifyAnalytics.meta.product`
 * blob. This reads the `images`/`media` arrays from any such embedded JSON,
 * which is far more reliable than scraping rendered <img> tags because it
 * includes every gallery image regardless of lazy-loading/carousel state.
 */
export function extractFromShopifyProductJson($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  const selectors = [
    'script[id^="ProductJson-"]',
    "script[data-product-json]",
    'script[type="application/json"][id*="product" i]',
  ];

  $(selectors.join(", ")).each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    const urls: string[] = [];
    collectStrings(obj.images, urls);
    collectStrings(obj.media, urls);

    for (const url of urls) {
      if (!/\.(jpe?g|png|webp|gif)/i.test(url)) continue;
      candidates.push({ url: normalizeProtocolRelative(url), source: "shopify-json", score: 85 });
    }
  });

  return candidates;
}

function normalizeProtocolRelative(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

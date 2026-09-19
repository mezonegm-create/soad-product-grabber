export interface UrlDimensionHint {
  width?: number;
  height?: number;
}

// Shopify (and many other CDNs built on similar conventions) encode a
// resize into the filename: name_800x800.jpg, name_800x.jpg, name_x800.jpg.
// WordPress/WooCommerce encodes generated thumbnail sizes as
// name-800x800.jpg. Stripping the suffix recovers the original asset URL.
//
// Separately, `name@2x.jpg` / `name_2x.jpg` / `name_3x.jpg` is the common
// *pixel-density* (retina) naming convention: the single digit there is a
// density multiplier (1x-4x), NOT a pixel width. The width-suffix pattern
// below requires >= 2 digits specifically so it cannot match that
// single-digit density form -- conflating the two previously produced
// bogus "2px wide" dimension hints for perfectly normal icons/assets named
// like "search_2x.png".
const SHOPIFY_SIZE_SUFFIX = /_(\d{2,5})x(\d{2,5})?(?=\.[a-zA-Z]+$)/;
const SHOPIFY_SIZE_SUFFIX_REVERSE = /_x(\d{2,5})(?=\.[a-zA-Z]+$)/;
const WORDPRESS_SIZE_SUFFIX = /-(\d{2,5})x(\d{2,5})(?=\.[a-zA-Z]+$)/;
const RETINA_SUFFIX = /[@_](\d)x(?=\.[a-zA-Z]+$)/;

const SIZE_QUERY_PARAMS = ["width", "height", "w", "h", "size", "resize", "quality", "scale"];

/**
 * Removes a known CDN resize suffix from a URL pathname, leaving the file
 * extension (matched via lookahead, not consumed) intact.
 */
function stripSizeSuffix(pathname: string): string {
  return pathname
    .replace(SHOPIFY_SIZE_SUFFIX, "")
    .replace(SHOPIFY_SIZE_SUFFIX_REVERSE, "")
    .replace(WORDPRESS_SIZE_SUFFIX, "")
    .replace(RETINA_SUFFIX, "");
}

/**
 * Extracts a width/height hint from a CDN-style filename suffix, if present.
 */
export function dimensionHintFromUrl(rawUrl: string): UrlDimensionHint {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = rawUrl;
  }

  const shopify = pathname.match(SHOPIFY_SIZE_SUFFIX);
  if (shopify) {
    const width = shopify[1] ? parseInt(shopify[1], 10) : undefined;
    const height = shopify[2] ? parseInt(shopify[2], 10) : undefined;
    return { width, height };
  }
  const wp = pathname.match(WORDPRESS_SIZE_SUFFIX);
  if (wp) {
    return { width: parseInt(wp[1]!, 10), height: parseInt(wp[2]!, 10) };
  }

  try {
    const url = new URL(rawUrl);
    for (const key of ["width", "w"]) {
      const v = url.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return { width: parseInt(v, 10) };
    }
  } catch {
    // relative URL, ignore
  }

  return {};
}

/**
 * Strips known CDN resize suffixes/query params to obtain a canonical key
 * used to recognize "the same image at different resolutions". This is NOT
 * guaranteed to be a fetchable URL -- use `upgradeToOriginalUrl` for that.
 */
export function canonicalizeImageKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const pathname = stripSizeSuffix(url.pathname);

  // Query strings on image CDN URLs are overwhelmingly cache-busting
  // versions or additional resize parameters rather than an indicator of a
  // genuinely different photo, so they are ignored entirely for dedupe
  // purposes (resolution is still read from them separately).
  return `${url.hostname.toLowerCase()}${pathname}`;
}

/**
 * Attempts to rewrite a resized CDN image URL into the highest-quality
 * original by removing the resize suffix / sizing query params. Falls back
 * to the input URL unchanged when no known pattern matches.
 */
export function upgradeToOriginalUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  url.pathname = stripSizeSuffix(url.pathname);

  for (const key of SIZE_QUERY_PARAMS) url.searchParams.delete(key);

  return url.toString();
}

export function guessFormatFromUrl(rawUrl: string): string | undefined {
  try {
    const pathname = new URL(rawUrl).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    return match?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

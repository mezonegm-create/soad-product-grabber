const IGNORED_FILENAME_PATTERNS =
  /(sprite|spinner|loading|placeholder|\bblank\b|transparent[-_]?pixel|pixel\.gif|\b1x1\b|favicon|apple-touch-icon|payment|visa|mastercard|maestro|paypal|klarna|amex|discover-card|google-pay|apple-pay|badge|trustpilot|stars?-rating|avatar|social-icon|icon-facebook|icon-instagram|icon-twitter|icon-tiktok|icon-youtube|flag-icon|country-flag)/i;

const IGNORED_HOST_PATTERNS =
  /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com\/tr|connect\.facebook\.net|hotjar\.com|clarity\.ms|segment\.(io|com)|cdn\.optimizely\.com)/i;

const MIN_PRODUCT_IMAGE_DIMENSION = 150;

/**
 * Heuristic check for whether a discovered image URL is actual visual
 * content worth surfacing as a product photo, as opposed to UI chrome,
 * tracking pixels, or payment/social iconography.
 */
export function isLikelyDecorativeOrTracking(url: string): boolean {
  if (IGNORED_FILENAME_PATTERNS.test(url)) return true;
  if (IGNORED_HOST_PATTERNS.test(url)) return true;
  return false;
}

export function isTooSmallForProductImage(width?: number, height?: number): boolean {
  if (typeof width === "number" && width > 0 && width < MIN_PRODUCT_IMAGE_DIMENSION) return true;
  if (typeof height === "number" && height > 0 && height < MIN_PRODUCT_IMAGE_DIMENSION) return true;
  return false;
}

const LOGO_HINT = /logo/i;
const LOGO_EXCLUDE = /(payment|visa|mastercard|paypal|klarna|amex|badge|trustpilot|partner|sponsor|award|certificate|favicon)/i;

export function looksLikeLogoHint(text: string): boolean {
  return LOGO_HINT.test(text) && !LOGO_EXCLUDE.test(text);
}

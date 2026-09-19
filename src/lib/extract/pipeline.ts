import type { ExtractResult } from "../types.js";
import { extractAssets, hasCredibleProductImages } from "./index.js";

export interface RenderedPage {
  html: string;
  finalUrl: string;
}

export interface FallbackDeps {
  /** Renders the page with a real browser (see src/lib/render/browserRender.ts). */
  renderDynamic: (url: string) => Promise<RenderedPage>;
}

/**
 * Runs static extraction first, and only reaches for a real headless-browser
 * render when static extraction did not turn up a single credible product
 * image (see `hasCredibleProductImages`) -- for example when a product
 * gallery is populated entirely by client-side JavaScript after the initial
 * HTML load, so the raw HTML never contains it at all, and the only
 * structured signals on the page (og:image, JSON-LD) happen to point at
 * brand artwork instead (the real-world Heaven Moon failure this guards
 * against). A browser is never launched when static extraction already
 * succeeded, and a rendering failure (timeout, blocked, etc.) falls back to
 * the static result rather than failing the whole request.
 */
export async function extractAssetsWithFallback(
  staticHtml: string,
  staticFinalUrl: string,
  deps: FallbackDeps,
): Promise<ExtractResult> {
  const staticResult = extractAssets(staticHtml, staticFinalUrl);
  if (hasCredibleProductImages(staticResult)) {
    return staticResult;
  }

  let rendered: RenderedPage | null = null;
  try {
    rendered = await deps.renderDynamic(staticFinalUrl);
  } catch {
    rendered = null;
  }

  if (rendered) {
    const renderedResult = extractAssets(rendered.html, rendered.finalUrl);
    if (hasCredibleProductImages(renderedResult)) {
      // The static pass may still have found a logo even though it found no
      // credible product images (this is, in fact, exactly the Heaven Moon
      // scenario); prefer it if the render pass didn't find one of its own.
      return {
        ...renderedResult,
        logo: renderedResult.logo ?? staticResult.logo,
      };
    }
  }

  // Neither the static pass nor the rendered fallback found a genuine
  // product image. `staticResult` already reports NO_PRODUCT_IMAGES_WARNING
  // with an empty images array in this case -- returned as-is rather than
  // falsely presenting a logo as a product photo.
  return staticResult;
}

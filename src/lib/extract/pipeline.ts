import type { ExtractResult } from "../types.js";
import type { ExtractionDiagnostics, RenderPassDiagnostics } from "./diagnostics.js";
import { extractAssets, extractAssetsWithDiagnostics, hasCredibleProductImages } from "./index.js";

export interface RenderedPage {
  html: string;
  finalUrl: string;
  /**
   * Optional so existing callers/tests that stub `renderDynamic` with a
   * bare `{ html, finalUrl }` keep type-checking; when present, its
   * `networkImageUrls` are fed into the extraction pass as additional
   * candidates (see below) and the rest is surfaced in debug diagnostics.
   */
  diagnostics?: {
    gallerySelectorsMatched?: string[];
    imgCountAfterHydration?: number;
    sourceCountAfterHydration?: number;
    domImageUrls?: string[];
    networkImageUrls?: string[];
    screenshotPath?: string;
  };
}

export interface FallbackDeps {
  /** Renders the page with a real browser (see src/lib/render/browserRender.ts). */
  renderDynamic: (url: string) => Promise<RenderedPage>;
}

function networkCandidatesFrom(rendered: RenderedPage) {
  return (rendered.diagnostics?.networkImageUrls ?? []).map((url) => ({
    url,
    source: "network-response",
    score: 50,
    confidence: "generic" as const,
  }));
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
 *
 * When the render pass ran, every image URL it observed as a successful
 * network response (not just what ended up reflected in the DOM) is fed
 * into the same extraction pipeline as additional candidates -- some
 * storefronts render a gallery through JavaScript in a way that never
 * leaves a usable URL in any DOM attribute at all.
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
    const renderedResult = extractAssets(rendered.html, rendered.finalUrl, networkCandidatesFrom(rendered));
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

export interface DiagnosticFallbackDeps {
  renderDynamic: (url: string) => Promise<RenderedPage>;
}

/**
 * Same static-first/render-fallback logic as `extractAssetsWithFallback`,
 * but builds and returns the full `ExtractionDiagnostics` trace alongside
 * the result: every candidate considered in both passes (with accept/reject
 * reasons), whether the render was even attempted/triggered, what the
 * render observed in the hydrated DOM and on the network, and the final
 * verdict. Used exclusively by the `DEBUG_EXTRACTION=true` request path in
 * app.ts -- kept separate from `extractAssetsWithFallback` so the
 * production path's behavior and return type are untouched.
 */
export async function extractAssetsWithFallbackDiagnostics(
  requestUrl: string,
  staticHtml: string,
  staticFinalUrl: string,
  deps: DiagnosticFallbackDeps,
): Promise<{ result: ExtractResult; diagnostics: ExtractionDiagnostics; renderedHtml: string | null }> {
  const staticPassOutput = extractAssetsWithDiagnostics(staticHtml, staticFinalUrl);

  const renderPass: RenderPassDiagnostics = { attempted: false, triggered: false };

  if (hasCredibleProductImages(staticPassOutput.result)) {
    return {
      result: staticPassOutput.result,
      renderedHtml: null,
      diagnostics: {
        requestUrl,
        staticPass: staticPassOutput.diagnostics,
        renderPass,
        finalImageUrls: staticPassOutput.result.images.map((i) => i.url),
        finalLogoUrl: staticPassOutput.result.logo?.url ?? null,
        warnings: staticPassOutput.result.warnings,
      },
    };
  }

  renderPass.triggered = true;
  renderPass.attempted = true;

  let rendered: RenderedPage | null = null;
  try {
    rendered = await deps.renderDynamic(staticFinalUrl);
  } catch (err) {
    renderPass.error = err instanceof Error ? err.message : String(err);
  }

  if (rendered) {
    renderPass.finalUrl = rendered.finalUrl;
    renderPass.htmlLength = rendered.html.length;
    renderPass.gallerySelectorsMatched = rendered.diagnostics?.gallerySelectorsMatched;
    renderPass.imgCountAfterHydration = rendered.diagnostics?.imgCountAfterHydration;
    renderPass.sourceCountAfterHydration = rendered.diagnostics?.sourceCountAfterHydration;
    renderPass.domImageUrls = rendered.diagnostics?.domImageUrls;
    renderPass.networkImageUrls = rendered.diagnostics?.networkImageUrls;
    renderPass.screenshotPath = rendered.diagnostics?.screenshotPath;

    const renderedPassOutput = extractAssetsWithDiagnostics(
      rendered.html,
      rendered.finalUrl,
      networkCandidatesFrom(rendered),
    );
    renderPass.candidates = renderedPassOutput.diagnostics.candidates;
    renderPass.tierUsed = renderedPassOutput.diagnostics.tierUsed;
    renderPass.finalImageUrls = renderedPassOutput.diagnostics.finalImageUrls;
    renderPass.hasCredibleProductImages = renderedPassOutput.diagnostics.hasCredibleProductImages;

    if (hasCredibleProductImages(renderedPassOutput.result)) {
      const result: ExtractResult = {
        ...renderedPassOutput.result,
        logo: renderedPassOutput.result.logo ?? staticPassOutput.result.logo,
      };
      return {
        result,
        renderedHtml: rendered.html,
        diagnostics: {
          requestUrl,
          staticPass: staticPassOutput.diagnostics,
          renderPass,
          finalImageUrls: result.images.map((i) => i.url),
          finalLogoUrl: result.logo?.url ?? null,
          warnings: result.warnings,
        },
      };
    }
  }

  return {
    result: staticPassOutput.result,
    renderedHtml: rendered?.html ?? null,
    diagnostics: {
      requestUrl,
      staticPass: staticPassOutput.diagnostics,
      renderPass,
      finalImageUrls: staticPassOutput.result.images.map((i) => i.url),
      finalLogoUrl: staticPassOutput.result.logo?.url ?? null,
      warnings: staticPassOutput.result.warnings,
    },
  };
}

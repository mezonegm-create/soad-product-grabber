import type { ImageConfidence } from "../types.js";

/**
 * Per-candidate trace: exactly which raw source produced this URL, what
 * confidence tier it was assigned, and -- critically for debugging a
 * "the wrong image won" report -- whether it survived every filter and,
 * if not, precisely which one rejected it and why. Built for every
 * candidate considered, whether or not it ends up in the final result.
 */
export interface CandidateTrace {
  url: string;
  source: string;
  confidence: ImageConfidence | "network-response";
  score: number;
  width?: number;
  height?: number;
  /** Which stage of the pipeline this candidate was drawn from. */
  stage: "structured" | "dom-gallery" | "dom-generic" | "network-response";
  accepted: boolean;
  rejectionReasons: string[];
}

export interface StaticPassDiagnostics {
  finalUrl: string;
  htmlLength: number;
  logoUrl: string | null;
  logoCandidateCount: number;
  /** Every candidate considered, from every source, before any filtering. */
  candidates: CandidateTrace[];
  /** Which confidence tier's candidates were actually used for the result. */
  tierUsed: "structured+gallery" | "generic" | "none";
  finalImageUrls: string[];
  hasCredibleProductImages: boolean;
}

export interface RenderPassDiagnostics {
  attempted: boolean;
  triggered: boolean;
  error?: string;
  finalUrl?: string;
  htmlLength?: number;
  /** Which of the generic gallery-container selectors actually matched. */
  gallerySelectorsMatched?: string[];
  imgCountAfterHydration?: number;
  sourceCountAfterHydration?: number;
  /** Every image URL discovered directly in the hydrated DOM (src, currentSrc, srcset, data-src, background-image, anchor href around an image). */
  domImageUrls?: string[];
  /** Every successful image HTTP response observed while the page rendered. */
  networkImageUrls?: string[];
  screenshotPath?: string;
  candidates?: CandidateTrace[];
  tierUsed?: "structured+gallery" | "generic" | "none";
  finalImageUrls?: string[];
  hasCredibleProductImages?: boolean;
}

export interface ExtractionDiagnostics {
  requestUrl: string;
  staticPass: StaticPassDiagnostics;
  renderPass: RenderPassDiagnostics;
  finalImageUrls: string[];
  finalLogoUrl: string | null;
  warnings: string[];
}

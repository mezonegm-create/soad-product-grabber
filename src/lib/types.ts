/**
 * How trustworthy a candidate's origin is as a signal that it belongs to
 * THIS product, used to decide whether generic page-wide scanning is
 * allowed to contribute results at all:
 *   - "structured": explicit product data (JSON-LD Product.image,
 *     OpenGraph, Shopify/WooCommerce embedded product data). Always
 *     product-specific by construction.
 *   - "gallery": found inside a DOM container recognized as the product
 *     gallery/media area. Strong positional signal, not guaranteed.
 *   - "generic": found anywhere else on the page via unscoped DOM
 *     scanning. Used only when nothing more confident exists.
 */
export type ImageConfidence = "structured" | "gallery" | "generic";

export interface ImageCandidate {
  url: string;
  width?: number;
  height?: number;
  source: string;
  score: number;
  confidence: ImageConfidence;
}

export interface ExtractedAsset {
  url: string;
  width?: number;
  height?: number;
  format?: string;
}

export interface ExtractResult {
  sourceUrl: string;
  images: ExtractedAsset[];
  logo: ExtractedAsset | null;
  warnings: string[];
}

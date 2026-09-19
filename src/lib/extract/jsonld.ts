import type { CheerioAPI } from "cheerio";
import type { ImageCandidate } from "../types.js";

function collectImageUrls(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectImageUrls);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === "string") return [obj.url];
    if (typeof obj.contentUrl === "string") return [obj.contentUrl];
  }
  return [];
}

function isProductNode(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  if (typeof type === "string") return type.toLowerCase() === "product";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase() === "product");
  return false;
}

function* walkNodes(value: unknown): Generator<Record<string, unknown>> {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkNodes(item);
    return;
  }
  const obj = value as Record<string, unknown>;
  yield obj;
  if (Array.isArray(obj["@graph"])) yield* walkNodes(obj["@graph"]);
}

/**
 * Extracts product image URLs from schema.org JSON-LD `Product` nodes
 * embedded via <script type="application/ld+json">.
 */
export function extractFromJsonLd($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const node of walkNodes(parsed)) {
      if (!isProductNode(node)) continue;
      const urls = collectImageUrls(node.image);
      for (const url of urls) {
        candidates.push({ url, source: "jsonld", score: 90 });
      }
    }
  });

  return candidates;
}

/**
 * Extracts the brand/organization logo URL from schema.org JSON-LD
 * `Organization` (or `Product.brand`) nodes.
 */
export function extractLogoFromJsonLd($: CheerioAPI): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw || !raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const node of walkNodes(parsed)) {
      const type = node["@type"];
      const typeStr = Array.isArray(type) ? type.join(",") : String(type ?? "");
      if (!/organization|brand/i.test(typeStr)) continue;
      const urls = collectImageUrls(node.logo);
      for (const url of urls) {
        candidates.push({ url, source: "jsonld-logo", score: 95 });
      }
    }
  });

  return candidates;
}

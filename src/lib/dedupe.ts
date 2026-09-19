import type { ImageCandidate } from "./types.js";
import { canonicalizeImageKey, dimensionHintFromUrl } from "./imageUrl.js";

function effectiveArea(c: ImageCandidate): number {
  const hint = dimensionHintFromUrl(c.url);
  const width = c.width ?? hint.width ?? 0;
  const height = c.height ?? hint.height ?? width; // assume roughly square if unknown
  if (width && height) return width * height;
  if (width) return width * width;
  return 0;
}

/**
 * Groups candidates that represent the same underlying asset at different
 * resolutions (recognized via CDN resize-suffix stripping) and keeps only
 * the highest-resolution / highest-scored representative from each group.
 * Distinct product angles (different canonical keys) are all preserved.
 */
export function dedupeCandidates(candidates: ImageCandidate[]): ImageCandidate[] {
  const groups = new Map<string, ImageCandidate[]>();

  for (const candidate of candidates) {
    const key = canonicalizeImageKey(candidate.url);
    const list = groups.get(key);
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  }

  const winners: ImageCandidate[] = [];
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => {
      const areaA = effectiveArea(a);
      const areaB = effectiveArea(b);
      if (areaA !== areaB) return areaA > areaB ? a : b;
      return a.score >= b.score ? a : b;
    });
    winners.push(best);
  }

  return winners;
}

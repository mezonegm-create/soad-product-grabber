export interface SrcsetEntry {
  url: string;
  width?: number;
  density?: number;
}

/**
 * Parses an HTML `srcset` attribute value into its candidate entries.
 * Supports both width descriptors ("image.jpg 800w") and pixel-density
 * descriptors ("image.jpg 2x").
 */
export function parseSrcset(value: string): SrcsetEntry[] {
  if (!value) return [];
  const entries: SrcsetEntry[] = [];
  // Split on commas that are followed by whitespace + a URL (commas can
  // legally appear inside URLs, so we split conservatively).
  const parts = value
    .trim()
    .split(/,(?=\s*\S)/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const match = part.match(/^(\S+)(?:\s+([\d.]+)(w|x))?$/);
    if (!match) continue;
    const [, url, num, unit] = match;
    if (!url) continue;
    const entry: SrcsetEntry = { url };
    if (num && unit === "w") entry.width = parseInt(num, 10);
    if (num && unit === "x") entry.density = parseFloat(num);
    entries.push(entry);
  }
  return entries;
}

/**
 * Given parsed srcset entries, returns the URL of the highest-resolution
 * candidate. Width descriptors are preferred (they state absolute pixel
 * size); when only density descriptors are present, the highest density
 * wins.
 */
export function highestResolutionFromSrcset(entries: SrcsetEntry[]): SrcsetEntry | undefined {
  if (entries.length === 0) return undefined;
  const withWidth = entries.filter((e) => typeof e.width === "number");
  if (withWidth.length > 0) {
    return withWidth.reduce((best, cur) => (cur.width! > best.width! ? cur : best));
  }
  const withDensity = entries.filter((e) => typeof e.density === "number");
  if (withDensity.length > 0) {
    return withDensity.reduce((best, cur) => (cur.density! > best.density! ? cur : best));
  }
  return entries[0];
}

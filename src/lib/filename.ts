/**
 * Derives a filesystem-safe, human-readable filename for a downloaded asset
 * from its URL, guaranteeing uniqueness within a batch via an index suffix
 * and preserving the original file extension when known.
 */
export function filenameForUrl(url: string, index: number, fallbackExt = "jpg"): string {
  let base = `image-${index + 1}`;
  let ext = fallbackExt;

  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last) {
      const dot = last.lastIndexOf(".");
      if (dot > 0) {
        base = sanitize(last.slice(0, dot)) || base;
        ext = sanitize(last.slice(dot + 1)) || ext;
      } else {
        base = sanitize(last) || base;
      }
    }
  } catch {
    // ignore, keep fallback
  }

  ext = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || fallbackExt;
  return `${index + 1}-${base}.${ext}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

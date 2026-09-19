const MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

export function extensionForContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(";")[0]?.trim().toLowerCase();
  return base ? MAP[base] : undefined;
}

export function isImageContentType(contentType: string | undefined): boolean {
  return !!contentType && contentType.toLowerCase().startsWith("image/");
}

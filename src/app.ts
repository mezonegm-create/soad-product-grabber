import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { safeFetch, UnsafeUrlError } from "./lib/safeFetch.js";
import { extractAssetsWithFallback } from "./lib/extract/pipeline.js";
import { renderWithBrowser } from "./lib/render/browserRender.js";
import { extensionForContentType, isImageContentType } from "./lib/contentType.js";
import { filenameForUrl } from "./lib/filename.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MAX_ASSET_BYTES = 25 * 1024 * 1024; // 25MB per image
const MAX_BATCH_ITEMS = 80;

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(PUBLIC_DIR));

  app.post("/api/extract", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "A product page URL is required." });
      return;
    }

    try {
      const fetched = await safeFetch(url, { timeoutMs: 20_000 });
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        res.status(502).json({ error: `The site responded with status ${fetched.statusCode}.` });
        return;
      }
      const contentType = fetched.headers["content-type"] ?? "";
      if (!contentType.includes("html")) {
        res.status(422).json({ error: "The URL did not return an HTML page." });
        return;
      }

      const html = fetched.body.toString("utf-8");
      const result = await extractAssetsWithFallback(html, fetched.finalUrl, {
        renderDynamic: (url) => renderWithBrowser(url, { timeoutMs: 20_000 }),
      });
      res.json(result);
    } catch (err) {
      handleFetchError(err, res);
    }
  });

  app.get("/api/download", async (req: Request, res: Response) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    const filename = typeof req.query.filename === "string" ? req.query.filename : undefined;
    if (!url) {
      res.status(400).json({ error: "A url query parameter is required." });
      return;
    }

    if (url.startsWith("data:")) {
      streamDataUrl(url, filename ?? "logo.svg", res);
      return;
    }

    try {
      const fetched = await safeFetch(url, { timeoutMs: 20_000, maxBytes: MAX_ASSET_BYTES });
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        res.status(502).json({ error: `The asset responded with status ${fetched.statusCode}.` });
        return;
      }
      const contentType = fetched.headers["content-type"];
      if (!isImageContentType(contentType)) {
        res.status(422).json({ error: "The requested URL is not an image." });
        return;
      }
      res.setHeader("Content-Type", contentType!);
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeHeaderValue(filename ?? "download")}"`);
      res.send(fetched.body);
    } catch (err) {
      handleFetchError(err, res);
    }
  });

  app.post("/api/download-all", async (req: Request, res: Response) => {
    const images: string[] = Array.isArray(req.body?.images) ? req.body.images.filter((u: unknown) => typeof u === "string") : [];
    const logo: string | null = typeof req.body?.logo === "string" ? req.body.logo : null;

    const items = [...images, ...(logo ? [logo] : [])].slice(0, MAX_BATCH_ITEMS);
    if (items.length === 0) {
      res.status(400).json({ error: "No assets were provided to download." });
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="soad-product-assets.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      // Headers are likely already sent once streaming starts; best effort.
      res.destroy(err);
    });
    archive.pipe(res);

    for (let i = 0; i < items.length; i += 1) {
      const url = items[i]!;
      const isLogo = logo !== null && url === logo;
      try {
        if (url.startsWith("data:")) {
          const { buffer, ext } = decodeDataUrl(url);
          archive.append(buffer, { name: `logo.${ext}` });
          continue;
        }
        const fetched = await safeFetch(url, { timeoutMs: 20_000, maxBytes: MAX_ASSET_BYTES });
        if (fetched.statusCode < 200 || fetched.statusCode >= 300) continue;
        if (!isImageContentType(fetched.headers["content-type"])) continue;
        const ext = extensionForContentType(fetched.headers["content-type"]) ?? "jpg";
        const name = isLogo ? `logo.${ext}` : filenameForUrl(url, i, ext);
        archive.append(fetched.body, { name });
      } catch {
        // Skip assets that fail to fetch; the batch should not fail entirely.
      }
    }

    await archive.finalize();
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found." });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Unexpected server error." });
  });

  return app;
}

function handleFetchError(err: unknown, res: Response) {
  if (err instanceof UnsafeUrlError) {
    res.status(400).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error.";
  if (/timed out/i.test(message)) {
    res.status(504).json({ error: "The request timed out." });
    return;
  }
  res.status(502).json({ error: `Could not reach the site: ${message}` });
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\w.\- ]/g, "_").slice(0, 150) || "download";
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string; contentType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) throw new Error("Invalid data URL.");
  const contentType = match[1]!;
  const buffer = Buffer.from(match[2]!, "base64");
  const ext = extensionForContentType(contentType) ?? "bin";
  return { buffer, ext, contentType };
}

function streamDataUrl(dataUrl: string, filename: string, res: Response) {
  try {
    const { buffer, contentType } = decodeDataUrl(dataUrl);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeHeaderValue(filename)}"`);
    res.send(buffer);
  } catch {
    res.status(400).json({ error: "Invalid embedded asset." });
  }
}

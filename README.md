# SOAD Product Grabber

Paste a product page URL. Get back the highest-quality **original** product
images and the site's brand logo, previewed in the browser and downloadable
individually or as a single ZIP.

That is the entire scope of this tool. It does not generate, upscale,
describe, price, or categorize anything — it only finds and retrieves
assets that already exist on the page.

## What it does

1. You paste a product page URL and click **Grab Assets**.
2. The server fetches the page (with SSRF protections, see below) and runs a
   static extraction pipeline over the HTML to find:
   - Every genuine product photo, deduplicated so that only the
     highest-resolution version of each photo is kept.
   - The site's primary brand/header logo (SVG preferred over raster).
3. Results are shown in a gallery with dimensions/format and a per-asset
   download button, plus a **Download All (.zip)** button.

## Installation

Requires Node.js 18.17+ (Node 20/22 recommended).

```bash
npm install
```

## Local development

```bash
npm run dev        # starts the server with auto-reload on http://localhost:3000
```

Other scripts:

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # vitest (unit + fixture + API tests)
npm run build        # compiles src/ -> dist/
npm start            # runs the compiled server (dist/server.js)
```

## Architecture

Deliberately simple: an Express server plus a static, dependency-free
frontend. No database, no accounts, no build step for the client.

```
public/            vanilla HTML/CSS/JS frontend (no framework, no build step)
src/
  server.ts        process entrypoint
  app.ts           Express app: routes + wiring
  lib/
    ssrf.ts         URL/IP validation (SSRF protection)
    safeFetch.ts    SSRF-safe HTTP client (DNS pinning, redirect re-validation)
    srcset.ts       srcset parsing + highest-resolution selection
    imageUrl.ts     CDN resize-suffix / dimension-hint parsing
    dedupe.ts       same-image-different-resolution deduplication
    filename.ts     safe filename derivation for downloads
    contentType.ts  content-type <-> extension mapping
    types.ts        shared types
    extract/
      index.ts       extraction pipeline orchestrator
      jsonld.ts       schema.org Product/Organization JSON-LD
      opengraph.ts    og:image / og:logo fallback
      shopify.ts      Shopify embedded product JSON (ProductJson-*)
      woocommerce.ts  WooCommerce gallery markup (data-large_image)
      domImages.ts    generic <img>/<picture>/srcset/lazy-load/background-image scanning
      logo.ts         brand logo detection (structured data + DOM heuristics)
      filters.ts      decorative/tracking/icon filtering heuristics
tests/               vitest unit tests + HTML fixtures
```

### Request flow

`POST /api/extract { url }` → `safeFetch` (SSRF-checked) fetches the HTML →
`extractAssets(html, finalUrl)` runs every extraction method and returns
`{ images[], logo, warnings[] }` → the frontend renders the gallery.

Downloads never expose an open proxy: `GET /api/download?url=...` and
`POST /api/download-all` re-validate every URL through the same SSRF checks
before fetching, and only forward responses whose `Content-Type` is
`image/*`.

### Why no headless browser by default

The brief asks for browser automation (e.g. Playwright) only when static
extraction is insufficient for JavaScript-rendered galleries. This first
version implements the complete static pipeline (JSON-LD, OpenGraph,
platform-specific embedded JSON, and full DOM/srcset/lazy-load scanning),
which covers the overwhelming majority of product pages, including
JS-rendered ones that still embed the product JSON server-side (Shopify,
most WooCommerce/WordPress themes). The extraction engine is structured
(`lib/extract/*`) so a Playwright-based renderer can be added later as one
more extractor, invoked only as a fallback when the static pipeline finds
too few images, without launching a browser on every request.

## Supported extraction methods

- **JSON-LD** — `schema.org/Product.image` and `Organization.logo` /
  `Product.brand`.
- **OpenGraph / Twitter Card** — `og:image`, `og:image:secure_url`,
  `twitter:image`, `og:logo` (fallback signal).
- **Shopify** — embedded product JSON (`<script id="ProductJson-...">` /
  `data-product-json`), which lists every gallery image regardless of
  lazy-loading or carousel state.
- **WooCommerce** — `.woocommerce-product-gallery` markup, in particular the
  `data-large_image` / `data-large_image_width` / `data-large_image_height`
  attributes and lightbox `<a href="...">` links, which give the original
  (non-cropped) image directly instead of the `-300x300` thumbnail.
- **Generic DOM scanning** — `<img src>`, `srcset`, `<picture><source>`,
  common lazy-load attributes (`data-src`, `data-original`, `data-lazy-src`,
  `data-zoom-image`, `data-hi-res`, `data-srcset`), gallery `<a href>`
  lightbox links, and `background-image` CSS on elements inside a
  recognizable gallery container.
- **Responsive image resolution** — `srcset`/`<picture>` width and density
  descriptors are parsed and the highest-resolution entry is kept.
- **Deduplication** — CDN resize-suffix patterns (Shopify `_800x800`,
  WordPress `-300x300`, `@2x`) are recognized so that multiple resolutions
  of the same photo collapse into a single result at the largest resolution
  *that was actually observed on the page* — the tool never fabricates a
  guessed "original" URL that wasn't linked anywhere, since that could
  point at a resize that doesn't exist or silently be a smaller image.
- **Filtering** — known icon/sprite/payment-badge/social-icon/tracking-pixel
  filename and hostname patterns are excluded, images inside
  header/footer/nav/related-products/recommendation containers are
  excluded unless they are also inside a recognized gallery container, and
  images below a minimum pixel-dimension threshold are dropped.
- **Logo detection** — inline `<svg>` in the header (captured as
  self-contained markup, no extra request needed), `<img>` with a
  logo-hinting class/id/alt inside the header/nav/branding region, and
  `.logo`/`.site-logo`/`.brand-logo` wrapper classes anywhere on the page.
  Payment/badge/award icons that also happen to contain "logo" in their
  class name are explicitly excluded.

## Security: SSRF protections

Because the app fetches arbitrary user-supplied URLs, `src/lib/ssrf.ts` and
`src/lib/safeFetch.ts` implement defense in depth:

- Only `http:`/`https:` schemes are accepted; everything else (`file:`,
  `ftp:`, `javascript:`, `gopher:`, ...) is rejected.
- `localhost` and `.local`/`.internal`/`.localdomain` hostnames are rejected
  outright.
- IP literals and every resolved DNS address are checked against the full
  set of non-public ranges: loopback, RFC1918 private ranges, link-local
  (including the `169.254.169.254` cloud metadata address), carrier-grade
  NAT, multicast/reserved, and the IPv6 equivalents (`::1`, `fc00::/7`,
  `fe80::/10`, IPv4-mapped addresses).
- DNS is resolved once and the resolved IP is pinned for the actual socket
  connection (via Node's `lookup` option), which prevents a DNS-rebinding
  attack where the hostname resolves to a public IP at validation time but
  a private IP at connection time.
- Redirects are followed manually (never automatically), and **every**
  redirect target is re-validated with the same checks before being
  followed, up to a small redirect limit.
- The download endpoints (`/api/download`, `/api/download-all`) apply the
  identical checks to every URL they fetch — they are not an open proxy:
  the response is only forwarded if its `Content-Type` is `image/*`, and
  response size is capped.
- Requests have timeouts and response-size caps to bound resource usage.

## Limitations

- **Static extraction only.** Product galleries that only render images via
  client-side JavaScript with no server-embedded data (no JSON-LD, no
  embedded product JSON, no server-rendered `<img>` tags) will not be
  found. A Playwright-based fallback extractor is a natural next step (see
  Architecture) but is not implemented in this first version, to avoid
  launching a browser on every request.
- **No verification fetch of every candidate.** The tool does not issue a
  `HEAD` request to confirm every discovered URL actually resolves before
  showing it in the gallery; a broken/expired CDN URL on the source page
  will show as a broken thumbnail.
- **Heuristic filtering.** Icon/logo/tracking exclusion and logo detection
  are pattern-based, not ML-based, so unusual page structures can produce
  false positives/negatives. The system is easy to extend (add a pattern or
  a new extractor in `lib/extract/`) as real-world sites are tested against
  it.
- **Real-site testing.** This implementation environment's outbound network
  access is restricted to package registries and does not permit fetching
  arbitrary external websites, so end-to-end extraction could not be
  exercised against live product pages during development. It was instead
  verified against realistic Shopify-style, WooCommerce-style, JSON-LD-only,
  and OpenGraph-only HTML fixtures (see `tests/fixtures/`) that reproduce
  the exact markup patterns each extractor targets. **Before relying on
  this in production, run it against a handful of real product pages from
  each platform you care about and adjust the heuristics in
  `src/lib/extract/` as needed.**
- **No queueing/rate limiting.** Suitable for personal/internal use as
  shipped; a public deployment should add per-IP rate limiting in front of
  `/api/extract` and `/api/download-all`.

## Deployment requirements

- Node.js 18.17+ runtime.
- No database or persistent storage required — the app is stateless.
- No environment variables are required; `PORT` (default `3000`) may be set
  to override the listen port.
- Outbound HTTPS/HTTP access to arbitrary public hosts is required (that is
  the app's entire purpose), while the SSRF protections above prevent it
  from being used to reach internal/private network targets.
- Run `npm run build && npm start` behind a reverse proxy (nginx, Caddy,
  the platform's own TLS termination, etc.) in production; the app itself
  serves plain HTTP.

## License / attribution for reused open-source code

The brief asked that these projects be inspected for useful extraction
techniques before implementation:

- https://github.com/myselfshravan/third-eye
- https://github.com/mralaminahamed/media-bulk-downloads
- https://github.com/zhaoheng588-tech/shopify-scout
- https://github.com/pixelhunter1/woocommerce-product-scrap

This development environment's outbound network access does not permit
fetching arbitrary GitHub repositories, so these projects could not
actually be cloned or read during implementation. **No code from them was
copied, adapted, or reused** — the extraction engine in `src/lib/extract/`
was written from scratch based on well-documented, publicly known platform
conventions (schema.org JSON-LD, OpenGraph, Shopify's `ProductJson`
script-tag convention, and WooCommerce's `data-large_image` gallery
markup). Consequently no third-party license notices are required here.
If those repositories are reviewed later and code from them is
incorporated, their license terms must be checked at that time and any
required attribution added to this section before merging.

All direct npm dependencies used (`express`, `cheerio`, `archiver`) are
used only via their public APIs, under their own MIT licenses; see
`node_modules/*/LICENSE` after `npm install`, or their respective npm
registry pages, for the full license text.

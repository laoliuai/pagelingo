# Web capture

`@pagelingo/web-capture` turns a bounded, selected HTML scope into an inert archived
snapshot, source-bound Web Reader IR, and bounded preview files. It performs no
network access, model calls, persistence, owner selection, or browser extension I/O.

The root entry uses pure data and parse5. It imports neither a DOM implementation
nor DOMPurify. The `/browser` entry supplies native DOMPurify; `/node` supplies
JSDOM with scripts and resource loading disabled. Readability runs only on a clone,
and `extractPublicArticle` rejects the main thread so callers must own a terminable
worker and enforce its deadline.

## Public interfaces

```ts
sanitizeSnapshot(input: SnapshotInput, environment: SnapshotEnvironment): SanitizedSnapshot
// SnapshotEnvironment = {
//   sanitizeHtml(html: string): string; // trusted DOMPurify capability
//   limits?: CaptureLimits;
//   resources?: readonly PendingCaptureResource[]; // replay context
// }
sanitizeBrowserSnapshot(input, limits?, resources?): SanitizedSnapshot // /browser
sanitizeNodeSnapshot(input, limits?, resources?): SanitizedSnapshot    // /node
extractPublicArticle(html: string, url: string, limits?): SanitizedSnapshot // /node, worker

normalizeCaptureUrl(url: string): string
captureContentFingerprint(snapshot, resources: readonly CaptureResource[],
  files?: readonly CaptureFile[]): Promise<string>
inspectImageResource(bytes: Uint8Array, file: CaptureFile,
  limits?: CaptureLimits): Promise<WebReaderAsset>
replayResourcesFromManifest(manifest: WebCaptureManifest): PendingCaptureResource[]

buildSnapshotPreviews(snapshot, resourceResolvedManifestDraft, limits?): Promise<{
  index: SnapshotPreviewIndex;
  files: Array<{ descriptor: CaptureFile; html: string }>;
  warnings: string[];
}>
resolveSnapshotAnchor(index, nodeId): { previewId: string; anchorId: string } | null
projectWebReader(snapshot, manifest, {
  manifestBytes: Uint8Array;
  assets: readonly WebReaderAsset[];
  limits?: CaptureLimits;
}): Promise<WebReaderIR>
validateWebGraph(ir: WebReaderIR): void
canonicalManifestBytes(value: unknown): Uint8Array
sha256(bytes: Uint8Array): Promise<string>
```

All optional limits are complete `CaptureLimits` objects, bounded by the shared
contract ceilings. Start with `{ ...defaultCaptureLimits, maxPreviewBlocks: 32 }`.
The canonical writer is optional: projection hashes the exact supplied manifest
bytes, after checking that they decode to the same strict manifest object.

## Publication order

1. Sanitize the selected scope. The returned HTML has stable `data-pl-node` IDs,
   `pl_<nodeId>` anchors, and `data-pl-resource` image placeholders. Raw HTML first
   passes a bounded, side-effect-free parser, so browser DOM parsing never sees
   source resource URLs. Inline styles are reduced to a small literal grammar;
   scripts, forms, hidden state, unknown active structures and hotlinks are removed.
2. Fetch pending resources in the caller's authorized transport. Inspect each image
   with `inspectImageResource`; archive its actual bytes. Record available and
   missing resources with explicit `role: 'image' | 'css'`, never guessed from URLs.
   CSS may be archived by collectors but is never executed by this package.
3. Create a strict manifest draft with real original/resource descriptors and empty
   `snapshots.previews` / `snapshots.nodeLocations`. Build previews, append returned
   file descriptors, and use the returned index in the final manifest. Persist each
   returned HTML string as UTF-8. Display `warnings` from this step: oversized units
   have no preview and must retain an original-download path; they are not truncated.
4. Serialize the final manifest once, then project using those exact bytes and the
   inspected image metadata. `assets[].id` equals its local `CaptureFile.id`; the
   server descriptor separately maps these IDs to stored asset UUIDs. Source block
   and node IDs derive from snapshot order, not the final manifest hash, avoiding a
   manifest/preview identity cycle.
5. Server replay uses `sanitizeNodeSnapshot({ html, url, scope }, limits,
   replayResourcesFromManifest(manifest))`, not Readability. The known-resource
   context preserves placeholder identities and missing-resource roles. Do not
   accept client translation HTML; downstream candidate replay uses SDK encoding,
   validation and decoding against the server-projected source.

Original `data-pl-source` wrappers are unwrapped before hidden-state removal, so
source, bilingual and translation-only extension modes archive the same source.
Mixed container text runs receive stable `data-pl-run` spans before node IDs are
assigned; each independently previewed run therefore has its own replayable anchor.
Required header groups are examined once per closure, all examined edges are
charged, and an oversized group stops expansion before HTML rendering.

Snapshots retain semantic tables and explicit header bindings, emphasis, links,
code, and source formulas. Explicit `$$...$$`, `\(...\)`, `\[...\]`, MathML TeX
annotations and `script[type="math/tex"]` become protected TeX input for the shared
renderer. Other supported SVG/MathML becomes the strict shared `SafeMathAst`.
Formula references are isolated per source instance and expansion is bounded.
Unknown formulas receive a visible fallback and a specific warning; no TeX is
inferred. Page-level language hints are conservative and no detector calls a model.

The image inspector verifies actual digest/length, encoded structure (including
JPEG frame/SOS headers, scan data and marker framing), dimensions,
GIF frame count and pixel ceilings for PNG/JPEG/WebP/GIF. It is **not a full codec
decoder**; consumers must report a subsequent decode failure as unavailable, not
claim an image rendered. Animated PNG/WebP and external SVG images are unsupported.
The native Chromium suite verifies accepted sample dimensions against real decoding.

Preview HTML remains an inert archive fragment. The reader must authenticate and
hash-check its files, resolve only registered image bytes to data URIs, and mount
one selected fragment in a sandbox without scripts, same-origin, forms or top
navigation, with a restrictive CSP. This package does not mount UI or grant network
access. Raw source links belong in the outer reader; source CSS is not a theme.

## Checks

From the repository root:

```sh
npm run build:web-capture
npm run test --workspace @pagelingo/web-capture
npm run typecheck --workspace @pagelingo/web-capture
npm run test:browser --workspace @pagelingo/web-capture
```

Browser checks use actual Chromium and bundle dependency inspection. No Python,
model downloads, keys, real API calls or external page requests are needed.

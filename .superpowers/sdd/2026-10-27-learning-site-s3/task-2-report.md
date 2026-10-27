# Task 2 report — Web capture

Status: DONE_WITH_CONCERNS (encoded-image inspection is structural, not a full codec decoder; consumers must expose decode failures).
Review base: `37240663b2ee3f25cb6a5878b6ad2ed05a13ac84`. Controller clarification commits `8ec0fca` and `7ae8d9e` remain intact.

## Result and exact interfaces

New package `@pagelingo/web-capture@0.1.0`, Node 24.13 verified. Root imports pure data/parse5, no DOMPurify/JSDOM/Node runtime modules; browser uses native DOMPurify without JSDOM; node uses JSDOM without scripts/resources and Readability on a document clone. `extractPublicArticle` requires a terminable worker, enforced by `isMainThread`; caller owns deadline/termination.

- `sanitizeSnapshot(input: SnapshotInput, environment: SnapshotEnvironment): SanitizedSnapshot`
- `SnapshotEnvironment = { sanitizeHtml(html: string): string; limits?: CaptureLimits; resources?: readonly PendingCaptureResource[] }`
- `/browser`: `sanitizeBrowserSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[]): SanitizedSnapshot`
- `/node`: `sanitizeNodeSnapshot(input: SnapshotInput, limits?: CaptureLimits, resources?: readonly PendingCaptureResource[]): SanitizedSnapshot` — server revalidation entry, no Readability.
- `/node`: `extractPublicArticle(html: string, url: string, limits?: CaptureLimits): SanitizedSnapshot`
- `normalizeCaptureUrl(url: string): string`
- `captureContentFingerprint(snapshot: SanitizedSnapshot, resources: readonly CaptureResource[], files: readonly CaptureFile[] = []): Promise<string>`; available resources require their actual descriptors.
- `inspectImageResource(bytes: Uint8Array, file: CaptureFile, limits?: CaptureLimits): Promise<WebReaderAsset>`; ID equals local CaptureFile ID.
- `replayResourcesFromManifest(manifest: WebCaptureManifest): PendingCaptureResource[]`
- `buildSnapshotPreviews(snapshot: SanitizedSnapshot, resourceResolvedManifestDraft: WebCaptureManifest, limits?: CaptureLimits): Promise<SnapshotPreviewBuild>`
- `SnapshotPreviewBuild = { index: SnapshotPreviewIndex; files: Array<{ descriptor: CaptureFile; html: string }>; warnings: string[] }`
- `resolveSnapshotAnchor(index: SnapshotPreviewIndex, nodeId: string): { previewId: string; anchorId: string } | null`
- `projectWebReader(snapshot: SanitizedSnapshot, manifest: WebCaptureManifest, options: { manifestBytes: Uint8Array; assets: readonly WebReaderAsset[]; limits?: CaptureLimits }): Promise<WebReaderIR>`
- `validateWebGraph(ir: WebReaderIR): void`; `canonicalManifestBytes(value: unknown): Uint8Array`; `sha256(bytes: Uint8Array): Promise<string>`.

## Decisions and handoffs

R7: draft includes actual original/resource descriptors and empty preview index. Generate preview HTML/descriptors, append them and index to final manifest, serialize once, then project. Source/block IDs depend on sanitized source order, never final manifest SHA. Manifest source SHA hashes the exact supplied immutable byte copy after strict object agreement, not a substituted canonical serialization. The canonical writer is optional. Assets must come from actual-byte inspection; later storage maps their local file IDs to asset UUIDs.

R8: replay context only resolves registered resource placeholders. Required `CaptureResource.role: 'image' | 'css'` now survives available and missing states; available roles must match file roles. Updated portable web-capture/web-api schemas and Zod/AJV parity coverage. Server can reconstruct context without extension guessing. Repeated Node sanitization preserves HTML, node IDs, image IDs, SVG references, scope and warnings exactly.

Raw HTML is bounded by bytes/nodes/depth in parse5 before native DOM sees it. Source network attributes are replaced before two DOMPurify passes. Final inert structure/anchors/resource closures are checked again by downstream projection/preview APIs, including forged DTO regressions. Source forms, hidden state, events, CSS URLs/imports/positioning, unsafe namespaces and external SVG references cannot reach previews. Unknown content gives explicit warnings/fallbacks.

SafeMath uses the strict shared attribute/AST schemas unchanged. SVG IDs are isolated per fragment; expanded `<use>` traversal is capped, including acyclic doubling DAGs. Malicious expansion is removed by sanitization and separately rejected by preview validation. Explicit TeX delimiters/annotations/math scripts remain source-bound protected input for the existing KaTeX rendering path; no TeX inference. SDK `encodeBlock` validates projected inline bindings; no copied protection algorithm.

One semantic traversal supplies IR and preview IDs, preserving tables, spans/scopes, explicit header relationships, repeated paragraphs, links, emphasis, code and formula bindings. Previews preserve ancestors, table captions/theads and explicit headers; context semantic blocks and unique image files count against their actual budgets. Oversized units emit a warning and retain original-download responsibility; they are never truncated. Preview construction also caps total files/bytes and closure work. Node lookup uses own-property checks for prototype-sensitive names.

Pins: DOMPurify 3.4.17, Readability 0.6.0, JSDOM 29.1.1, @types/jsdom 30.0.0, parse5 8.0.1. No model/API/Python calls. No original data or frozen S2 source/assets/generator/fixture edits. Current renderer catalog was regenerated because the contracts source hash changed.

## RED / GREEN evidence

- Initial sanitizer/fingerprint run: `npx vitest run packages/web-capture/tests/sanitize.test.ts packages/web-capture/tests/fingerprint.test.ts` — 6 expected assertion failures (active content, duplicate SVG IDs, CSS/state, budgets, tracker retention, missing fingerprint); then package run 6/6 GREEN.
- `npm run test --workspace @pagelingo/web-capture -- --run tests/resources.test.ts` — actual-byte/digest and truncation/frame RED, then GREEN. Additional WebP extended-canvas regression RED (accepted huge canvas), then GREEN.
- Projector/preview initial focused run — 4 expected RED assertions (table projection, actual manifest SHA, preview splitting, oversized omission), then GREEN.
- Worker article test RED lost image resource through Readability; fixed with inert placeholder image on its clone and pure-data resource rehydration before re-sanitization.
- Replay RED changed image bindings/SVG IDs; GREEN exact snapshot equality with R8 context.
- TeX, standalone formatting/multiple formula, header-ID mapping, mutable manifest-byte, forged active HTML and expanded SVG preview tests each observed RED before targeted fixes.
- Table-header closure RED omitted required header without charging its block; GREEN rejects under-budget cell previews and preserves header with a two-block budget.
- Contracts role RED accepted missing role; GREEN requires explicit role, preserves missing CSS, and rejects resource/file mismatch. Portable schema parity updated.

## Final verification

- `npm test` — exit 0, 727 tests / 59 files across 9 workspace suites: service 107, extension 90, PDF CLI 108, assistant SDK 31, bundle 154, contracts 92, renderer 31, translation SDK 89, capture 25. Includes compatibility/frozen-bundle coverage.
- `npm run typecheck --workspace @pagelingo/web-capture` — exit 0 after final source fixes.
- `npm run typecheck --workspace @pagelingo/document-contracts` — exit 0.
- `npm run build:web-capture`, then final `npm run build --workspace @pagelingo/web-capture` — exit 0.
- `npm run test:browser --workspace @pagelingo/web-capture` — 3/3 actual Chromium tests, zero unexpected source requests/scripts, Node/browser identical DTOs, browser/root bundle import boundaries, native PNG/JPEG/WebP/GIF decode dimensions. Playwright emits the pre-existing FORCE_COLOR/NO_COLOR environment warning; no test failures.
- `git diff --check` — clean.

Read-only saved-blog smoke (no network/resource downloads): agent article 193 blocks / 13 images / 2 previews; RL overview 300 blocks / 38 display-TeX blocks / 1 table / 13 images / 3 previews. Missing images and unsupported page chrome produced explicit partial warnings. Inputs remain ignored under `data/web-s3/live/public-blog-XHAhox`; no third-party HTML committed.

## Files and limitations

New focused package source, unit/browser tests, configs and README; root build/test scripts/lock; narrow contracts role + schema/parity changes; current renderer catalog only. The README documents publication/replay order and caller-owned iframe isolation, resource acquisition, deadlines, and file persistence.

The image inspector checks actual SHA/length, encoded framing and dimension/frame budgets, not complete compressed-pixel decoding. Animated PNG/WebP and external SVG images are deliberately unsupported. Display callers must preserve missing-resource/decode warnings. CSS acquisition, browser scope detection, storage/auth/transport, iframe mounting, reader chunk/window behavior and actual translation execution belong to subsequent tasks. No merge/push performed.

## Fix round 1 — review I1–I4

FIX_BASE: `64e626a4f1059675bbec1a57f6190f484f860318`. All four Important findings fixed; public signatures/DTOs unchanged.

- I1: unwrap the extension's original-source spans on the private parse tree before hidden-content removal. Source, bilingual and translation-only modes now yield identical source HTML/IDs/warnings, and replay is unchanged. Root text anchoring runs after unwrapping so capturing the hidden wrapper itself also retains a valid scope anchor. Covered by `sanitize.test.ts` and actual live-mode browser checks that assert the page itself remains unchanged.
- I2: canonicalize independently splittable mixed-content runs into stable `data-pl-run` spans before final node IDs are assigned. Shared structural rules make projector and preview consume those exact source anchors; replay preserves them and block kinds inherit their source container. `projector.test.ts` verifies distinct stable refs; `snapshot-previews.test.ts` and Chromium verify every block resolves to a preview containing its own quote/anchor and block ID.
- I3: charge context-index construction, target discovery and each examined closure edge. Cache per-node context targets, expand each target once per closure, and reject oversized groups/closures before enumerating/rendering all their material. Reuse a rejected single-unit candidate instead of rebuilding it. A bounded 40-header operation regression now passes; the 40/80-header read-only probes used 437/596 `Set.has` calls versus the review's 152,037/1,116,717, while preserving zero previews and one warning per omitted unit (41/81).
- I4: extract readable JPEG framing validation into `src/jpeg.ts`. Validate frame/component headers, SOS length/selectors/parameters, nonempty scan data, stuffing/restart/next-marker transitions and terminal EOI, including progressive scan framing. No pixel decoder added. `resources.test.ts` rejects missing/truncated SOS/scan/marker inputs and preserves dimensions/digest for a 762-byte JPEG generated locally by Chromium from a 7×5 solid-color canvas. The browser's real JPEG decode check also still passes.

RED: focused sanitizer/projector/preview/resources run produced 8 expected assertion failures across I1–I4; the exact hidden translation-only shape separately returned an empty paragraph. The 40-header regression observed 152,037 calls before the change. Four malformed JPEG payloads (including `ffd8ffc0000b080001000101011100ffdaffd9`) were incorrectly accepted before the JPEG fix. The standalone hidden-wrapper scope regression also observed missing node IDs before moving root-text anchoring.

GREEN/final checks, all exit 0 after the final source change:

- `npm run test --workspace @pagelingo/web-capture` — 36 tests / 7 files passed.
- `npm run typecheck --workspace @pagelingo/web-capture` — passed.
- `npm run build --workspace @pagelingo/web-capture` — passed.
- `npm run test:browser --workspace @pagelingo/web-capture` — 5 actual Chromium tests passed, including live extension modes, every mixed-content anchor, network/script absence, bundle boundaries and raster decode dimensions.
- `git diff --check` — clean. Self-review checked the four changed routines, shared structural/attribute handoff, JPEG byte cursor progress and generated fixture provenance.

Only capture package source/tests/docs and this report changed. Contracts, renderer catalog inputs, fixed S2 assets/generators/fixtures and original inputs are untouched, so no catalog regeneration or repeat of the previously passing 727-test workspace/compatibility suite was needed. No live network, models or subagents used. Existing FORCE_COLOR/NO_COLOR environment noise remains; M1/M2 cleanup outside the touched routines was deferred as instructed. Full compressed-pixel decoding remains the documented caller-owned limitation.

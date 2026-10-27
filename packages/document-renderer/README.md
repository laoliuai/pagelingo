# Document renderer

Pure ESM Reader projection, SDK replay, bounded chunks and trusted HTML for both
site readers and offline bundles. The public entry has no DOM, filesystem or
database access. Build with `npm run build:renderer` from the repository root.

`toTranslationDocument(ir, selectionBlockIds, sourceLanguage?)` is the sole SDK
projection. The selection follows IR text reading order. The optional language
is saved on the translation snapshot and passed identically during replay.
`validateReaderTranslation(ir, translation)` returns `ValidatedTranslation` with
SDK-decoded blocks and explicit source-only reasons. It checks supported SDK /
prompt / protection versions, exact `planUnits` identities, `validateStructure`
and complete-block restoration with `decodeTranslation`. Complete cached blocks
can cover unit results and can supersede a zero-unit planning failure. When the
actual plan contains units, every unit must still be present.

The byte adapter must verify actual PDF / IR / glossary / asset hashes before
calling replay. The pure renderer compares source and parse identities; it does
not implement another JSON hashing convention.

`buildReader(ir, translation)` validates the complete Reader graph, including
WHATWG links, then returns `{index, chunks}`. Chunks split at the first source
page and at 128 blocks / 256 KiB JSON. A single oversized block occupies a chunk
alone and remains subject to Reader source byte ceilings. Ancestors reopen with
continued ordered-list numbers, and cross-page blocks appear once.

`renderChunk(chunk, {mode, resolveAsset})` produces branded `TrustedReaderHtml`,
block IDs and warnings. The resolver is application-owned and maps logical IDs
to trusted asset locations. Text is escaped and bindings supply all presentation.
KaTeX uses `trust:false`, `maxExpand:1000`, `maxSize:20`, `throwOnError:true` and
fresh macros. Before KaTeX allocation, formulas over 2,048 UTF-16 code units,
brace nesting over 32, or macro definitions / expansion primitives fall back to
escaped LaTeX. This display complexity budget leaves the IR's 16 KiB LaTeX
ceiling intact. Aggregate output stays within 4 MiB / 16,000 elements; complex
text formatting can similarly fall back to readable text.

`createStaticFilePlan(build, {title, originalFilename})` returns:

- `rendererVersion`, `rendererSha256`: map to manifest renderer `version` and
  `codeSha256`.
- `generatedFiles`: a repeatable, lazy `Iterable<{path, mediaType, content}>`.
  `content` is UTF-8 text. Each iteration yields `render/index.html`, then
  `render/data/index.js`, then one `render/data/c_000001.js` registration per
  chunk. It never prebuilds whole-book HTML. Index registration contains
  `{metadata,index}`; each chunk registration contains `{chunk,source,translation}`
  with the latter two being `RenderedChunk` results. JSON escapes `<`, `&`, U+2028
  and U+2029. Local classic scripts work without `file://` fetch or module CORS.
- `trustedAssets`: immutable `{path,mediaType,bytes,sha256,source}` descriptors.
  `source` is `{package,path}` relative to either installed
  `@pagelingo/document-renderer` or pinned `katex`; it contains no machine path.
  The Node adapter resolves package roots, reads each source, verifies byte count
  and SHA-256, and streams it to its output path. Verify uploaded copies against
  these trusted bytes; uploaded code never executes in the site.

The catalog includes local runtime / CSS, KaTeX CSS, every font format referenced
by that CSS, and the KaTeX license. Reader images are separately supplied by the
IR asset descriptors. PDF / IR / translation / provenance belong to the bundle
adapter. Generated data is rebuilt and compared on import, rather than trusted
from an uploaded self-declared code hash. Adapters must accumulate actual UTF-8
bytes and file counts while iterating, enforcing bundle limits.

The build-time catalog script hashes package-relative POSIX paths, normalized
source text and actual trusted asset bytes in stable code-unit order. The source
hash includes renderer, contracts and SDK sources. It excludes its own generated
catalog. Commit regenerated catalog changes with source changes. Runtime and
font byte I/O is deliberately outside the portable entry.

`npm run test --workspace @pagelingo/document-renderer` runs local unit fixtures.
After a build, `node packages/document-renderer/tests/offline-smoke.mjs` performs
an optional Chromium `file://` smoke using the repository's existing Playwright
installation. It creates and removes a temporary bundle, contacts no API and
checks the three-chunk DOM / script window and keyboard divider.

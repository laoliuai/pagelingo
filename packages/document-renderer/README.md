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

## S2 delivery acceptance

See [S2 validation](../../docs/learning-site-s2-validation.md) and
[reader workflow](../../docs/pdf-reader-workflow.md) for explicit local corpus inputs,
offline resource checks, capacity measurements and upgrade/restart scope.
Default checks use mocks and do not install Python/models or call paid APIs.

Offline status keeps parse/translation/mock labels and a warning count. Native
collapsed details preserve every diagnostic as text, with keyboard access and a
20vh scroll region when expanded; per-chunk notices remain visible. The explicit
offline smoke checks hundreds of warnings without filling the initial viewport.

## Published S2 compatibility

`resolveTrustedCatalog({version, codeSha256})` accepts the current catalog and
exactly the published S2 identity `0.1.0` /
`3bfbbf4ce02a787185643792d617f80cb960261d108ad0ce224b0909ea4d47c3`.
Unknown version/hash pairs throw. Pass the result as the optional third argument
to `createStaticFilePlan(build, metadata, catalog)` when validating a historical
bundle. Omitting it continues to produce the current renderer version.

The S2 catalog retains its own static HTML, chunk HTML, math and style generation
under `src/compat/s2-0.1.0/`. Its asset descriptors point to frozen package files
under `compat/s2-0.1.0/`, including KaTeX CSS, fonts and license. These bytes and
the immutable own-content ZIP under `document-bundle/tests/fixtures/s2-final/`
are compatibility baselines; never regenerate them from current renderer code.
Validation still checks every generated file and every pinned asset, including
installed asset bytes. A matching manifest hash does not authorize changed code.
The pinned KaTeX rendering dependency is part of this contract; future dependency
upgrades must continue passing the fixed ZIP and published corpus checks.

After `npm run build:bundle`, run
`node scripts/check-s2-compat.mjs --input <file-or-dir> --output <new-dir>`
from the repository root. The command recursively finds ZIP archives, validates
them in place without parsing or rewriting, and writes `report.json` with each
archive's before/after SHA-256, manifest identity and source hashes. The output
must be a new directory outside a directory input. Original S2 corpus inputs
remain read-only; place reports in a separate run directory.

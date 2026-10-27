# Document bundle (Node)

`@pagelingo/document-bundle` 0.1.0 validates Reader v1 ZIPs without extraction,
replays the public SDK through the renderer, and writes immutable complete ZIPs.
It has no database, authentication, browser, Python, or model dependencies.

```ts
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle, writeBundle } from '@pagelingo/document-bundle';
const source = createArchiveFileSource('input.zip', defaultBundleLimits, signal);
const validated = await validateBundle(source, { limits: defaultBundleLimits, signal });
await writeBundle(source, 'new-output.zip', { limits: defaultBundleLimits, signal });
```

`readArchive(path, limits, signal?)` yields `{path, bytes, content}`. Consume
`content` fully exactly once before advancing the archive iterator. Breaking
iteration closes its active stream and ZIP. There is no extraction API and no
entry path becomes a host write path.

`BundleFileSource` has `list(): Promise<FileInfo[]>` and
`read(path): AsyncIterable<Uint8Array>`. Lists and reads must be repeatable.
`createArchiveFileSource` caches only central-directory metadata and opens a
fresh ZIP per read. `createDirectoryFileSource` rejects all symlinks (including
root ancestors), pins directories via file descriptors, and reads bounded
streams. This race-safe local directory adapter currently requires Linux
`/proc/self/fd`; other platforms fail closed. The current Node validator also
uses this local adapter for trusted package assets, so complete CLI/bundle
processing in this implementation supports Linux.
The ZIP format, generic FileSource protocol and browser reader remain portable.
Neither adapter leaves handles open between calls. Pass the same abort signal
to adapters and operations.
`createMemoryFileSource` copies small generated/fixture inputs; use directory or
archive sources for large documents. Custom sources must close resources when
an iterator is returned and honor their own cancellation/deadline during I/O.
Validation counts actual bytes regardless of source declarations.

`ValidatedBundle` contains manifest, packageId, canonical manifestSha256, IR,
translation, ReaderBuild, and verified manifest file metadata. It has no host
path or owner. Treat the result as immutable; the writer independently validates
and rehashes its second input pass to detect changed files.

File SHA-256 values always hash actual bytes, including IR, translation,
`provenance/input-manifest.json`, and `provenance/parser-config.json`.
`translation.glossarySha256` uses SDK `contentHash(glossary)`; package identity
uses SDK `contentHash(manifest)`. Pretty-printing the manifest or recompressing a
ZIP preserves package identity. Pretty-printing any listed JSON file changes
its byte identity and requires new matching bindings. `serializeBundleJson`
returns UTF-8 SDK `stableJson` without a BOM or newline as a shared producer
convention. Preserve original P0 manifest bytes; do not silently serialize or
redact an original and claim its old digest.

`deriveParseId(sourceSha256,inputManifestSha256,projectorVersion,configSha256)`
implements the exact Reader v1 concatenation. Block/node identity production is
the projector's responsibility; bundle validation checks graph identity,
uniqueness and replay, and does not claim to reconstruct absent raw pointers.

Required provenance: the original safe input manifest and a deliberately curated
parser configuration. `parseParserConfig` accepts only the versioned wrapper
`{schemaVersion:'pagelingo-parser-config/1',parser:{name,version},options}`.
Parser name/version must equal IR. All options are optional; accepted keys are
`tier` (`basic|standard|enhanced`), `smallBackend`, `device`, `parseMode`
(restricted ASCII tokens), `imageAnalysis`, `vlm` (booleans), `pageRange`
(`all` or comma-separated nonnegative integer/range selectors), and
`threadsRequested`, `onnxIntraOpThreadsRequested`, `onnxInterOpThreadsRequested`
(positive safe integers). Producers select these fields before writing and
hashing; never spread a runtime/Provider configuration. Absolute path values,
URLs, credentials and unknown keys cannot enter this allowlist. Opaque raw/layout
provenance is archived and hashed, never executed or asserted secret-free.
Preserve originals locally and record any sanitized-copy lineage upstream.
Source/IR text is never regex-stripped, so absolute-path examples remain intact.

If `provenance/model-lock.json` or `provenance/python-lock.txt` is present, its
byte digest must equal the corresponding non-null IR digest. A recorded non-null
digest without bundled bytes requires the exact IR warning
`upstream-model-lock-not-bundled` or `upstream-python-lock-not-bundled`. Missing
locks are never fetched or fabricated. Nullable upstream versions remain null.

Every uploaded executable/style/font byte must match the local trusted renderer
catalog, whose installed bytes are independently hashed. Generated HTML/data
files must match rebuilding from validated inputs; no uploaded code executes.
Images require PNG/JPEG/WebP signatures, container bounds and matching actual
dimensions; PNG chunks also require CRCs. This is bounded container admission,
not a full image/PDF decoder. PDF recognition matches S1: `%PDF-` in the first
1024 bytes, followed by complete byte/hash checking.

Validation enforces a five-minute monotonic deadline and yields around each
bounded synchronous renderer operation. A single synchronous operation cannot be
preempted mid-call; service-level execution isolation belongs to the service
adapter. JSON/IR/file/renderer limits bound the work. Memory is bounded by retained
IR/translation/build, manifest/file metadata, one collected JSON/image file and
one generated static file, rather than the expanded archive size. Opaque large
provenance and PDFs are streamed.

`writeBundle` uses a private 0700 staging directory and 0600 ZIP, streaming
compression and compressed/expanded byte counters. It fsyncs before publishing
with an atomic no-replace hard link, and removes staging files on abort/failure.
It never overwrites a destination, including concurrent writers. The target
parent must exist; staging and final output share its filesystem.

`BundleError.code` is stable and its message contains no host paths or keys:
`INVALID_BUNDLE`, `BUNDLE_TOO_LARGE`, `BUNDLE_MISSING_RESOURCE`, `BUNDLE_ABORTED`,
`BUNDLE_DESTINATION_EXISTS`. Structural limit overrides may only tighten the
contract ceilings; other byte budgets follow the contracts package. This module
never reads environment variables. The service supplies validated runtime limits.

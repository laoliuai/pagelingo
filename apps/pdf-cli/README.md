# Local PDF projection

This private Node 24+ workspace projects verified MinerU P0 runs and legacy
semantic previews into Reader IR and provides durable local SDK translation.
It exports verified self-contained reader bundles. It does not download models or install Python. Local processing and the bundle directory
adapter use Linux as the supported platform.

Build dependencies first with `npm run build:bundle`, then
`npm run build --workspace @pagelingo/pdf-cli`. Run:

```sh
node apps/pdf-cli/dist/cli.js \
  --source /path/to/source.pdf --run-dir /path/to/new-run \
  --p0-run /path/to/existing-p0 --preview /path/to/existing-preview \
  --python /path/to/prepared/python
```

`--p0-run` and `--preview` are optional. Without a P0 run, provide `--model-dir`
and optionally `--pages` (the parser's 1-based `all` or `1,3-5` selection).
Without a preview, the existing exporter creates a new preview/archive under the
new run. Supply `--katex` pointing to the **prepared KaTeX 0.19.0 package** with
its parent `integrity.json`, or use the prepared repository directories under
`data/pdf-p0/render-deps`. If missing, the CLI prints the explicit preparation
command; it never downloads on your behalf. Use the existing parser setup/model
preparation commands separately. New renderer KaTeX 0.19.1 is unrelated to this
legacy exporter requirement.

The CLI accepts preview directories in versions 0.5 and 0.6, after manifest
verification. Preserve manually repaired final previews and pass them explicitly.
Archive extraction is not provided by this command; extract a trusted historical
archive into a new location first. Docling and translated legacy previews are
explicitly unsupported. Existing source runs and previews are read-only inputs.

## Local continuation interface

The public package exports `processPdf(options, deps?)`, `adaptLegacyPreview`,
`detectLanguage`, `verifyP0Run`, `verifyPreview`, and associated local types.
`ProcessDependencies` permits a subprocess or inspection adapter for tests, and an
AbortSignal. SIGINT cancels the owned subprocess group and checkpoints failure or
cancellation. A nonzero parser exit still admits a manifest-valid partial run;
a failed run never becomes a consumable Reader IR.

`processPdf` requires a new `runDir` and returns a `LocalRun`, also written to
`config.json` using an atomic rename. `workflowId` is a UUID; `sourceSha256`,
`configSha256`, `readerIrSha256`, and `parseId` identify the immutable stages.
All `paths` are relative to `runDir`; external reused parser/preview directories
are represented by null. Downstream tasks reopen:

- `source.pdf`, `source-ir.json`, and `inspection.json`;
- `provenance/input-manifest.json` (original P0 manifest bytes) and the strict,
  canonical `provenance/parser-config.json`;
- `provenance/raw.json`, `provenance/source-layout.json`, selected raw assets,
  semantic page HTML (opaque evidence, never reader code), and available lock files;
- `provenance/source-bindings.json` for per-block semantic/raw/layout pointers;
- `provenance/copy-ledger.json` for original/projected hashes, filename mappings,
  field pointers and `original` versus `sanitized-copy` modes;
- `assets/` for the exact image bytes admitted by the shared bundle image inspector.

Only `stage: ready` with `status: complete | partial` is consumable. The formal IR
is exclusively created once; subsequent translation/export must never rewrite
it. `translationStatus` is only `pending` or `not-required`; no old
`translated:false` flag can produce a completed translation. Full bundle export
must also require `exportReady: true` and no `exportBlockers`. Unknown runtime
path/sensitive fields are reported by JSON pointer and block full export; no
blanket replacement is applied to body text such as `/usr/bin/python`.

The parse projector identity is
`pagelingo-legacy-preview/1+<verified preview manifest SHA-256>`. It participates
in the shared `deriveParseId` formula. Changing output directories or workflow
UUIDs leaves IDs stable; a verified manual preview repair changes parse identity.
Repeated text has separate IDs derived from source location and structural path.

Source-layout bboxes are already normalized to the displayed CropBox. They are
never rotated again. Geometry must agree with the independent PDF inspection
within 0.02 points; conflicting/missing evidence and repaired crops use page-only
references with warnings. Python inspection derives canonical dimensions and
matrices from original boxes, retaining raw CropBox evidence. Unsupported visible
structures remain protected source-only content with warnings; this does not
claim a generic adapter for arbitrary HTML or every future legacy version.

## Verification

`npm run test --workspace @pagelingo/pdf-cli` and its `typecheck` script use owned
fixtures and simulated subprocesses. They do not invoke Python or model APIs.
Explicit local Python checks use an already prepared interpreter:

```sh
/path/to/python -m unittest discover -s apps/pdf-cli/tests/python -v
```

## Durable local translation

The `translate` command consumes an existing `stage: ready`, complete/partial
run. It preserves `source.pdf`, `source-ir.json` and parser provenance byte for
byte. Linux and `/usr/bin/flock` are required; no helper is installed automatically.

```sh
node apps/pdf-cli/dist/cli.js translate --run-dir /path/to/run \
  --base-url http://localhost:11434/v1 --model YOUR_MODEL \
  --api-key-env PAGELINGO_LLM_API_KEY --selection auto
```

Set the named key in your own shell or secret manager. There is no `--api-key`
argument. The default env name is `PAGELINGO_LLM_API_KEY`. Provider transport is the
public SDK OpenAI-compatible transport: remote HTTPS, or HTTP on localhost,
127.0.0.1 and [::1]. URL userinfo, query parameters and fragments are rejected.
Raw endpoints, keys, headers and provider exception messages never enter job
metadata, SDK checkpoints, cache metadata, snapshots or CLI errors. Keys are not
passed to parser or lock subprocesses. Source text remains intact.

`auto` selects English text, including short headings which inherited a certain
English document language. Chinese quotations and blocks with no natural language
stay source-only. Mixed/uncertain text stays pending with
`MANUAL_SELECTION_REQUIRED`. `--selection all --source-language en` explicitly
selects all text without changing immutable IR language metadata; `none` preserves
source-only outcomes. Defaults are target `zh-CN`, profile `academic`, input/output
8192/8192 tokens, context 32768, four blocks per batch, reserve 512, and two SDK
retries. Override with `--target-language`, `--profile`, `--max-input-tokens`,
`--max-output-tokens`, `--context-window-tokens`, `--max-batch-blocks`,
`--reserve-tokens`, `--max-retries`, and optional `--glossary FILE` (SDK JSON glossary).

Use the same arguments with `--resume` after interruption, cancellation or a disk
failure. The SDK revalidates durable completed blocks/units and cache entries,
resumes only unfinished work, and preserves retry attempts and 429 cooldown.
Exhausted attempts stay failed; use `--new-job` for a fresh attempt budget. Any
configuration change requires `--new-job`. Existing immutable snapshots remain
available. Cache keys include actual model/mock generation kind, so test/mock
results cannot enter a live model job. API-injected providers default to `mock`;
the actual HTTP provider is `model`. Mock results demonstrate workflow behavior,
not translation quality.

Public `translateRun(options, deps?)` returns `LocalTranslationResult`, with
`job`, validated `snapshot: ReaderTranslation`, `jobPath`, `checkpointPath`,
`snapshotPath`, `snapshotSha256`, and stable `warnings`. Paths are relative to the
existing run. `loadTranslationRun(runDir)` reads the latest fully durable snapshot
and checks source PDF/IR byte identities, snapshot byte SHA-256 and SDK replay.
It never exposes partly written state as completed. The processing `config.json`
remains immutable after projection; its translationStatus is the original
projection decision. Consumers use this translation result's snapshot status.

SDK checkpoints still persist every transition. Full immutable snapshots publish
at creation, first successful block, and absolute 25%/50%/75% completion milestones,
then once at completion or cancellation. Crossed milestones coalesce into one
publication per batch; a completed batch uses the final publication. An
uninterrupted first execution therefore retains at most six full snapshots
regardless of batch count. Resume reads the last published completion count and does not repeat past
milestones. Each explicit cancelled/resumed invocation can retain one additional
terminal snapshot. Disk/epoch failure preserves the last published snapshot; the
raw SDK checkpoint may contain newer verified results which resume recovers.
No prior immutable snapshot is overwritten or deleted. Zero-selection jobs publish
one initial snapshot and perform no SDK translation.

- `translation/current.json` points to a job UUID.
- `translation/jobs/<jobId>/job.json` holds immutable safe configuration/hash.
- `translation/jobs/<jobId>/checkpoint.json` is the original SDK checkpoint,
  including raw protected text, attempts and cooldown; it is local recovery data,
  **never** a bundle export.
- `translation/jobs/<jobId>/snapshots/<snapshotId>.json` is immutable canonical
  `ReaderTranslation` JSON, using `serializeBundleJson` and actual byte SHA-256.
- `translation/jobs/<jobId>/latest.json` identifies the latest durable snapshot.
- `translation/cache/<SDK-key>.json` stores untrusted SDK cache entries; SDK replay
  rejects poisoned text. Different jobs in the same run can reuse verified entries.

Private directories are 0700, files 0600. Mutable state uses same-directory
exclusive temporary files, fsync, atomic rename, then directory fsync; immutable
files publish with an exclusive hard link. Parent-owned file descriptors retain
an exclusive kernel flock after the short-lived lock helper exits. Epoch checks
fence checkpoint, cache and snapshot publication; a process crash releases the
kernel lock without stale-PID recovery. Disk persistence failures become SDK
`CheckpointConflictError('TRANSLATION_DISK_WRITE_FAILED')`, preventing memory-only
success. The last durable snapshot stays readable. `AtomicWrite` overrides must
honor the supplied `beforePublish` fence; the dependency seam supports alternate
local writers and deterministic filesystem-failure tests.

The CLI returns sanitized JSON on stdout, fixed error codes on stderr, and exit
130 for cancellation (even if verified blocks make snapshot status partial).
Full export independently enforces the processing run's exportReady/exportBlockers.

## Offline bundle export

See the [complete four-command workflow](../../docs/pdf-reader-workflow.md) for
explicit Python/model/legacy KaTeX setup, resuming translation, pending exports,
limits and offline verification. Linux `/proc/self/fd` is required for bundle IO;
translation additionally requires `/usr/bin/flock` (util-linux).

```sh
npm run pdf:bundle -- --run /path/run --output /path/new-bundle --archive /path/new.zip
npm run pdf:verify -- /path/new.zip
```

Both output paths must be new and outside all source processing/P0/preview inputs.
Each export derives fresh package and translation snapshot UUIDs, preserving the
original immutable local snapshot. With no local translation job, export creates
an honest pending/not-required snapshot without provider configuration or requests.
Corrupt existing translation state is rejected. Read `render/index.html` from the
unpacked ZIP using `file://`; images, formulas, fonts and original PDF are local.

Public `exportBundle({runDir, outputDir, archivePath}, deps?)` returns
`Promise<BundleIdentity>` (`packageId`, canonical `manifestSha256`). Optional
`ExportDependencies` accepts validated `limits` and `signal`. It checks complete
resource closure and trusted static bytes with `validateBundle`, then uses the
shared streaming `writeBundle` for no-replace atomic ZIP publication. Failures
may leave a new debug directory and sanitized `export-failure.json`; no success
ZIP is published. `LocalExportError.code` is fixed and contains no host paths.
`createStaticFilePlan` remains the shared renderer's pure export/replay function.
Run `npm run test:pdf:offline` for the owned-fixture Chromium file:// ZIP check.

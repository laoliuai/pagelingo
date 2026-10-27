# Local PDF projection

This private Node 24+ workspace projects verified MinerU P0 runs and legacy
semantic previews into Reader IR. It does not translate, export bundles, download
models, or install Python. Local processing and the downstream bundle directory
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

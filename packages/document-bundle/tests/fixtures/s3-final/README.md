# Published S3 fixture

Own-content synthetic PDF/IR fixture frozen from commit `e042cd849d2e81632d7a9ac6e10c0a7a5be656c4` before source or version changes, using the released renderer 0.2.0 catalog `f856f4104ebcf8a90528faeb2f5bafc01dc3745468b6f53253ad0e420bcb8a73`. Generated once from the existing bundle fixture in `partial` mode; no model calls or personal documents. The synthetic PDF is a contract fixture, not a real parsing-quality sample.

Contains nested lists, code, math, repeated paragraphs with distinct IDs, a tiny image, partial mock translation, and the actual S3 runtime, CSS, KaTeX fonts and license. `reader.zip` is immutable; tests validate and round trip its existing members without rebuilding it from current renderer sources. `frozen.json` records its baseline commit, package UUID, archive bytes/hash, manifest identity and every member identity. The matching frozen renderer catalog/assets live in `packages/document-renderer/compat/s3-0.2.0/`.

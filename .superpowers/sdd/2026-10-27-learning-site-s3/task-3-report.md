# Task 3 report

Status: DONE. Review base: `ef089bb4ffdd2d33c24753edca6f6c3ffdf0fc2d` (controller subsequently committed R9–R11 documentation as `2e96019`).

## Public exports and decisions

- `toWebTranslationDocument(ir: WebReaderIR, selectionBlockIds: string[], sourceLanguage?: string): TranslationDocument` validates the Web graph and unique ordered text selection. Empty selection supports source-only snapshots; manual-job API boundaries still require nonempty explicit selections. Explicit source language uses conservative 2–63-character BCP47, excluding und/mul/zxx. No PDF identity or pages are synthesized.
- `validateWebTranslation(ir: WebReaderIR, translation: WebTranslation): ValidatedWebTranslation`; `ValidatedWebTranslation` has `blocks: ReadonlyMap<string, TranslationBlock>` and `sourceOnlyReasons: ReadonlyMap<string, 'language-not-required'|'manual-choice'|'pending'|'failed'|'cancelled'>`. Checks Web manifest/parse identity, every text result, ordered selections/units, status consistency and source bindings. PDF and Web use one internal `replayTranslation` implementation for SDK planUnits, marker validation, continuation assembly and decoding; PDF reference checks and output behavior remain intact.
- `buildWebReader(ir: WebReaderIR, translation?: WebTranslation | null): WebReaderBuild`; `WebReaderBuild = {index: WebReaderIndex; chunks: WebReaderChunk[]}`. Primary blocks appear once in canonical index ownership. Chunks use actual Web blocks/nodes/assets DTOs, cap all blocks including context at128 and JSON at256KiB (512KiB for a singleton including envelope), reopen list numbering, include table context and reject impossible closures explicitly. Nonempty20k fixture has full unique primary coverage.
- `renderWebChunk(chunk: WebReaderChunk, options: WebRenderOptions): TrustedReaderHtml`; options are `{mode:'source'|'translation'|'bilingual'; resolveAsset:(id:string)=>string}`. Source-bound inline formatting/code/images/KaTeX/SVG/MathML, true table cells/spans/scopes/headers, valid caption/tbody markup, local table/code horizontal scroll, one primary bilingual anchor, escaped source-only/display notices and site-theme colors. Source/translation/inline occurrence and context/chunk namespaces prevent duplicate DOM/SVG IDs, including adversarial separator and prototype-name IDs.
- R9: index source node IDs remain authoritative; `previewId:null` is intentional because IR has no preview map. Descriptor snapshots resolve preview locations downstream.
- R10: required `WebReaderChunk.contextBlockIds:string[]` (empty without context), reflected in Zod/JSON Schema. Exact header/caption source blocks and their decoded translations repeat as context without new IDs/SDK units. Explicit referenced headers, scoped column headers, first-row implicit headers including row groups and row headers participate in bounded closure. Context copies have chunk-scoped anchors and no primary `data-block-id` / source-position attributes. Index chunk block IDs and blockLocations contain only primary ownership.
- R11: optional Web text `headingLevel:1..6` outside SDK value, reflected in Zod/JSON Schema. Projector preserves actual h1–h6 through its shared tag lookup (including synthetic-run parent lookup); older absent metadata uses logical section nesting. Flat explicit headings now appear in TOC. PDF contracts and SDK kinds are unchanged.

## Consumer obligations

Byte adapters must verify actual immutable Web IR bytes against readerIrSha256, actual source manifest bytes against sourceSha256, and actual glossary/assets against declared hashes before replay. Renderer structural checks do not claim that arbitrary reserialized memory proves original-byte identity. Consumers use primary index ownership for progress/TOC, ignore context copies for position tracking, use descriptor.snapshots for source preview resolution, and resolve only authorized registered assets to trusted HTTP(S)/Blob/relative URLs. Snapshot previews remain a separate artifact. No model/API calls occur during reading, projection or replay.

## RED / GREEN evidence

- `npm run test --workspace @pagelingo/document-renderer -- --run tests/web-translation.test.ts`: initial9 failures for absent toWebTranslationDocument; GREEN9/9 after implementation. Subsequently expanded marker, invalid-language and unselected-result regressions pass in final suite. An invalid fixture language reason was corrected to the actual contract enum before GREEN.
- `npm run test --workspace @pagelingo/document-renderer -- --run tests/web-reader.test.ts`: initial failures for absent builder, then GREEN with tables/bilingual/20k/singleton/forged closure. R10/R11 additions went RED for absent context IDs / rejected heading metadata and then GREEN. One test-only ID regex was corrected to avoid matching data-block-id.
- Focused RED/GREEN: `-t namespaces` caught ambiguous inline/definition ID concatenation (3 unique IDs vs5); occurrence namespaces fixed it. `-t 'archived h3'` caught absent flat-heading TOC; explicit heading indexing fixed it. `-t 'valid table'` caught div/figcaption children inside table; caption/tbody rendering fixed it. `-t 'flagged table'` caught missing unscoped headers inside row groups; nested row lookup fixed it. Impossible context is rejected before constructing unbounded per-block dependencies.
- `npm run test --workspace @pagelingo/web-capture -- --run tests/projector.test.ts`: final8/8; source h3/h5 metadata regression added. Initial mixed-content fixture expectation was adjusted to actual HTML semantic unit behavior (one h5 block), not a production truncation.

## Final verification

- `npm run build:pdf`: exit0, builds SDKs/contracts/web-capture/renderer/bundle/CLI and regenerates current catalog. Renderer0.2.0 code SHA `0a63b38db9a5db23ec6e5bd6d3f319e0c1b480074ddd096e3c0e8d165d370951`.
- `npm run test --workspace @pagelingo/document-renderer --workspace @pagelingo/document-bundle --workspace @pagelingo/pdf-cli`: exit0; renderer60, bundle154, CLI108 tests. Repeated after final implicit-header correction; all pass. Includes fixed S2 acceptance, unknown catalog rejection and changed legacy byte rejection.
- `npm run test --workspace @pagelingo/document-contracts --workspace @pagelingo/web-capture`: exit0; contracts92 and capture37 tests.
- `npm run typecheck --workspace @pagelingo/document-contracts --workspace @pagelingo/web-capture --workspace @pagelingo/document-renderer --workspace @pagelingo/document-bundle --workspace @pagelingo/pdf-cli`: exit0. Renderer typecheck repeated after final correction, exit0.
- `npm run schemas:generate:reader --workspace @pagelingo/document-contracts`: exit0; Web IR/chunk schemas synchronized. Node import smoke confirms all4 exported functions. Browser esbuild smoke bundles the pure root (191 modules) with no DOMPurify/jsdom/Readability or Node builtin imports.
- `git diff --check`: clean. No unrelated root suite, real API, Python/model install, secret access, merge or push performed.

## Read-only S2 preservation

Final commands:

```
node scripts/check-s2-compat.mjs --input packages/document-bundle/tests/fixtures/s2-final/reader.zip --output data/pdf-s2/s3-task-3-fixed-final-20261027
node scripts/check-s2-compat.mjs --input data/pdf-s2/final-fix/current --output data/pdf-s2/s3-task-3-corpus-final-20261027
```

Both pass (1 fixed /4 original ZIPs). Reports compare before/after archive hashes and verify exact published catalog `0.1.0 / 3bfbbf4ce02a787185643792d617f80cb960261d108ad0ce224b0909ea4d47c3`, installed frozen assets and regenerated legacy files. All archives remain unchanged:

- fixed: `4bb9c04d33dd57a43e64b21f2921b916fb2c451ced57a73f75cacf9e9712c136`
- attention: `b5f57cf5ab49fba3ae96db5beec058c3b033b45cebea28c998b450f74d8e0f86`
- bert: `5f29b868e1461755c66534cafe16230a5004640fa465fe61420ee0b4324db4d9`
- llm-foundations: `9eeae78e0b1ae6d44656f733626caffa799f228f0c9b6e0396c1ad9e0fc169cf`
- rl-little-book: `b8454f9be349171ad43168ceff45a25d9330c25b08026b6559f7bde54a8bb26e`

No compat source/assets/catalog/fixed ZIP or original corpus inputs were edited. Reports are new ignored directories outside original input trees.

## Files / self-review / limitations

Added renderer semantic-html/web-translation/web-chunking/web-html modules and Web test fixtures/suites; updated PDF wrappers/index/README/current catalog and dependency. Narrow R10/R11 changes touch contracts source/generated Web schemas/parity fixture and capture projector/regression. Root build ordering and service Docker package/dist COPY now include the pure web-capture dependency; lockfile updated offline with scripts disabled. Self-review checked exact source/protected replay, bounds, context ownership, table semantics, link/asset safety, namespace collisions, browser imports and frozen legacy immutability.

No blocking concern. Actual Docker image build and interactive Web UI/browser screenshots were not run (this task delivers pure renderer functions, not a UI). The service deployment COPY change was inspected and normal package builds passed. Header contexts that cannot fit128 blocks/256KiB are explicitly rejected rather than silently omitted. Byte-hash validation and descriptor snapshot resolution remain adapter responsibilities as specified above.

## R12 original-first amendment

Exact additive signature is now `buildWebReader(ir: WebReaderIR, translation?: WebTranslation | null): WebReaderBuild`. Omitted/null translation builds original-only chunks directly, with null decoded translations and explicit source-only reasons, without constructing a translation DTO or calling SDK planning/replay. Generation is none; Chinese documents (and individual Chinese/no-language text blocks) require no translation; all other text is pending. If no pending text remains, index status is not-required, otherwise pending. Existing nonnull translation replay and PDF paths are unchanged; `validateWebTranslation` remains nonnull. No provider/job/profile/budget/glossary/hash metadata is invented.

Focused RED: `npm run test --workspace @pagelingo/document-renderer -- --run tests/web-reader.test.ts -t 'artifact|translation run'` failed5/5 because undefined/null was passed to the required translation schema. Same command GREEN5/5 after implementation. Fixtures cover zh, foreign French, mixed text, omitted and explicit null arguments, unchanged original text, real table/header/formatting/MathML output, protected-only KaTeX/code, generation/status/reason honesty and absent translation-run metadata.

R12 final checks: `npm run build:renderer` exit0 (regenerated catalog0.2.0 SHA `db999e0707924f64c475a7645d49f95e11265b5ffd5ce3d467e9c0676fbd6f70`); `npm run test --workspace @pagelingo/document-renderer` exit0,65/65 tests in6 files; `npm run typecheck --workspace @pagelingo/document-renderer` exit0; fixed S2 command with new output `data/pdf-s2/s3-task-3-r12-fixed-20261027` passed1 archive, unchanged SHA `4bb9c04d33dd57a43e64b21f2921b916fb2c451ced57a73f75cacf9e9712c136`. `git diff --check` clean. Earlier PDF/bundle/capture/full-corpus checks remain applicable to untouched paths and were not unnecessarily repeated. Amendment changes only Web chunk builder/tests, renderer README/current catalog and this report. No new runtime/API/worker/legacy changes or concerns.

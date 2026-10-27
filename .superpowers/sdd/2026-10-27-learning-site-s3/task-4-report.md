# Task 4 implementation report

Base: `08ce09ccc8d64c63dba1874d0be4a99691e432dc`; branch `feat/learning-site-s3`.

## Result and schema

Added only `apps/document-service/migrations/006-web-capture.sql`. It persists singleton site UUID, private pairing/device records, captures/files, Web source metadata/file registrations, parse/translation/Reader versions, chunks/registered Reader assets, document CAS progress with retained per-version history, immutable provider/glossary revisions, save preferences, fetch/translation jobs, checkpoints, owner cache, and exactly two worker slots. `verifyDatabaseSchema` resolves all new required tables.

Composite FKs enforce owner/document/source/parse consistency and asset byte/SHA identity through existing `assets` / `source_versions`. Registered immutable source files, IR, translation, index, chunks and Reader assets retain explicit references for future GC. UPDATE triggers protect assets/sources and completed artifacts, immutable job/capture inputs, glossary/provider revisions and file descriptors. Web job manual `source_language` / `selection_block_ids` are nullable immutable inputs; selection SQL checks enforce unique bounded block IDs, while Task9 validates IR membership/order and computes the complete identity hash. Jobs contain no credentials; provider snapshots use strict non-sensitive `ProviderSettings`.

Documents retain the original PDF current Reader FK and gain latest Web source/requested job/current Web Reader pointers. Web current source and Reader are paired and source-consistent; document kind is immutable. PDF requires its filename; Web filenames may be null. Repository/paper remains link-only (source insertion rejected). Source-only Reader versions have null translation IDs and honest `pending` / `not-required` status, without fabricated jobs/configuration. PDF parse insertion on a Web document is rejected. Fetch job Reader results have an additional owner/document FK because their null source/parse intentionally skips the longer FK.

Devices preserve `pairing_session_id` without a sessions FK; natural session cleanup does not delete devices. Pairing/token values are hashes. Capture rows retain owner/authVersion and exactly one device/session identity. Default preferences are revision 0 / autoTranslate false; glossary revision 0 can be materialized for a first job. Glossary revisions and non-sensitive profile snapshots remain independently immutable when current provider settings change.

## Exported repository interfaces

All paths below are under `apps/document-service/src/`; all repository functions accept a `PoolClient` first. They use parameterized SQL. PostgreSQL bigint row fields remain strings; lease fields are safe numbers and `leaseUntil` is a `Date`.

### `devices/repository.ts`

Types: `PairingInput`, `PairingRow`, `DeviceInput`, `DeviceRow`.

Functions: `readSiteId`, `insertPairing`, `consumePairing`, `insertDevice`, `findDeviceByTokenHash`, `listDevices`, `revokeDevice`, `revokeSessionDevices`.

### `web-captures/repository.ts`

Types: `WebCaptureInput`, `WebCaptureRow`, `CaptureFileRow`, `CaptureCompletion`.

Functions: `insertWebCapture`, `findWebCapture`, `findWebCaptureByKey`, `listCaptureFiles`, `recordCaptureFile`, `transitionWebCapture`, `completeWebCapture`.

### `web-readers/repository.ts`

Types: `WebDocumentInput`, `WebAssetInput`, `WebSourceInput`, `WebParseInput`, `WebTranslationInput`, `WebReaderVersionInput`, `WebReaderVersionRow`, `WebAssetRow`, `WebDocumentRow`, `WebSourceRow`, `WebParseRow`.

Functions: `insertWebDocument`, `insertWebAsset`, `insertWebSource`, `registerWebSourceFile`, `insertWebParse`, `insertWebTranslation`, `insertWebReaderVersion`, `insertWebReaderChunk`, `registerWebReaderAsset`, `setLatestWebSource`, `setCurrentWebReader`, `findWebReaderVersion`, `listWebReaderVersions`, `findWebSourceFile`, `findWebReaderAsset`, `findWebReaderChunk`, `readWebProgress`, `saveWebProgress`, `findWebDocument`, `findWebSource`, `findWebParse`, `setRequestedWebJob`.

### `web-jobs/repository.ts`

Types: `JobLease`, `WebJobInput`, `WebJobRow`.

Functions: `insertProviderRevision`, `insertWebJob`, `findWebJob`, `startWebJobLease`, `assertJobLeaseCurrent`, `releaseWebJobSlot`, `loadJobCheckpoint`, `saveJobCheckpoint`, `readOwnerCache`, `putOwnerCache`, `deleteOwnerCache`, `findWebJobByInput`.

### `glossary/repository.ts`

Functions: `readSavePreferences`, `savePreferences`, `readGlossaryRevision`, `saveGlossaryRevision`, `ensureGlossaryRevision`.

## Lease and consumer handoffs

`JobLease` is the internal discriminated union: common `jobId`, `ownerId`, `authVersion`, `epoch`, `leaseOwner`, `leaseUntil: Date`, `slotId`, `slotEpoch`, `documentId`; fetch-link adds `url`; translate adds `sourceVersionId`, `parseId`, `profileRevision`, `glossaryRevision`.

`startWebJobLease(client, {ownerId, jobId, slotId, leaseOwner})` is a focused transaction primitive, not a worker loop. It locks user → slot → job, uses `SKIP LOCKED`, increments job/slot epochs, grants 30 seconds, rejects inactive/obsolete/config-changed jobs, and enforces one running job per owner plus two global slots. It does not lock an expired slot's previous owner. Expired jobs remain for later owner-scoped recovery before that owner can claim again.

`assertJobLeaseCurrent(client, lease)` MUST run inside a transaction enclosing the guarded write/publication. It holds user/slot/job row locks through commit and reads `clock_timestamp()` after lock acquisition. It checks active owner/authVersion, immutable kind/source/parse/profile/glossary identity, current provider revision, both lease expiries, epoch, worker and slot ownership. Stored lease expiry is authoritative so later heartbeats may extend a dispatched lease. Failure throws SDK `CheckpointConflictError`; checkpoint/cache writes call this guard and are atomic in the caller's transaction. `releaseWebJobSlot` conditionally matches the former token/epoch and cannot erase a reassigned slot. It releases only the slot; Task11 owns terminal job transition / heartbeat / cancel / recovery orchestration.

Ordinary repositories deliberately do not implement authentication: Task5 must lock/revalidate the owner then device/session before capture/device mutations. Task6 owns capture identity checks, source dedup/publication policy, object publication lock, and mixed library/list/get dispatch. `setCurrentWebReader` is the paired SQL update after that policy, not an automatic promotion decision. Task9 owns current Provider save → immutable snapshot wiring, no-Key gating, immutable input hashing, checkpoint/cache SDK wrappers and manual language/selection validation. `ensureGlossaryRevision` materializes revision 0 without creating a false revision 1. Tasks9–11 must revalidate sensitive identities before cache use and all guarded writes; network/DOM/render work stays outside transactions.

Existing `documents/repository.ts` methods `findDocument`, `findSamePdf`, and `listDocuments` now explicitly filter `kind='pdf'`, including list count and by-asset reads. This preserves S2's `PdfDocumentSummary` contract and prevents returning Web manifests via PDF paths; Task6 owns mixed-document dispatch. No routes/UI/network/worker loop were added.

## RED / GREEN evidence

Commands ran from the assigned worktree, using the existing isolated PostgreSQL runner (no user/prod DB or `.env` access):

- `npm run test:service:db -- --run tests/integration/web-database.test.ts`: initial RED 5 failures for absent migration/Web support. Initial GREEN 5 schema tests; then missing-repository REDs followed by 10 and 12 passes. Test fixture issues fixed during this cycle: UUID/text SQL parameter inference, contract-valid block ID and default profile extraction.
- Same focused command: RED for missing cross-kind source enforcement and duplicate SQL selections; GREEN 16/16, including two independent Node processes contending for leases.
- Same focused command: RED for first-job glossary persistence/source lookup; GREEN 19/19, including fresh clock after slot-lock wait and reassignment while the former owner's user row is locked.
- Same focused command: RED proved fetch job nullable-source FK admitted a foreign Reader; explicit owner/document FK added; final GREEN **20/20** (`/tmp/pagelingo-task4-green6.log`).
- First complete `npm run test:service:db`: 142 passed, 1 failed: `reader-routes.test.ts > upgrades a populated S1 schema without changing original references and migrates an empty database`, solely stale expected migration count 5 vs 6. Updated that assertion; `database.test.ts` count assertions were already updated.
- Final `npm run test:service:db`: **10 files / 144 tests passed**, exit 0, 105.91 seconds (`/tmp/pagelingo-task4-db-final2.log`).
- `npm run typecheck --workspace @pagelingo/document-service`: PASS, exit 0 (final run).
- `npm run build --workspace @pagelingo/document-service`: PASS, exit 0 (final run).
- `git diff --check`: PASS.

The 20 focused tests cover populated S2 PDF/source/Reader preservation beside Web rows, legacy migration checksums, 006 rollback/replay, cross-owner/source/kind FKs, immutable inputs/artifacts, separate current pointers, source-only readers, session cleanup, prefs/glossary CAS, strict non-secret snapshots, capture/file byte and epoch checks, registered artifact retention, historical progress/CAS, translation/fetch persistence, checkpoint/cache rollback, stale auth/config/epoch/slot, row-lock fencing, fresh expiry and independent-process slot limits. Existing integration suite exercises PDF routes/Range/readers as well.

## Migration preservation and files

001–005 were compared byte-for-byte with the base commit and unchanged. SHA256:

```
001-accounts.sql         6dd976d3b10fa569d6975fe0a75b9ff948ee7fa2a1560024ce10a8b6a770383e
002-providers.sql        7c8347d9283a2af2fa64d4038f528b7ebfd0a91abb51fc5568b1ce6ae9f1a695
003-documents.sql        051cad1bfb1f15f62974651f2af83fe2d5330a7920eac0512c5463b4f403c27b
004-user-management.sql  c662a4f1a4af81e4b1b166f14a27e559574daced85da3dc6137d28108551d288
005-reader-bundles.sql   196686c10eadfe98bad1af4b2a964d7632e7ff4baa2db97d91a807a86221efc1
```

Files: new 006 migration; five new repository modules listed above; new `tests/integration/web-database.test.ts` and test-only `tests/helpers/web-lease-process.ts`; changed `src/db/migrate.ts`, `src/documents/repository.ts`, migration-count assertions in `tests/integration/database.test.ts` and `tests/integration/reader-routes.test.ts`; this report. Pinned renderer assets/generators, fixtures, original corpus, 001–005, models and credentials were not edited. No merge/push or process stops.

Known concerns: none beyond the explicitly deferred authentication, publication-policy, Provider integration and worker orchestration handoffs above. Repository transaction preconditions are mandatory for consumers.

## Fix round 1 — capture translation-job identity

Review base: `d56917dc7919218d9cf962366e0a0222c1d17325`. Reproduced the Important finding: a completed capture could associate its Reader with a translation job for another source, or another parse of the same source, within the same document.

Changed only `migrations/006-web-capture.sql` and `tests/integration/web-database.test.ts` plus this report. Added immediate database constraint trigger `web_capture_job_reader_identity` / function `assert_capture_job_reader_identity`. On capture INSERT/UPDATE with a nonnull translation job, it compares the immutable job's `(source_version_id, parse_id)` with the registered Reader's identity and rejects mismatch with SQLSTATE `23503`. Existing composite FKs continue to enforce owner/document/source/Reader membership and retain the referenced rows. Job and Reader identity UPDATE rejection makes the constraint stable after capture completion. Valid null-job source-only completion and matching-job completion remain supported. Existing fetch-job owner/document rules are unchanged.

Consumer fields/API changes: **none**. `CaptureCompletion`, `WebCaptureRow`, `completeWebCapture` and other repository exports remain unchanged; existing transaction/auth assumptions also remain unchanged. Deferred lease formatting was not touched.

Verification:

- RED: `npm run test:service:db -- --run tests/integration/web-database.test.ts` — 6 failed / 22 passed (`/tmp/pagelingo-task4-fix1-red2.log`). Each source/parse mismatch succeeded unexpectedly through repository completion, direct SQL INSERT, and direct SQL UPDATE; the positive matching/null-job controls passed.
- GREEN: same command — **28/28 passed**, 6.02s (`/tmp/pagelingo-task4-fix1-green.log`). Tests also confirm rejected repository transactions preserve the validating capture with no job.
- `npm run typecheck --workspace @pagelingo/document-service` — PASS, exit 0.
- `npm run build --workspace @pagelingo/document-service` — PASS, exit 0.
- Final full `npm run test:service:db` — **151 passed / 1 failed**, 137.25s (`/tmp/pagelingo-task4-fix1-db-final.log`). The sole failure was existing `bundle-imports.test.ts > atomic private bundle publication > is idempotent by request and package and never moves current back to an older package`, exceeding its unchanged 15-second timeout (15.067s), with no assertion/constraint failure. All 28 Web tests passed in that run.
- Targeted timeout investigation: inspected the existing PDF-only test (multiple bundle builds/imports; no Web capture mutation), then ran `npm run test:service:db -- --run tests/integration/bundle-imports.test.ts -t 'is idempotent by request and package and never moves current back to an older package'` — **1 passed / 21 skipped**, 10.48s total runner duration, exit 0 (`/tmp/pagelingo-task4-fix1-timeout-recheck.log`). The unchanged timeout passes in isolation, supporting timing contention in the full run. No unrelated test or timeout edits; the full suite was not rerun.
- `git diff --check` — PASS. Migrations 001–005 have no diff against the fix base.

Self-review: checked both direct write paths, the nullable-job path, source versus parse comparison independently, existing FK composition, and immutable referenced identities. No repository-only validation substitute, new consumer fields, legacy migration edits, unrelated formatting, or production-data changes. No known remaining concern for this finding.

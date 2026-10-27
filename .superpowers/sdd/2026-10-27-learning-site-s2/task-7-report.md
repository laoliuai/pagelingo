# Task 7 implementation report

Base: `41188905c3ae8beeb1436e79950e30110fe4f231`, worktree `/home/liujia/.codex/worktrees/21fe/pagelingo`, branch `feat/learning-site-s2`.
Scope: immutable Reader persistence and private bundle ingestion/publication. No HTTP import/Reader routes, UI, or progress service was added; these remain Task 8+.

## Result and implementation

- Added migration 005 only. Existing 001–004 remain byte-for-byte unchanged. Parse IDs are ReaderIR text identities; translation IDs are snapshot UUIDs; Reader version IDs are server UUIDs. All durable references include owner/document and, where applicable, source/parse identities. `documents.current_reader_version_id` has the required deferred owner/document/current-source FK. Immutable parse/translation/version/chunk/file rows reject UPDATE. Package uniqueness is `(owner_id, package_id)`; active imports use a partial owner uniqueness index.
- Original PDF, exact received ZIP, every original file including manifest, and generated structured JSON index/chunks are registered immutable objects. Full bundle bytes are retained; no uploaded render HTML/JS is executed by the service. Same-source objects are reused only within the same owner/document; separate owners get independent objects.
- `createBundleImportsService({ db, store, config })` implements create/receive/get/list/cancel. It binds creation idempotency keys to a request digest, claims epoch internally, persists heartbeat/status/error codes, rejects overlapping owner/process work, and allows failed claims to retry with a higher epoch. Completed receive is idempotent; completed cancel returns `BUNDLE_IMPORT_COMPLETED`. Cancelled requests require a new import.
- Receipt streams to exclusive 0600 UUID input files in 0700 `bundle-staging/`. The parent owns 15-minute upload deadline, 15-second authenticated heartbeat, abort, DB and ObjectStore. Validation/SDK replay/renderer/JSON serialization run in a terminable Node Worker. The validation phase has a five-minute parent deadline, including subsequent staging; worker-client also owns an independent five-minute worker timer. No main-eventloop-only CPU timeout is used.
- Workers receive `{path, limits}` only, `execArgv: []`, and positive environment `{LANG:'C.UTF-8', TZ:'UTC'}`. They never receive actor/config/keyring/user keys/DB URL. Compiled production workers load JS directly; source development workers bootstrap through tsx. No CLI/Python/parser/model/provider runtime dependency was added.
- Network receipt, bundle/hash verification and immutable writes occur outside business transactions. Publication acquires actor/user → import → existing document → shared `(204716,2)` publication/cleanup lock. It restats all newly staged objects, the reused original, and reused parse/translation assets under that lock, then inserts all refs and switches current atomically. Duplicate old packages return their existing version without promoting it.
- R30 promotion: completed/not-required translations are protected irrespective of parse coverage; partial translations are protected from pending/failed/cancelled blank replacements; full successful current versions are additionally protected from partial-parse replacements. First source/partial versions are readable. Incomplete subsequent versions remain stored in history.
- Cleanup expires 15-minute stale claims and retains all assets references. Ordinary orphan objects/staging retain the existing >=24-hour delay. Bundle input UUID files are eligible after 15 minutes only with no fresh active import heartbeat owning that UUID. Claim expiration does not resurrect a stale epoch.
- RuntimeConfig exposes effective BundleLimits from the approved strict override schema. Structural ceilings only tighten; operational byte limits may grow; `maxPdfBytes` comes exclusively from existing `PAGELINGO_MAX_PDF_BYTES`.

## RED/GREEN evidence

Initial requested RED command:

```text
npm run test:service:db -- tests/integration/bundle-imports.test.ts
FAIL tests/integration/bundle-imports.test.ts
Error: Cannot find module '../../src/bundle-imports/service.js'
Test Files 1 failed (1); Tests no tests
npm error code 1
```

This was the missing-feature entrypoint RED, before the implementation existed, not an assertion-level regression. The initial shell wrapper ended with `tail`, so the underlying npm failure is evidenced by its output, not the wrapper exit code. `/tmp/task7-red.log` contains that run.

First GREEN, same command: `Test Files 1 passed (1); Tests 4 passed (4)` in 15.93s (`/tmp/task7-green1.log`). Expanded state/fault tests then passed 12/12 (31.08s), followed by 17/17 (55.79s). The file named `/tmp/task7-red-cleanup.log` actually contains the 12-test GREEN run; it must not be treated as RED evidence.

Self-review found a real reference-publication gap and added a failing behavior regression before its fix:

```text
npm run test:service:db -- tests/integration/bundle-imports.test.ts -t 'stats the reused'
exit 1
FAIL stats the reused logical parse asset as well as newly staged files before publication
AssertionError: promise resolved "{ …(7) }" instead of rejecting
Test Files 1 failed (1); Tests 1 failed | 18 skipped (19)
```

The test deletes the already-referenced parse IR object after a first import, then attempts another snapshot sharing that parse. Before the fix, publication wrongly succeeded despite checking all new files. The fix includes reused parse/translation assets in final stat checks, including duplicate-package publication. `/tmp/task7-red-retained.log` records the RED.

```text
npm run test:service:db -- tests/integration/bundle-imports.test.ts -t 'stats the reused|heartbeats'
exit 0
Test Files 1 passed (1); Tests 2 passed | 17 skipped (19)
Duration 20.96s
```

`/tmp/task7-green-retained.log` records the regression GREEN and real 15-second parent heartbeat during busy worker CPU.

## Worker and process evidence

- `tests/unit/bundle-worker.test.ts` launches the owned `busy-bundle-worker.mjs` fixture, which writes readiness/environment then enters an infinite synchronous loop. A real 500ms parent timer terminates it; total duration must remain <2s while parent 10ms ticks continue. A separate test aborts the running busy worker and requires termination <1s, before a 5s deadline. `worker.terminate()` is awaited before the returned promise settles.
- The worker fixture reports exactly `{env:{LANG:'C.UTF-8',TZ:'UTC'}, inputs:['limits','path']}` even when parent environment contains owned sentinel user/master keys. This checks actual child environment/input, rather than string-matching production code.
- The PG heartbeat test runs the same busy worker for 16s while the actual `maintainLease` function runs. Starting with heartbeat aged 14 minutes, the resulting database heartbeat must be newer than 3 seconds. It proves the parent is available to maintain authorization/lease while child CPU is blocked.
- The actual restart test forks an owned Node receiver into the same isolated schema, waits for its streamed partial receipt, SIGKILLs only that child, and reconstructs the service. GET still reports the persisted receiving status. After simulated 16-minute heartbeat aging, GET reports failed/BUNDLE_LEASE_EXPIRED; receive succeeds at epoch 2. The test runner owns and cleans the process/schema/data directory. Focused command `npm run test:service:db -- tests/integration/bundle-imports.test.ts -t 'actual receiver process'` passed 1 test (21 skipped), exit 0, 3.24s; log `/tmp/task7-process-restart.log`.
- A compiled JS worker smoke after `npm run build:service` used a fresh owned Node fixture ZIP through `dist/bundle-imports/worker-client.js`. Output: `Compiled JS worker validated package; generated 4 JSON assets`. No tsx bootstrap was needed by that compiled worker; tsx was used only by the parent fixture generator. Log `/tmp/task7-compiled-worker.log`.
- Standard tests use small Node-owned bundles and real local ObjectStore/PostgreSQL, with controlled boundary faults. No BERT/corpus, `.env.local`, real credentials, Python, live API, model downloads, production schemas or user-owned processes were used.

## Publication/state coverage

The integration suite verifies uploaded-original attachment, direct package creation, owner/admin isolation, source reuse, creation/package idempotency, package collision, parse/translation logical-ID collision, old-package non-rollback, R30 current protection across parse and translation statuses, explicit foreign/mismatched targets, interrupted producers, immediate cancel, completed-cancel conflict, stale epoch rejection, reconstructed and actual-process restart recovery, disable/password-version revocation after receipt, deferred commit failure after object writes, last-object disappearance, reused parse-object disappearance, concurrent original upload/source reuse, owner/process contention, cleanup racing final stat+commit, every registered asset surviving cleanup, active/orphan input GC, owner/source compound FKs, immutable-row mutation rejection, configured upload limits, malformed ZIP validation, exact original archive bytes, and contract-valid generated index/chunk JSON.

Disable/reset fences are tested by controlled SQL account-state/auth-version mutation; existing account-management tests separately exercise the real management endpoints. Fault ObjectStore wrappers preserve real immutable writes except the explicitly injected failure. No partial Reader/source/document references survive rollback.

## Interfaces for Task 8

Service results are shared `BundleImport` DTOs with no owner or object keys; `list(actor)` returns `BundleImport[]`. `receive` awaits completion and rejects with sanitized ServiceError on failure; get/list preserve the durable failed result. HTTP adapters must derive actor from existing session guards and enforce CSRF/Origin for writes. Effective public limits are `config.bundleLimits`.

Relevant stable service errors: `BUNDLE_IMPORT_BUSY`, `BUNDLE_IMPORT_CONFLICT`, `BUNDLE_IMPORT_SUPERSEDED`, `BUNDLE_IMPORT_COMPLETED`, `BUNDLE_LEASE_EXPIRED`, `BUNDLE_SOURCE_CONFLICT`, `BUNDLE_IDENTITY_CONFLICT`, `BUNDLE_ABORTED`, `BUNDLE_UPLOAD_TIMEOUT`, `BUNDLE_VALIDATION_TIMEOUT`, `BUNDLE_IMPORT_FAILED`, plus validator `INVALID_BUNDLE`, `BUNDLE_TOO_LARGE`, `BUNDLE_MISSING_RESOURCE`, and existing `IDEMPOTENCY_CONFLICT`/`UNAUTHORIZED`/`NOT_FOUND`.

- `parse_runs`: owner + text id primary key; document_id, source_version_id, ir_asset_id, ir_sha256, status, coverage, warnings, created_at. Identity reuse must match both bytes and document/source.
- `translation_runs`: owner + snapshot UUID primary key; document_id, source_version_id, parse_id, translation_asset_id, sha256, status, created_at.
- `reader_versions`: server UUID id; owner_id, document_id, source_version_id, parse_id, translation_id, package_id, manifest_sha256, archive_asset_id, index_asset_id, created_at. Package identity is unique per owner. Version summary joins translation status and parse coverage/warnings.
- `reader_chunks`: `(reader_version_id,id)` primary key; owner_id, document_id, data_asset_id, created_at. Data assets contain `ReaderChunk` JSON, not HTML/JS registration wrappers.
- `bundle_files`: `(reader_version_id,path)` primary key; owner_id, document_id, asset_id, created_at. Includes manifest.json and every original entry. Original bundle download uses reader_versions.archive_asset_id. IR/translation bytes use parse/translation asset IDs. Descriptor image assetMap is derived from validated IR assets' logical ID/path and version-owned bundle_files; arbitrary archived HTML/JS/fonts are not site-executable resources.
- Documents now include current_reader_version_id; get/list summaries report `reader-ready` and current translationStatus/parseCoverage/warnings. Historical reader versions do not overwrite original/source or current on a protected degradation.
- `reading_state`: owner/document primary key, revision bigint default 0, nullable source_version_id/parse_id/reader_version_id/position JSON, updated_at. Publication creates a revision-0 empty row. No progress is written merely by import/opening. Future progress service must validate the full ReadingPosition DTO and perform document CAS.
- `reading_positions`: owner/document/reader-version primary key, non-null source_version_id/parse_id/position JSON, updated_at. Both tables constrain identity fields in position JSON to their compound Reader refs. The progress service should UPSERT history and update state atomically after CAS; API revision conversion follows safe integer contract.
- ObjectStore interface is unchanged. Reader asset streams must authorize owner/version before accessing internal object_key, and apply Task 8 response/content allowlists. Schema readiness now verifies all new tables.

## Changed files

Added:
- `apps/document-service/migrations/005-reader-bundles.sql`
- `apps/document-service/src/bundle-imports/{repository,service,staging,publication,limits,lease,worker-client,validation-worker}.ts`
- `apps/document-service/tests/integration/bundle-imports.test.ts`
- `apps/document-service/tests/helpers/bundles.ts`
- `apps/document-service/tests/fixtures/{busy-bundle-worker,bundle-restart-process}.mjs`
- `apps/document-service/tests/unit/bundle-worker.test.ts`

Updated:
- `apps/document-service/src/{config.ts,db/migrate.ts,documents/repository.ts,cli/cleanup-staging.ts}`
- `apps/document-service/tests/integration/database.test.ts` (five migrations)
- `apps/document-service/tests/unit/{config,static-site}.test.ts` (limits contract/config fixture)
- `apps/document-service/{package.json,README.md}`
- root `package.json` (service test prerequisites build bundle dependencies) and `package-lock.json` (only service workspace dependency links)
- this report.

## Concerns / deferred integration

The existing service Dockerfile does not yet copy the bundle/renderer workspace manifests and built runtime packages. Task 12 deployment must add them before relying on containerized import/Reader routes. This was reported to the controller and deliberately not mixed into Task 7. No new runtime needs Python, the local CLI, a model or user key. HTTP route/UI/progress wiring and full-site/browser acceptance remain their later planned tasks; no claim of those deliveries is made here.

The internal worker client exposes entry/deadline options for its focused owned-worker tests. They are not part of the service/HTTP contract; Task 8 must not map client input onto them. User-visible limits remain the frozen BundleLimits contract only.

## Final verification

Final verification results are appended after the final full PostgreSQL run; commands below run from the isolated worktree root.

```text
npm run test:service:db
exit 0
Test Files 7 passed (7)
Tests 109 passed (109)
Duration 89.29s
```

Final PG log: `/tmp/task7-final-pg.log`. Includes all 22 new import tests plus every existing service integration test. It ran after the last migration/service/test edits, including the actual owned-process restart test.

```text
npm run test:service
exit 0
Test Files 9 passed (9)
Tests 104 passed (104)
Duration 3.93s

npm run typecheck --workspace @pagelingo/document-service
exit 0
> tsc -p tsconfig.test.json

npm run build:service
exit 0
> build SDKs/contracts/renderer/bundle/service
> tsc -p tsconfig.json

git diff --check
exit 0; no output
```

Logs: `/tmp/task7-final-unit.log`, `/tmp/task7-final-typecheck.log`, `/tmp/task7-final-build.log`. `npm install --package-lock-only --ignore-scripts` also reported `found 0 vulnerabilities` (472 packages audited). The final unit run exercises the updated root build prerequisites, runtime BundleLimits validation and worker deadline/cancel/env tests; final PG includes cleanup reference/race/input recovery tests. Existing migrations' diff is empty. No further functional changes followed these checks; this report and the final commit record are documentation only.

# 文档服务

S2 / 0.1.0 已实现运行配置、PostgreSQL 迁移、health API、管理员初始化、登录 / 会话 / 修改密码、账号管理、本人 PDF 原件 API、个人模型配置与显式连接测试。网站、API 和静态 PDF 解码资源可由同一服务提供。安装、Compose、密钥初始化与开发命令见 [学习站安装指南](../../docs/learning-site-install.md)，交付边界与证据见 [S2 验证记录](../../docs/learning-site-s2-validation.md)。

账号、原件、资源和 Provider 均按当前会话 owner 隔离；管理员只额外管理账号。数据库、对象卷和主密钥在运行时注入。Dockerfile 使用固定 Node 镜像，多阶段构建及非 root runtime；Compose 是 loopback local 预览，并非公网生产部署。

S2 已通过迁移 005 加入不可变解析 / 翻译快照、Reader 版本、分片及包导入发布服务。导入 HTTP 路由、Reader API、所有权隔离和 CAS 进度写入均已接入；服务器不运行 parser 或模型推理。来源绑定使用 `documents.current_source_version_id`；正式包必须绑定同一 owner / document / source。后台任务、助手、设备授权与完整备份恢复按后续阶段实现，设计见 [PDF 规格](../../docs/pdf-spec.md) 与 [处理设计](../../docs/pdf-processing.md)。

## Persistence foundation

Use `npm run build:service`, then inject the service variables documented in the
root `.env.example` and run `npm start --workspace @pagelingo/document-service`.
The process does not load `.env.local`. Keyring entries must be canonical base64
encodings of 32 random bytes. Keep runtime configuration out of logs.

`GET /health/live` checks the process; `GET /health/ready` checks the migration
ledger, checksums and required tables. Startup applies SQL migrations under a
transaction-scoped PostgreSQL advisory lock. Never edit an applied migration:
add a new numbered SQL file. Keep `migrations/` alongside `dist/` when deploying.

`npm run test:service` runs Node unit tests without Docker. Explicit integration
checks use `npm run test:service:db -- tests/integration/database.test.ts`; the
runner starts a disposable pinned PostgreSQL container bound to loopback and
removes only that container. To use an existing **isolated test database**, set
`PAGELINGO_TEST_DATABASE_URL` explicitly. It never falls back to `DATABASE_URL`.
Test helpers create and remove only their own random `pgl_test_*` schemas and
temporary data directories. Connection failures fail the integration suite.

`createApp({ config, db, outboundFetch? })` accepts caller-owned persistence;
closing the app leaves the pool open. The executable and test helpers close
both resources. Test applications deny outbound requests by default.


## Initial administrator and authentication

After `npm run build:contracts`, configure `.env.site-dev.local` for the separate development database and
run `npm run site:admin -- --username admin`. A terminal prompts for a masked
password. Automation must pass `--password-stdin` with non-TTY stdin; one final
line ending is removed. Passwords never belong in command arguments. Bootstrap
creates only the first administrator and returns a conflict if any administrator
already exists, including an inactive one.

Passwords contain 12–128 Unicode code points, preserving spaces. Usernames are
normalized to lowercase. Login uses `POST /api/v1/auth/login` with a JSON
`{ username, password }` body and the exact configured `Origin`. Login and
`GET /api/v1/auth/session` return `{ user, csrfToken }`; the opaque session token
appears only in an HttpOnly cookie, expires after seven days, and is stored only
as a SHA-256 hash. Production uses the Secure `__Host-pgl_session` cookie;
loopback local/test origins use `pgl_session`.

Authenticated writes require the same exact Origin and `X-CSRF-Token` from the
current session. `POST /api/v1/auth/logout` takes `{}` or
`{ allDevices: true }`; the latter revokes all sessions and increments the user
version. `POST /api/v1/auth/password` takes
`{ currentPassword, newPassword }` and revokes every prior session on success.
Both return an anonymous SessionView and require a fresh login. Login failures
are limited atomically by IP+username and by IP; 429 responses include
`Retry-After` seconds. No service request or credential logging is enabled.

Future authenticated routes use `requireSession(request)` and
`requireWriteRequest(request, actor)`. Before committing protected state changes,
call `assertActorCurrent(client, actor)` inside the same database transaction.
It locks the user row, then checks the session; account mutations must preserve
this user-before-sessions lock order and bump `auth_version` when revoking all
authorization. Device tokens added later must carry and check this version too.


## Administrator-managed accounts

All `/api/v1/admin/users` endpoints require a current administrator session.
`GET` returns a `PublicUser[]`; `POST` accepts `{ username, password }` and
returns the created ordinary user with status 201. Roles cannot be promoted
through the API. Duplicate normalized usernames return 409. JSON bodies reject
unknown fields, including `role`, `ownerId`, and `passwordHash`.

`PATCH /api/v1/admin/users/:id` accepts `{ active }` and returns the updated
public user. Disabling increments the authorization version and deletes every
session; enabling never revives an old cookie. The last active administrator
cannot be disabled, including through concurrent administrator requests.
`POST /api/v1/admin/users/:id/reset-password` accepts `{ newPassword }`, applies
only to ordinary users, revokes all their sessions, and returns 204. All writes
require Origin and CSRF checks. Successful changes are recorded transactionally
in `user_audit_events` with only actor, target, action, ID, and timestamp.

`createUsersService(db)` exposes `list(actor)`,
`create(actor, { username, password })`, `setActive(actor, userId, active)`, and
`resetPassword(actor, userId, newPassword)`. Management transactions acquire the
bootstrap advisory lock `(204716, 1)`, then actor/target rows in UUID order, then
revalidate the actor/session before changing state. Never acquire that advisory
lock after locking a user. Authentication-only transactions continue to lock one
user before sessions and never acquire the management lock.

The shared `consumeRateLimit(client, { scope, subject, limit, windowSeconds })`
function in `src/auth/rate-limit.ts` atomically reserves one request in a fixed
window using the database clock and `rate_limit_windows`. Exhaustion throws
`ServiceError(429, 'RATE_LIMITED', ..., retryAfter)`; HTTP replies expose
`Retry-After` seconds. A transaction rollback refunds its reservation. To count
attempts despite later failures, commit a guarded reservation before performing
the work. Acquire account locks before quota rows; when taking multiple quotas,
use scope/subject order. Callers supply trusted positive integer limits/window
sizes and stable scope names; subjects must come from authenticated identities.
The existing failed-login limiter retains its separate failure-count semantics.

Password reset reserves five attempts per administrator per 60-second window
under scope `admin-password-reset`. Missing/forbidden targets and later hash
failures consume quota. Password hashing runs after that reservation commits;
a second transaction locks and rechecks the actor and target before writing.


## Private PDF originals

`POST /api/v1/documents/pdf` requires a current session, Origin, CSRF token,
and an `Idempotency-Key` (1–200 visible ASCII characters). Send multipart
`file` and optional `title` in either order. Uploads stream to private immutable
objects; the default limit is 256 MiB, one file, and four multipart parts. Unknown
fields, duplicate titles, and trailing invalid parts fail before any document
reference commits. `%PDF-` must occur entirely within the first 1024 bytes.
This only accepts an original for storage: the returned status remains
`original-saved` / `awaiting-local-processing`, with no claim of parser success.

`GET /api/v1/documents` accepts `q`, `page` (default 1), and `pageSize`
(default 20, maximum 100). Title search treats `%` and `_` literally.
`GET /api/v1/documents/:id` returns the owner-scoped summary and source identity.
`GET` / `HEAD /api/v1/documents/:id/source` and
`GET` / `HEAD /api/v1/assets/:id/content` return only the current owner's PDF,
including for administrators. Source responses support single and suffix byte
ranges; invalid/multiple ranges return 416 with `Content-Range: bytes */size`.
Use `?download=true` for attachment disposition. Private successes and errors use
`Cache-Control: no-store`; filenames are encoded and object keys remain internal.

Retrying the same owner's idempotency key compares streamed content SHA-256;
a different file returns 409. The same owner's identical PDF returns the existing
document; another owner saves an independent document and asset. In-flight
keys return 409 / `Retry-After`; failed claims retry with a higher epoch. Claims
left receiving for over 15 minutes can be recovered, and old epochs cannot
commit. Account/session state is checked again after upload and validation.

After building, run `node apps/document-service/dist/cli/cleanup-staging.js`
with the service runtime environment to remove unreferenced objects and staging
files older than 24 hours. Cleanup checks database asset references under the
same publication lock used by uploads; never delete files directly. SQL/finalize
failures and duplicate successful uploads can leave unreadable orphan objects
until cleanup. Keep both the database and referenced objects in backups.

`createDocumentsService({ db, store, maxPdfBytes? })` exposes `savePdf`, `list`,
`get`, and `getAsset`. `get`/`list`/`savePdf` return shared document DTOs;
`getAsset` returns internal owner-scoped file metadata for the response adapter.
`savePdf` accepts an optional internal `finalize()` hook, awaited exactly once
after the stream is stored and before rechecking the actor and publishing any
reference. It returns final `{ title? }` metadata after validating/draining
remaining multipart parts. Plain async-body callers need no hook.


## Personal provider settings and connection tests

`GET` / `PUT /api/v1/settings/provider` read and update the authenticated user's
profile. Reads expose only settings, revision, and `hasApiKey`; keys are encrypted
with the runtime keyring. Saving settings and reading PDFs never call a model.
`POST /api/v1/settings/provider/test` accepts an empty body or `{}`, requires
Origin and CSRF, and uses only that user's saved profile and a fixed short block.
It makes one SDK Provider call without retries and validates the returned block
with the SDK validator. Results expose only `ok`, `profileRevision`, optional
`usage`, and `checkedAt`. Failed calls return sanitized service errors.

Each test has a ten-second total deadline, an output cap of 128 tokens, and a
1 MiB decoded response limit. A committed PostgreSQL reservation enforces five
attempts per user per minute, including upstream failures. Account, session, and
profile changes invalidate in-flight tests: serialized checks run every 100 ms
after the previous check completes and once again before accepting a result.
Disconnects and revoked credentials abort the transport; no database transaction
is held across network I/O. Already-running database queries can finish after
cancellation but cannot start a late model call.

Production and local modes use direct Undici transport with HTTPS only, full
DNS-answer validation, a pinned numeric IP, original-hostname TLS certificate
verification, and actual peer verification before request bytes are released.
Mapped/transition/special addresses and IPv6 outside global `2000::/3` are
rejected. Redirects and ambient proxies are not used. Responses are buffered
within the size/time limits and each request's dispatcher is destroyed.
`outboundFetch` injection is permitted only in test mode. Unit tests use in-memory
sockets; integration tests use fake Provider responses, never real API keys.


## Bundle ingestion and immutable Reader versions

`createBundleImportsService({ db, store, config })` is the application boundary for
`create(actor, { targetDocumentId? }, idempotencyKey)`,
`receive(actor, importId, AsyncIterable<Uint8Array>, signal?)`, `get(actor, id)`,
`list(actor)` and `cancel(actor, id)`. All return contract `BundleImport` views
(`list` returns an array), without owner IDs or object keys. HTTP adapters must
obtain the actor from the existing session/CSRF guards. `receive` resolves only
after publication; failures reject with sanitized `ServiceError` and persist an
error code readable through `get`. A completed import returns its existing view
on repeat receive. Retry a failed import with receive to acquire a higher epoch,
or create a new import. Cancelled imports require a new import; completed ones
reject cancellation with `BUNDLE_IMPORT_COMPLETED`.

The process accepts one active receiver; the database permits one active import
per owner, including `created` requests. Contention returns `BUNDLE_IMPORT_BUSY`.
Owner-scoped idempotency keys bind the creation request. Package identity is
owner + packageId + canonical manifest digest; conflicting package/parse/
translation identities return `BUNDLE_IDENTITY_CONFLICT`. An explicit target
must belong to the actor and have the same PDF hash and bytes. Otherwise only
that owner's matching original is reused. Historical package retries never
move current backwards. Completed/not-required translations are protected from
incomplete replacements; partial translations are protected from empty ones,
and full successful parses are protected from partial-parse replacements.
New incomplete versions remain in history, and a first source/partial version
can be current.

Uploads stream into exclusive 0600 UUID files under `bundle-staging/` (0700).
The upload deadline is 15 minutes. Validation, SDK replay, renderer work and
chunk JSON serialization run in a terminable Node worker with a five-minute
parent deadline and only `LANG`/`TZ` in its environment. The parent owns actor
checks, 15-second database heartbeats, cancellation and storage/publication.
The worker receives only a private input path and public BundleLimits; no
runtime config, keyring, user key, parser, Python or provider is involved.
All original bundle files, the exact uploaded ZIP, and generated structured
Reader index/chunks become immutable registered assets. No uploaded executable
file is used as site code.

Publication uses short transactions: actor/user, import, document, then the
shared `(204716,2)` object lock. Under that lock all new and reused referenced
objects are statted before references/current change atomically. Expired claims
(15 minutes without a heartbeat) fail with `BUNDLE_LEASE_EXPIRED` on get/list/
create/receive or cleanup. A running receiver rechecks its epoch and account at
publication; heartbeat loss also aborts its worker. Cleanup preserves every
registered asset, removes unreferenced objects/staging after 24 hours, and
removes orphan bundle input files after 15 minutes only when no fresh active
import owns that staging UUID.

`RuntimeConfig.bundleLimits` contains the effective frozen-contract defaults.
`PAGELINGO_BUNDLE_LIMITS_JSON` accepts a strict partial JSON object, for example
`{"maxArchiveBytes":134217728,"maxNodes":50000}`. Values must be positive safe
integers; structural limits can only tighten. `maxPdfBytes` is excluded from
this JSON and continues to derive from `PAGELINGO_MAX_PDF_BYTES`.

Reader persistence uses owner/document/source compound foreign keys.
`parse_runs.id` is the ReaderIR text parse ID; `translation_runs.id` is its
immutable snapshot UUID. `reader_versions.id` is server generated and stores
source/parse/translation identities, package identity, archive/index asset IDs.
`bundle_files` maps version + original path to an asset; `reader_chunks` maps
version + chunk ID to a generated JSON asset. `reading_state` starts at revision
0 with null position; later progress writes use its document-wide CAS and
`reading_positions` for each version's history. Position JSON repeats the
source/parse/reader identities, constrained to agree with the compound refs.

## Private Reader HTTP API

All routes use `/api/v1`, require a current session and return `Cache-Control:
no-store`, including errors and HEAD/Range responses. Writes also require the
site Origin and session CSRF token. Administrator sessions have no additional
access to another user's documents. Client owner fields and unknown query/body
fields are rejected.

`GET /bundle-imports/limits` returns the effective `BundleLimits`.
`POST /bundle-imports` takes `{targetDocumentId?}` and `Idempotency-Key`, returning
201 with `BundleImport`. `GET /bundle-imports` returns the newest 20 own imports;
`GET /bundle-imports/:id` returns one. `PUT /bundle-imports/:id/content` accepts
an `application/zip` stream after authentication and CSRF checks, without
buffering the archive. It returns the completed import, or a sanitized error
whose durable status can be queried. A completed import rejects PUT with 409
`BUNDLE_IMPORT_COMPLETED`; `POST /bundle-imports/:id/cancel` takes `{}`.
Internal `BUNDLE_SOURCE_CONFLICT` is publicly `SOURCE_MISMATCH` in both errors
and import status views. Validation errors retain `INVALID_BUNDLE`,
`BUNDLE_TOO_LARGE`, `BUNDLE_MISSING_RESOURCE`, and `BUNDLE_IDENTITY_CONFLICT`.

`GET /documents/:id/reader?versionId=...` returns `ReaderDescriptor`; omitted
versionId selects the protected current version. `GET /documents/:id/reader-versions`
returns `ReaderVersionList` with `page=1`, `pageSize=20` defaults and pageSize at
most 100. Stored historical versions remain accessible even when import did not
promote them. The descriptor retains source identity, structured index,
translation/parse status, generation-kind and warnings. Its assetMap maps logical
asset IDs to server UUIDs, resolved through this version's validated ReaderIR
images and registered bundle files.

`GET /documents/:id/readers/:versionId/chunks/:chunkId` returns a schema-validated
`ReaderChunk`. `GET/HEAD /documents/:id/readers/:versionId/assets/:assetId` serves
only this version's referenced PNG/JPEG/WebP with nosniff. HTML, JS, CSS, fonts,
provenance, and arbitrary asset UUIDs are unavailable through this route.
`GET/HEAD /documents/:id/readers/:versionId/bundle` streams the exact verified ZIP
as an attachment. Both binary routes share original-PDF Range, HEAD, ETag and
416 behavior; authentication and object existence precede metadata. These read
routes do not invoke a parser, renderer build, translation model or bundle worker.
JSON reads verify the immutable registered size, SHA-256 and contract schema;
tightening future upload byte budgets does not hide already published versions.

Image delivery derives a small immutable allowlist from the verified IR once per
cold version, without loading its index. This hashing/schema work runs outside
the user-lock transaction. The per-service cache retains at most 32 versions and
4 MiB of serialized image metadata, with a five-minute validity period and lazy
expiry/LRU eviction. At most four distinct cold validations run at once;
concurrent requests for the same version share one. Failed or oversized loads
are not retained. Keys include owner/document/version/IR asset identity. Cache
entries contain only registered image IDs, object keys, hashes, byte sizes and
media types: no whole IR, response body or authorization result is cached.
Every request still authenticates the current actor/version before lookup and
again before delivery, checks fresh version-file/asset bindings against the
validated metadata, and stats the actual image object, including HEAD/Range.
Restarting the service starts with an empty cache.

`GET /documents/:id/progress` returns the actual last acknowledged
`ReadingProgress`, or null before the first save. `PUT` takes
`{expectedRevision,position}` and uses document-wide CAS, starting at revision 0.
A successful write increments revision and preserves that version's history in
the same transaction. A stale revision returns 409 `PROGRESS_CONFLICT` without
changing any position or state row. A historical-version save with a fresh
global revision is valid. Source/parse/reader/block identities, page bounds and
offsets are validated; independent PDF and content scrolling means a saved PDF
page need not match the text block's source page.

Descriptor progress is an **effective restoration**, distinct from GET progress:
prefer the selected version's saved history; otherwise reuse the last position's
block only when parse and block still match. Otherwise return the physical page
(clamped to source page count), blockId=null, blockOffset=0 and
`restoreHint='version-updated-source-page'`. This effective position always carries
the current document-global acknowledgement revision and updatedAt, including
when its coordinates came from older version history. Opening/restoring performs
no write. The UI must wait for deliberate reading interaction before saving;
409 requires an explicit user decision instead of an automatic overwrite retry.

Reader descriptor includes required `pages: PdfPageMetadata[]`, copied from the validated and hash-bound stored IR. It is nonempty and ordered by physical pageIndex 0..length−1; clients compare this metadata and page count with actual PDF.js geometry before showing region highlights. No extra metadata endpoint or client-supplied geometry is accepted.

## S2 delivery acceptance

See [S2 validation](../../docs/learning-site-s2-validation.md) and
[reader workflow](../../docs/pdf-reader-workflow.md) for explicit local corpus inputs,
offline resource checks, capacity measurements and upgrade/restart scope.
Default checks use mocks and do not install Python/models or call paid APIs.

## S3 private Web captures

Capture ingestion accepts either a session (Origin/CSRF on writes) or a paired
device with the required capture scope. Explicit Authorization never falls back
to a cookie. `POST /api/v1/captures` takes the strict `CreateWebCaptureRequest`;
`Idempotency-Key` must equal the manifest's persistent client `captureId` UUID.
The returned `id` is a separate server ingestion UUID. Resume with
`GET /api/v1/captures/:id`, PUT each missing file to `/:id/files/:fileId` using
its declared Content-Type, then POST `/:id/commit`. File retries restart that
file, not a byte range. POST `/:id/cancel` fences outstanding work. Repeating a
completed create/commit returns its durable result after a lost acknowledgement.

Actual file bytes/hash, images, resource closure, sanitization, previews, source
projection and imported SDK result proofs are checked on the server. CPU work
runs in a terminable worker outside user locks. Files are published immutably
before a short guarded reference transaction. Source-only, Chinese and no-Key
captures require no model call. `translationIntent` is retained; the default app
has no paid-job publication hook installed and never starts historical backlog.
Imported proofs use `web-imported-translation/1` rather than invented model-job
metadata. A later import can add a Reader to an existing source; the rare
`CAPTURE_REBASE_REQUIRED` conflict means retry commit on the same ingestion.

The library/get APIs return the PDF|Web summary union. Existing PDF source,
asset and Reader APIs remain PDF-only. Web reading routes are session-only:

- `GET /api/v1/documents/:id/web-reader` (optional `versionId`)
- `GET /api/v1/documents/:id/web-reader/versions` (`page`, `pageSize`)
- `GET /api/v1/documents/:id/web-reader/versions/:versionId/chunks/:chunkId`
- `GET /api/v1/documents/:id/web-reader/versions/:versionId/assets/:assetId`
- `GET /api/v1/documents/:id/web-snapshots/:sourceVersionId/manifest`
- `GET /api/v1/documents/:id/web-snapshots/:sourceVersionId/files/:fileId`
- `GET / PUT /api/v1/documents/:id/web-progress`

The descriptor maps local resource IDs to registered asset UUIDs. Only those
UUIDs are usable through the version's image endpoint. HTML/CSS downloads use
attachment, application/octet-stream and nosniff; previews must be displayed by
the isolated client adapter, never as live main-origin HTML. Reads are no-store
and make no network/model calls. Progress PUT uses `{expectedRevision,position}`
and document-wide CAS; 409 does not overwrite another reader's position.

`PAGELINGO_CAPTURE_LIMITS_JSON` may tighten `defaultCaptureLimits` but cannot raise
the frozen ceilings. The default file-request timeout is 20 seconds and worker
validation deadline is 60 seconds. Cleanup retains every published asset/history
reference, waits at least 24 hours before collecting orphan objects, and clears
stale unfinished upload references so missing files can be uploaded again.

## S3 links and public fetch jobs

`POST /api/v1/documents/links` accepts the unchanged `CreateDocumentLinkRequest`
(`url`, optional `title`/`kind`, `translationIntent`) and a required UUID
`Idempotency-Key`. Persist that key and the request before sending. Session writes
require Origin/CSRF; devices require `links:write` and must omit cookies. A fresh
or repeated successful request returns 201 `{documentId,jobId}`. Reusing a key
with changed normalized input returns 409 `IDEMPOTENCY_CONFLICT`; a missing or
invalid key returns 400 `INVALID_REQUEST`. No owner field is accepted.

The immutable `web_link_requests` ledger scopes keys to their authenticated
owner. Tracking-only URL differences normalize away, ordinary query/hash remain.
The same owner/source reuses a document and the same immutable fetch input reuses
its job within the current authVersion. A replay of an older acknowledgement
returns its original result without reviving its old job. X, Zhihu, WeChat,
repository and paper sources remain links; browser-only and unsupported reasons
are retained in the ledger. A failed fetch retains the link and its job's
`FETCH_CAPTURE_UNAVAILABLE` reason (or `FETCH_BROWSER_REQUIRED` for login/browser content). Saving and ordinary reading make no model calls.

`runFetchJob(lease, {db,store,config,signal,onPublication?})` is the lease-authorized
runner for `fetch-link` jobs. Task 11 supplies claim/heartbeat, the abort signal,
auth/lease cancellation monitoring and retry orchestration. The runner checks the
real user/job/slot epochs before acquisition and final publication; it never uses
a fabricated session or device. Successful publication completes the fetch job
and releases its matching slot in one transaction. A normal unavailable/invalid
article marks that job failed while retaining the link. A stale or aborted lease
throws without publishing or finalizing; the orchestrator must reconcile it.

The first acquired response is registered as an immutable asset and bound through
`web_fetch_acquisitions` to its owner/document/authVersion/job and a separate
job-origin `web_captures` ingestion/capture UUID. Retries reuse those exact bytes
and timestamp. Raw HTML is downloadable as `uploaded:<raw_asset_id>` after
publication; the authoritative manifest/Reader uses the separately sanitized
article. Upload expiry does not clear these durable acquisitions. Bounded scratch
files are disposable. Readability, sanitization, previews and projection run in
the existing terminable worker; network and heavy work stay outside DB locks.
Exact login/auth route segments and actual parsed password inputs trigger a
conservative browser-capture fallback; even an article with a password modal may
remain a link. Escaped code examples and script strings do not count as controls.
This gate applies only to public fetches, not logged-in extension snapshots.
Resources unavailable to this public fetch (including document-bound blobs) are
explicitly missing and never passed to a generic fetch. The optional publication
hook is the same durable scheduling interface as capture ingestion; Tasks 9/11
must enforce language/preferences/provider revisions and job identity when wiring
it. No hook or paid backlog is enabled by the default application.

`createCaptureFetch` permits credential-free HTTP(S) GET/HEAD, queries and at most
five redirects, revalidating DNS and the actual pinned peer at every hop. It
rejects userinfo, private/metadata/mapped addresses and HTTPS downgrade; its
20-second configured deadline covers redirects and decoded body consumption.
Only Accept, Accept-Language and User-Agent request headers are forwarded.
`createProviderJobFetch` keeps HTTPS/queryless/nonredirecting provider policy but
returns response headers before SSE finishes, bounding decoded consumed bytes.
Its Agent stays alive until EOF, body cancellation, caller abort or deadline.
The existing buffered `createOutboundFetch` retains its old policy and lifecycle.
All three use the shared DNS/TLS/actual-peer connection layer; no production
private-network override exists. The fetch runner's replacement fetch dependency
is accepted only in test mode.

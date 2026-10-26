# 文档服务

S1 / 0.1.0 已实现运行配置、PostgreSQL 迁移、health API、管理员初始化、登录 / 会话 / 修改密码、账号管理、本人 PDF 原件 API、个人模型配置与显式连接测试。网站、API 和静态 PDF 解码资源可由同一服务提供。安装、Compose、密钥初始化与开发命令见 [学习站安装指南](../../docs/learning-site-install.md)，交付边界与证据见 [S1 验证记录](../../docs/learning-site-s1-validation.md)。

账号、原件、资源和 Provider 均按当前会话 owner 隔离；管理员只额外管理账号。数据库、对象卷和主密钥在运行时注入。Dockerfile 使用固定 Node 镜像，多阶段构建及非 root runtime；Compose 是 loopback local 预览，并非公网生产部署。

S2 将在独立迁移中加入解析 / 翻译 run、包导入和完整译文 Reader。当前只有原件、source version 与不可变对象存储，没有运行中的 parser / translation worker 或导入路由。来源绑定使用 `documents.current_source_version_id`；未来包必须绑定同一 owner / document / source。后台任务、助手、设备授权与完整备份恢复按后续阶段实现，设计见 [PDF 规格](../../docs/pdf-spec.md) 与 [处理设计](../../docs/pdf-processing.md)。

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

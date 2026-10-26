# 文档服务

已注册为独立 npm workspace，当前实现运行配置、PostgreSQL 迁移、health API、初始管理员、登录 / 会话 / 修改密码、管理员账号管理及本人 PDF 原件 API；模型配置 API 尚未接入。[个人学习站 V1 设计稿](../../docs/superpowers/specs/2026-10-26-personal-learning-site-design.md)已于 2026-10-27 获批，管理员已可手工开通账号；S1 后续任务将使用 TypeScript 实现各用户独立资料与 API 配置、持久化任务和共享翻译 SDK 调用。后续再接入站内助手。账号、任务、原件与资源读取采用同一用户隔离边界。

API 与 worker 可属于同一个包、使用不同入口；重解析和重译都有独立 run ID。PDF 解析调用 `services/document-parser` 的独立进程，不重写 Python 翻译引擎。具体协议、取消与恢复约束见 [PDF 规格](../../docs/pdf-spec.md) 和 [架构](../../docs/monorepo.md)。

允许本机处理后导入服务器：处理机导出原件、版本化 IR / 译文、阅读快照与资产 manifest；服务校验文件 / checksum 后写入 ObjectStore、登记 PostgreSQL，重复导入幂等。后续可通过任务接口拆分 GPU worker 与阅读服务器。静态 HTML 是可重建产物，业务依据仍为 IR / 译文与运行数据；见 [处理设计](../../docs/pdf-processing.md)。导入与快照服务尚未实现。

本机与服务器统一使用 PostgreSQL 保存文档、运行、任务 / 检查点、按块译文 / 缓存、术语、对话与阅读位置；数据库访问集中在 repository，schema 用版本化迁移管理。PDF、raw parser 输出、完整 source IR 与图表资产通过 ObjectStore 保存，首版 LocalObjectStore 使用可配置的持久化目录，后续 S3 adapter 必须验证同一读写 / checksum 合同。

存储 backend、对象 key 与 checksum 留在服务内，前端只使用文档 / 资产 ID；绝对路径与数据库凭据不进入 Reader 协议或 SDK。对象校验完成后再提交数据库引用；任务有 lease / epoch、版本与取消条件，防止重启后旧结果覆盖新运行。完整设计见 [存储边界](../../docs/pdf-spec.md#84-storage)。

部署规划为 Compose 中的独立 API / worker 入口、PostgreSQL 与持久卷。`DATABASE_URL`、`PAGELINGO_DATA_DIR` 及加密主密钥在运行时注入；各用户 API Key 加密保存，排除日志、快照及普通 settings 响应。parser 子进程采用环境变量白名单。服务器使用 HTTPS、会话与可撤销设备授权；备份包含数据库、引用对象及恢复所需的密钥材料，并验证在空环境 / 另一台主机上的恢复。当前已有数据库迁移和运行服务，尚无生产 Dockerfile 或 Compose。


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

After `npm run build:contracts`, inject the same service runtime variables and
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

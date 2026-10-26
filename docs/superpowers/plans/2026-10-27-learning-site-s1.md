# Learning Site S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付能登录、手工开通用户、配置个人 API，并上传、列出和查看本人 PDF 原件的基础网站。

**Architecture:** React 网站与 Fastify 文档 API 使用共同版本化协议。PostgreSQL 保存账号、会话、个人配置和文档引用，LocalObjectStore 保存不可变 PDF；所有业务操作从认证身份确定用户。开发使用 Vite 代理，S1 本机 Compose 使用 API 同源提供构建后的网站；PDF 翻译 / 阅读包、网页采集和 worker 分别在后续阶段接入。

**Tech Stack:** Node.js 24.13.0、TypeScript 7.0.2、React 19.3.0、Vite 8.3.2、Fastify 5.12.7、PostgreSQL 17.11、Zod 4.6.5、Tailwind CSS 4.3.3、Vitest 5.0.3、Playwright 1.63.0。

**Spec:** [2026-10-26-personal-learning-site-design.md](../specs/2026-10-26-personal-learning-site-design.md)，用户于 2026-10-27 批准。

状态：用户于 2026-10-27 授权计划完成后直接执行，无需再审批。实现方采用下文推荐的 Subagent-driven 方式，任务进度记录在执行 ledger。

## Global Constraints

- 各用户保存自己的数据，首版不共享。所有业务读取、写入、任务领取和文件响应都从会话 / 设备身份取得 owner，忽略客户端自报 owner。
- 管理员角色只额外开放账号管理 API，资料读取仍按所属用户执行。
- 账号由管理员开通。网站提供登录，用户可修改自己的密码。
- 每个用户填写自己的模型 API。设置读取只返回脱敏状态和非敏感字段。
- 用户 Key 不写入任务快照、日志、HTML、普通资料导出或 parser 环境。
- 原件、raw、source IR 和已完成译文版本不可原地覆盖。
- 数据库和持久化接口属于 document-service；SDK 不引入 DOM、浏览器、数据库或磁盘依赖。
- 默认 npm 检查不安装 Python / 模型，也不调用真实 LLM。
- 原 P0 产物和已发布包保持不变，所有新处理写入新 run / 目录。
- 使用 strict TypeScript、ESM、两空格、单引号、分号；沿用锁文件和独立 workspace。

## Review Focus

1. 另一个用户和管理员猜测文档 / 资产 ID、发送 Range 或复用上传幂等键时，不能读取、覆盖或确认其他用户资料。任务 5、9、10 覆盖。
2. 上传或连接测试进行中，账号被停用 / 重置密码，旧请求不能在之后提交成功结果；旧 Cookie、浏览器缓存和在途页面数据不能跨账号复用。任务 4、5、7、8、9 覆盖。
3. 用户 API Key 被调换 owner、更新时留空、使用错误主密钥或出现在异常路径时，不能变成明文、静默清空或泄露给页面 / 日志。任务 6、7、8 覆盖。
4. 上传中断、损坏 PDF、伪造文件名、对象写入后数据库失败、重复请求和容器重启，不能发布不存在的文件或改写原件。任务 5、9、10 覆盖。
5. 自定义 Base URL 经过私网 DNS、IPv6 映射、重绑定或重定向访问内部地址时，不能携带用户凭据越过出站策略。任务 7 覆盖。

## 1. 本阶段范围与执行约定

S1 实现 Spec 的 A01、A03，以及 A02 / A07 / A13 / A15 / A16 中与账号、个人 API、PDF 原件、重启和既有回归有关的部分。网页收藏、译文包导入、双屏阅读、集合 / 标签、回收站和正式公网部署分别归 S2–S5。S1 页面只展示已经接通的功能，不用示例资料或假进度代替业务状态。

使用 `using-git-worktrees` 创建或复用隔离工作区，建议分支 `feat/learning-site-s1`，先运行现有 `npm run check` 取得基线。任务按 1–10 执行；每个任务先验证失败行为，再实现、验证和提交。UI 的主要验证使用真实后端的 Playwright，不为颜色与静态文案编写镜像单元测试。

### 1.1 依赖版本

以下版本于 2026-10-27 从 npm Registry 核对；实施使用 `--save-exact` 并提交 `package-lock.json`。已有 React、Vite、TypeScript、Zod、Vitest 和 Playwright 版本继续复用。

| 使用位置 | 新增直接依赖 |
| --- | --- |
| document-contracts | `@pagelingo/translation-core@0.4.0`、`zod@4.6.5` |
| document-service | `@pagelingo/document-contracts@0.1.0`、`@pagelingo/translation-core@0.4.0`、`zod@4.6.5`、`fastify@5.12.7`、`@fastify/cookie@11.1.3`、`@fastify/multipart@10.1.6`、`@fastify/helmet@13.2.0`、`@fastify/static@10.1.7`、`pg@8.23.1`、`undici@7.30.0`、`ipaddr.js@2.5.0`；开发依赖 `@types/pg@8.23.1`、`tsx@4.23.15` |
| web | `@pagelingo/document-contracts@0.1.0`、`react@19.3.0`、`react-dom@19.3.0`、`react-router-dom@7.18.4`、`@tanstack/react-query@5.105.0`、`lucide-react@1.61.0`、`pdfjs-dist@6.4.299`、`@radix-ui/react-dialog@1.3.1`、`@radix-ui/react-alert-dialog@1.2.1`、`@radix-ui/react-slot@1.5.0`、`class-variance-authority@0.7.1`、`clsx@2.1.1`、`tailwind-merge@3.7.0`；开发依赖 `tailwindcss@4.3.3`、`@tailwindcss/vite@4.3.3` |

按需引入 shadcn 风格的基础组件到本项目，使用上表 Radix primitives 与统一 token，不在实现过程中运行会改动配置的 `shadcn@latest init`。数据库镜像固定 `postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe`；卷挂载 `/var/lib/postgresql/data`。Node 镜像与 `.nvmrc` 一致，生产补丁升级另行验证。

参考：[Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)、[PostgreSQL 版本策略](https://www.postgresql.org/support/versioning/)、[Tailwind Vite 接入](https://tailwindcss.com/docs/installation/using-vite)、[PDF.js 示例](https://mozilla.github.io/pdf.js/examples/)。精确 npm 版本可通过 `https://registry.npmjs.org/<package>/<version>` 核对。

### 1.2 固定的运行与安全参数

| 项目 | S1 决定 |
| --- | --- |
| API | `/api/v1`；响应头 `X-PageLingo-API-Version: pagelingo-site-api/1`，JSON 直接返回对应 DTO；未知字段拒绝；错误 `{ error: { code, message, requestId } }` |
| 用户名 | 归一化小写，`[a-z][a-z0-9_-]{2,31}`；密码原样处理，12–128 个 Unicode 码点，不裁剪空白或静默截断 |
| 密码哈希 | Node `crypto.scrypt`，`N=131072,r=8,p=1,maxmem=192 MiB`，随机 salt 16 字节，输出 64 字节；版本化编码，比较用 `timingSafeEqual` |
| 会话 | 随机 32 字节 opaque token，数据库只存 SHA-256；绝对有效期 7 天；每次请求检查用户 active / authVersion |
| Cookie 与 CSRF | production：`__Host-pgl_session`、HttpOnly、Secure、SameSite=Lax、Path=/；local/test 使用无 Secure 的 `pgl_session`，只允许 loopback public origin；所有写请求校验 Origin，认证写请求另校验 `X-CSRF-Token` |
| 登录限制 | 每 IP 及归一化用户名组合 15 分钟最多 5 次失败；相同 IP 15 分钟最多 30 次失败；PostgreSQL 原子计数，返回 429 / Retry-After |
| Key 存储 | AES-256-GCM，随机 nonce 12 字节、tag 16 字节；AAD 为 `pgl:provider:v1:<userId>`；主密钥 ID 与 keyring 来自运行环境 |
| PDF 上传 | 默认 256 MiB、一次一个文件、最多 4 个 multipart part；流式处理，前 1024 字节中识别 `%PDF-`；配置可降低测试上限 |
| 文件读取 | 认证后返回本人原件；支持单一 byte Range / suffix Range；多 Range 或不可满足范围返回 416；私有响应 `Cache-Control: no-store` |
| 连接测试 | 用户显式触发，使用已保存 profile，最多一次 SDK Provider 调用；总时限 10 秒、输出上限 128 tokens、响应体上限 1 MiB；每用户每分钟最多 5 次 |
| 出站地址 | 仅 HTTPS、无 userinfo / query / fragment；只允许公有单播 IP，校验全部 DNS 结果并绑定实际连接；Provider 请求不跟随重定向 |
| 开发端口 | API `127.0.0.1:4320`；Vite `127.0.0.1:5174` 代理 `/api`；测试使用独立端口或动态端口 |
| CSP | 同源 script / connect；PDF worker / 图片 / 字体按需允许同源与 blob / data；禁止 object / base / 外部 frame ancestor；Radix 与 PDF 布局需要的 inline style 仅限样式。local 模式关闭 upgrade-insecure-requests |

密码参数依据 [OWASP scrypt 配置](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)与 [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。本阶段选择 Node 内建稳定实现，避免为首版引入原生密码扩展；哈希算法和参数写入存储编码，可升级迁移。Scrypt 并发最多 2，排队上限 8，超限返回 429，避免高内存并发。

### 1.3 文件与职责

| 位置 | 职责 |
| --- | --- |
| `packages/document-contracts/src/{auth,provider,documents,errors,index}.ts` | 公开 DTO、输入 / 输出 schema；复用 SDK 的 Provider / glossary 公开类型 |
| `apps/document-service/src/{config,app,main}.ts` | 运行配置、依赖装配、HTTP 启停 |
| `apps/document-service/src/db/` | PostgreSQL pool、事务、不可变迁移及测试 schema 支持 |
| `apps/document-service/src/auth/`、`users/` | 密码、会话、CSRF、尝试频率与用户管理 |
| `apps/document-service/src/providers/`、`network/` | 加密配置、个人连接测试和受控出站传输 |
| `apps/document-service/src/storage/`、`documents/` | 对象文件、Range、上传提交与本人资料查询 |
| `apps/web/src/{app,shared,features}/` | 页面路由、统一 UI 与 token、auth / library / accounts 功能 |
| `tests/fixtures/pdf.ts` | 可再生合成 PDF，供服务与浏览器测试使用 |
| `scripts/with-test-postgres.mjs` | 创建一次性 PostgreSQL，运行子命令并清理自己创建的资源 |
| `deploy/`、`scripts/*site*.mjs` | 本机启动、镜像、持久卷和重启验收 |

### 1.4 命令与测试边界

| 根命令 | 实现约定 |
| --- | --- |
| `build:contracts` | `npm run build:sdk && npm run build --workspace @pagelingo/document-contracts` |
| `build:service` | `npm run build:contracts && npm run build --workspace @pagelingo/document-service` |
| `build:site` | `npm run build:service && npm run build --workspace @pagelingo/web` |
| `typecheck` / `test` | 先 `build:contracts`，再运行各 workspace 的对应命令；保留原 extension / SDK 检查 |
| `test:service` | `build:contracts` 后运行 service 的 `test`，仅 include `tests/unit/**/*.test.ts` |
| `test:service:db` | with-test-postgres 包装 service 的 `test:integration`；构建 contracts 后由 Vitest 直接加载服务 TypeScript，运行 `vitest.integration.config.ts`，include `tests/integration/**/*.test.ts`，参数传递给 Vitest |
| `test:site:e2e` | with-test-postgres 包装 `build:site` 与 web 的 `test:e2e`；测试服务使用临时 schema / dataDir 和模拟出站 Provider |
| `check:site` | 一个 with-test-postgres 生命周期内依次 `build:site`、service 集成和 web e2e，不重复启动多套库 |

`@pagelingo/document-service` 和 `@pagelingo/web` 的初始版本均为 0.1.0。默认 `dev` / `build` 继续是现有扩展入口；网站入口显式使用带 site 的命令。Docker / PostgreSQL 只由显式 site 集成检查要求，不能让默认检查因缺少测试数据库而静默漏测。

## 2. 共同协议与实现接口

下列名字在任务之间保持一致，具体字段 schema 由任务 1 定义。数据库主键均为 UUID，时间以 ISO-8601 返回。

- `PublicUser = { id, username, role: 'admin'|'user', active, createdAt }`；无密码哈希和 authVersion。
- `SessionView = { user: PublicUser|null, csrfToken: string|null }`；登录成功只通过 Set-Cookie 返回会话 token。
- `Actor = { userId:string, role:'admin'|'user', authVersion:number, sessionHash:string }`，sessionHash 为 64 字符 SHA-256 hex；仅存在 document-service，不进入请求正文或前端 DTO。
- `ProviderProfile = { revision, baseUrl, model, temperature, responseFormat, maxOutputTokens, maxTokensParameter, thinkingMode, stream, maxInputTokens, contextWindowTokens, hasApiKey }`；初始 revision=0、baseUrl/model 为空、hasApiKey=false，其余默认值依次为 0.1、json-object、4096、max_tokens、auto、false、6000、32768。
- `ProviderProfileUpdate = { expectedRevision:number, settings:Omit<ProviderProfile,'revision'|'hasApiKey'>, key: { action:'keep' } | { action:'replace', value:string } | { action:'delete' } }`；expectedRevision 是非负整数，profile 更新冲突返回 409。
- `SourceIdentity = { documentId, sourceVersionId, sha256, assetId, bytes }`；S2 用此绑定包，文件名或标题不作内容身份。
- `DocumentSummary = { id, kind:'pdf', title, originalFilename, createdAt, source:SourceIdentity, saveStatus:'original-saved', processingStatus:'awaiting-local-processing' }`。
- `DocumentList = { items:DocumentSummary[], total, page, pageSize }`；页码从 1 开始，默认 pageSize=20、上限 100，标题搜索 q 上限 200 字符，排序 createdAt 降序 / id 降序。
- `Database = { pool, transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>, close():Promise<void> }`；同一事务只使用同一个 client。
- `RuntimeConfig` 包含 `mode:'local'|'production'|'test'`、publicOrigin、host、port、dataDir、databaseUrl、可选 webDir、`keyring:{activeKeyId:string,keys:Readonly<Record<string,Uint8Array>>}`、maxPdfBytes；生产 origin 必须 HTTPS，local/test origin 必须 loopback。
- `createApp({ config, db, outboundFetch? }: AppOptions): Promise<FastifyInstance>`；`outboundFetch?: typeof fetch` 只供受控传输注入。app 不关闭调用方传入的 pool，main / 测试显式关闭它。

配置变量固定为 `PAGELINGO_SITE_MODE`、`PAGELINGO_SITE_ORIGIN`、`PAGELINGO_SERVICE_HOST`、`PAGELINGO_SERVICE_PORT`、`PAGELINGO_DATA_DIR`、`DATABASE_URL`、`PAGELINGO_WEB_DIR`、`PAGELINGO_MASTER_KEY_ID`、`PAGELINGO_MASTER_KEYS_JSON`、`PAGELINGO_MAX_PDF_BYTES`。测试只从 runner 获取隔离库与临时目录。网站配置不存在时不回退使用原有 `PAGELINGO_LLM_*`，这些变量继续只供已有本地联调工具使用。

| HTTP 接口 | 行为 |
| --- | --- |
| `GET /health/live`、`GET /health/ready` | 进程与数据库 / schema 就绪；无敏感配置 |
| `POST /api/v1/auth/login` | `{ username,password }`，建立新会话并返回 SessionView |
| `GET /api/v1/auth/session` | 无会话返回 null 用户；有会话返回用户和 CSRF token |
| `POST /api/v1/auth/logout` | 撤销当前会话；`allDevices:true` 时递增 authVersion、撤销全部现有会话 |
| `POST /api/v1/auth/password` | `{ currentPassword,newPassword }`，更新后撤销本人旧会话，要求重新登录 |
| `GET/POST /api/v1/admin/users` | 管理员列表 / 创建普通用户；创建 body 为 `{ username,password }` |
| `PATCH /api/v1/admin/users/:id` | `{ active:boolean }`；停用撤销全部授权，保护最后一个有效管理员 |
| `POST /api/v1/admin/users/:id/reset-password` | `{ newPassword }`；只重置普通用户，撤销目标旧会话 |
| `GET/PUT /api/v1/settings/provider` | 本人的脱敏 profile / 原子更新；Key 更新采用显式 action |
| `POST /api/v1/settings/provider/test` | 使用当前用户已保存的 profile；结果只含状态、修订和用量 |
| `POST /api/v1/documents/pdf` | multipart file + 可选 title，要求 Idempotency-Key；只存本人 PDF |
| `GET /api/v1/documents`、`GET /api/v1/documents/:id` | 本人列表 / 详情；不存在和他人 ID 均返回 404 |
| `GET /api/v1/documents/:id/source` | 本人原件响应；支持 inline / 显式 download、Range、HEAD |
| `GET /api/v1/assets/:id/content` | 与原件相同授权与响应规则，供 S2 复用；不能直接按对象 key 访问 |

## Task 1: 公共协议成为可消费的独立 workspace

**Files:** Create `packages/document-contracts/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts}`、`src/{auth,provider,documents,errors,index}.ts`、`tests/site-contracts.test.ts`；Modify `packages/document-contracts/README.md`、根 `package.json`、`package-lock.json`。

**Interfaces:** Produces 上节所有公共 DTO / schema，导出包名 `@pagelingo/document-contracts@0.1.0`、ESM dist 与声明；P0 JSON Schema 文件原样保留。不导出 Actor、数据库对象或 Keyring。

- [ ] **Step 1: 准备最小 package / Vitest 测试入口后写协议测试。** `site-contracts.test.ts` 验证用户 DTO 禁止 passwordHash / ownerId，profile 读取禁止 key.value；三种 key.action 的输入分别有效，replace 空字符串无效；PDF 摘要必须包含 SourceIdentity 和固定状态。

```ts
expect(providerProfileUpdateSchema.safeParse({ ...update, key: { action: 'replace', value: '' } }).success).toBe(false);
expect(publicUserSchema.safeParse({ ...user, passwordHash: 'private' }).success).toBe(false);
expect(documentSummarySchema.parse(summary).source.sha256).toMatch(/^[a-f0-9]{64}$/);
```

- [ ] **Step 2: 运行 RED。** `npm run test --workspace @pagelingo/document-contracts`，先得到缺少实现的失败，而非忽略测试。
- [ ] **Step 3: 实现 schema、导出和独立构建。** NodeNext / `.js` ESM imports；公开输出使用 strict schema。Provider 枚举和预算类型复用 translation-core 公共入口，不导入 extension 设置文件。根新增 `build:contracts`，根 typecheck / test 先构建 SDK 和 contracts；旧 `build:sdk` 保持独立包语义。
- [ ] **Step 4: 运行 GREEN。** `npm run build:contracts`、`npm run test --workspace @pagelingo/document-contracts`、`npm run typecheck`；全部通过并验证 SDK 原有导出不变。
- [ ] **Step 5: Commit。** `feat: establish learning site api contracts`。

## Task 2: PostgreSQL 迁移、运行配置与真实服务测试入口

**Files:** Create `apps/document-service/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts,vitest.integration.config.ts}`、`src/{config,app,main}.ts`、`src/db/{database,migrate}.ts`、`migrations/001-accounts.sql`、`002-providers.sql`、`003-documents.sql`、`tests/helpers/{database,app}.ts`、`tests/unit/config.test.ts`、`tests/integration/database.test.ts`、`scripts/with-test-postgres.mjs`；Modify 根命令、锁文件和 `.env.example`。

**Interfaces:** Produces `readConfig(env:NodeJS.ProcessEnv):RuntimeConfig`、`openDatabase(url:string, schema?:string):Database`、`migrateDatabase(db:Database):Promise<void>`、共同 `createApp(AppOptions)`。测试 helper `createTestDatabase():Promise<{db,dispose}>` 与 `createServiceTestApp(options?:{outboundFetch?:typeof fetch}):Promise<{app,db,config,close}>`，每次生成隔离 schema 与临时 dataDir。

- [ ] **Step 1: 先准备 service package / Vitest 与独立 PG runner 的最小测试基础，再写测试。** `database.test.ts` 验证重复迁移不重放、校验和变化与未知更高版本失败、事务异常回滚、并发迁移只执行一次；`config.test.ts` 验证未知 mode、非 HTTPS production origin、无效 32 字节 keyring 拒绝启动，日志不序列化配置。

```ts
await migrateDatabase(db);
await migrateDatabase(db);
expect((await db.pool.query('select count(*)::int as n from schema_migrations')).rows[0].n).toBe(3);
await db.pool.query('create table transaction_probe (id integer)');
await expect(db.transaction(async client => {
  await client.query('insert into transaction_probe values (1)');
  throw new Error('rollback');
})).rejects.toThrow('rollback');
expect((await db.pool.query('select count(*)::int as n from transaction_probe')).rows[0].n).toBe(0);
```

- [ ] **Step 2: 运行 RED。** `npm run test:service` 与 `npm run test:service:db -- tests/integration/database.test.ts`。前者仅运行 Node unit；后者通过独立 PostgreSQL 执行，连接失败必须报错，不能 skip。
- [ ] **Step 3: 实现服务与迁移。** 每个迁移有 ID / SHA-256，advisory lock 和事务使用同一个 pg client。表包含 users、sessions、auth_attempts、provider_profiles、documents、source_versions、assets、ingestions；owner 引用使用组合唯一键 / 外键，source 指针同时属于当前文档。用户保存 authVersion，敏感配置分列加密字段；S2 表以后增量迁移。
- [ ] **Step 4: 完善测试运行器的信号清理与外部隔离库模式。** Docker 起独立随机名 PostgreSQL、随机 loopback 端口，向子进程传 `PAGELINGO_TEST_DATABASE_URL`，finally 只清理自己创建的资源。外部隔离测试库可显式提供该变量；不回退到 DATABASE_URL。测试只创建 / 删除随机 `pgl_test_*` schema。服务 main 负责信号关闭，ready 路由验证 schema。
- [ ] **Step 5: 运行 GREEN。** 相同命令通过；`npm run build:service` 产生可启动的 health API。记录具体 image digest；默认 `npm test` 不要求 Docker，也不读取 `.env.local`。
- [ ] **Step 6: Commit。** `feat: add document service persistence foundation`。

## Task 3: 初始管理员、密码、登录与撤销会话

**Files:** Create `src/auth/{passwords,sessions,guards,rate-limit,routes}.ts`、`src/cli/bootstrap-admin.ts`、`tests/helpers/session.ts`、`tests/unit/passwords.test.ts`、`tests/integration/auth.test.ts`，均在 document-service；Modify `src/app.ts` 和 package scripts。

**Interfaces:** Produces `hashPassword(password:string):Promise<string>`、`verifyPassword(password:string,encoded:string):Promise<boolean>`、`bootstrapAdmin(db:Database,input:{username,password}):Promise<PublicUser>`、`requireSession(request):Promise<Actor>`、`requireWriteRequest(request,actor):Promise<void>`、`assertActorCurrent(client,actor):Promise<void>`。测试 helper `login(app,username,password):Promise<{cookie,csrfToken,user}>` 调用真实登录接口。

- [ ] **Step 1: 写测试。** 密码不同 salt、正确 / 错误验证、损坏编码拒绝、参数固定和非 ASCII 密码不截断。auth 集成验证 bootstrap 并发只生成一个初始管理员、已有管理员时再次 bootstrap 返回冲突、错误账号与密码的错误文案一致、token 数据库存哈希、Cookie 参数和到期 / logout 撤销。

```ts
expect(await verifyPassword('正确密码示例123456', await hashPassword('正确密码示例123456'))).toBe(true);
expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })).statusCode).toBe(403);
expect((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: expiredCookie } })).json().user).toBeNull();
```

- [ ] **Step 2: 运行 RED。** unit 的 `passwords.test.ts` 与独立 PostgreSQL 的 `auth.test.ts`，确认失败来自未实现的行为。
- [ ] **Step 3: 实现密码与认证路由。** 使用固定 scrypt 参数及有界队列，编码包含版本 / 参数 / salt / hash；拒绝异常大参数，未知账号走同等成本的 dummy hash 验证。每次 session 查用户状态 / authVersion，Cookie token 不返回 JSON。GET session 提供 session 内独立随机 CSRF token，认证写请求校验该 token 与精确 Origin；login 校验 Origin 和 JSON 类型。PostgreSQL 原子窗口计数实现登录限制。`assertActorCurrent` 在事务内锁定用户行直到提交，账号变更使用兼容的行锁序列。
- [ ] **Step 4: 实现 bootstrap CLI。** `npm run site:admin -- --username <name>` 交互掩码输入密码；自动化使用非 TTY 的 `--password-stdin`。密码不进入 argv / 日志，不能覆盖已有管理员。新增修改密码接口，验证原密码、更新哈希与 authVersion，并撤销旧会话；未来设备 token 同样必须携带该版本。
- [ ] **Step 5: 运行 GREEN。** 单测 / 集成通过，补断言跨站写、过期 CSRF、连续登录失败第 6 次与超长密码被拒绝，不出现完整 Cookie、密码和配置日志。
- [ ] **Step 6: Commit。** `feat: add private site authentication and admin bootstrap`。

## Task 4: 管理员用户管理与授权失效

**Files:** Create `src/users/{repository,service,routes}.ts`、`tests/integration/users.test.ts`；Modify `src/app.ts`，必要时为迁移增加独立新文件，不能改已执行 SQL。

**Interfaces:** Consumes Actor 与 `assertActorCurrent`。Produces `createUsersService(db)`，方法 `list(actor)`、`create(actor,{username,password})`、`setActive(actor,userId,active)`、`resetPassword(actor,userId,newPassword)`，返回 PublicUser / void。

- [ ] **Step 1: 写测试。** 普通用户管理请求 403；创建用户 role 固定 user，重复规范化用户名 409；停用和重置同时撤销多个 session，启用后旧 Cookie 仍无效；不能停用最后一个有效管理员；两个管理员并发停用不能留下 0 个有效管理员。测试其他管理员仅使用内部 fixture，不增加公共提升角色接口。

```ts
expect((await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: { cookie: userCookie } })).statusCode).toBe(403);
expect((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: revokedCookie } })).json().user).toBeNull();
expect((await db.pool.query("select count(*)::int as n from users where role='admin' and active")).rows[0].n).toBeGreaterThan(0);
```

- [ ] **Step 2: 运行 RED。** `npm run test:service:db -- tests/integration/users.test.ts`。
- [ ] **Step 3: 实现带锁的账号变更。** 事务中重查操作者与目标，序列化有效管理员数量判断；停用 / 重置更新 authVersion 并删除旧 sessions，重置只针对普通用户。记录不含密钥或密码的 actor / target / action / 时间；重置请求每管理员每分钟最多 5 次，走共同限制器。
- [ ] **Step 4: 运行 GREEN。** 集成通过，确认恶意 body 的 role / ownerId / passwordHash 不会改变授权；被停用的操作者不能凭旧请求在事务末尾创建用户。
- [ ] **Step 5: Commit。** `feat: add administrator managed user accounts`。

## Task 5: 不可变 PDF 存储、本人资料和 Range

**Files:** Create `src/storage/{object-store,local-object-store,byte-range}.ts`、`src/documents/{repository,service,routes,source-response}.ts`、`tests/unit/{object-store,byte-range}.test.ts`、`tests/integration/documents.test.ts`、`tests/fixtures/pdf.ts`（仓库根）、`src/cli/cleanup-staging.ts`；Modify `src/app.ts`。

**Interfaces:** `ObjectStore.putImmutable(key:string,body:AsyncIterable<Uint8Array>,maxBytes:number):Promise<{bytes,sha256}>`、`stat(key)`、`read(key,range?:{start:number,end:number}):AsyncIterable<Uint8Array>`、`deleteUnreferenced(key)`；`parseByteRange(header:string|undefined,size:number)` 返回全量 / 单范围或抛出 416。`createDocumentsService({db,store})` 提供 `savePdf(actor,{idempotencyKey,title?,originalFilename,body})`、`list(actor,{q?,page,pageSize})`、`get(actor,id)`、`getAsset(actor,id)`；输出共同 DTO。测试 `buildPdfFixture(pages=3):Uint8Array` 生成合成 PDF。

- [ ] **Step 1: 写测试。** 本人上传 / 列表 / 下载 SHA-256 相同，B 和管理员读取 A 的详情、原件、asset、HEAD、Range 都为 404；跨 owner 不能复用幂等结果。覆盖同键同文件重试、同键不同文件 409、同 owner 同 PDF 返回已有条目、不同 owner 相同 PDF 独立条目。

```ts
expect(parseByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
expect(() => parseByteRange('bytes=0-1,4-5', 10)).toThrow();
expect((await app.inject({ method: 'GET', url: `/api/v1/assets/${assetA}/content`, headers: { cookie: cookieB, range: 'bytes=0-4' } })).statusCode).toBe(404);
```

- [ ] **Step 2: 运行 RED。** storage / byte-range unit 与 `documents.test.ts` PostgreSQL 集成。
- [ ] **Step 3: 实现流式存储与引用提交。** 在受控根目录内生成随机对象 key；临时文件 / 最终文件 0600，原子、排他发布，拒绝覆盖、路径穿越和符号链接。不信任原始文件名作路径。先识别大小与 PDF header，写完整对象、校验 hash，再在事务中重查 Actor、登记 document / asset / source 与 ingestion。幂等记录使用 owner/key 唯一键、receiving/completed/failed 状态与 epoch：同键在途返回 409 / Retry-After，失败可重新领取并增加 epoch，旧 epoch 不能提交；失败 / 崩溃遗留 receiving 超过 15 分钟可恢复。SQL 失败留下不可读孤立对象，由 staging 清理命令在 24 小时后按 DB 引用检查清理。
- [ ] **Step 4: 实现 HTTP 与失败行为。** multipart 不整体缓冲；中断 / 超限关闭临时文件。文件名去除路径及 CR/LF，Content-Disposition 使用编码文件名；认证在 metadata / Range / ETag 响应前执行。416 带 `Content-Range: bytes */size`，206 / HEAD 字节长度准确；所有私有响应 no-store。header 识别只表示允许保存，阅读失败可下载原件，不能宣称解析成功。
- [ ] **Step 5: 运行 GREEN。** 加故障注入：store 失败、DB 提交失败、上传中途停用、异常文件名、缺失文件和同时重试，均不发布坏引用或覆盖旧原件；标题搜索参数化，`%` / `_` 作字面字符。单测及集成通过。
- [ ] **Step 6: Commit。** `feat: persist private pdf documents and authenticated ranges`。

## Task 6: 加密个人 Provider 配置与修订

**Files:** Create `src/providers/{secrets,repository,service,routes}.ts`、`tests/unit/secrets.test.ts`、`tests/integration/providers.test.ts`；Modify `src/app.ts`。

**Interfaces:** `sealApiKey(value:string,userId:string,keyring:RuntimeConfig['keyring']):SealedSecret`、`openApiKey(secret:SealedSecret,userId:string,keyring):string`；`createProvidersService({db,keyring})` 提供 `get(actor):ProviderProfile`、`update(actor,ProviderProfileUpdate):ProviderProfile`、内部 `getForCall(actor):{profile,apiKey}`。SealedSecret 为 `{keyId,nonce,ciphertext,tag}`，只在服务内部。

- [ ] **Step 1: 写测试。** 加密每次随机、能解密；错误 owner / tag / Key ID / 主密钥均失败。keep 不更换 Key、delete 清空所有密文字段、replace 空值拒绝；并发旧 expectedRevision 为 409。初始 profile revision=0 / hasApiKey=false；GET 无任何密文或完整 Key。

```ts
expect(openApiKey(sealApiKey('test-secret', userA, keyring), userA, keyring)).toBe('test-secret');
expect(() => openApiKey(secretForA, userB, keyring)).toThrow();
expect(JSON.stringify(publicProfile)).not.toContain('test-secret');
```

- [ ] **Step 2: 运行 RED。** `secrets.test.ts` 与 `providers.test.ts`。
- [ ] **Step 3: 实现配置。** AES-GCM 使用共同参数与 owner AAD；修改在事务中校验 Actor / expectedRevision 并增加 revision。保留 keyring 旧 ID 的解密能力，未知 ID 失败；不自动重写历史密文。GET 输出重新经过公共 schema，错误只提供受控 code。读取 / 保存配置不发模型请求。
- [ ] **Step 4: 运行 GREEN。** 覆盖 B 与管理员不能取得 A 配置、SQL 和响应均无明文 Key、保存失败事务回滚；替换或移除 Key 不改变 documents。检查日志序列化 whitelist，避免 req.body / header / upstream response 暴露凭据。
- [ ] **Step 5: Commit。** `feat: store owner scoped encrypted provider profiles`。

## Task 7: 受控出站传输与显式连接测试

**Files:** Create `src/network/{address-policy,safe-fetch}.ts`、`src/providers/connection-test.ts`、`tests/unit/{address-policy,safe-fetch}.test.ts`、`tests/integration/connection-test.test.ts`；Modify `src/providers/routes.ts`、`src/app.ts`。

**Interfaces:** `ResolvedAddress={address:string,family:4|6}`、`Lookup=(hostname:string)=>Promise<ResolvedAddress[]>`；`resolvePublicAddresses(hostname:string,lookup:Lookup):Promise<ResolvedAddress[]>`；`createOutboundFetch({lookup?,connector?,timeoutMs,maxResponseBytes}):typeof fetch`，connector 接收已经确认的 address / family / hostname 并返回经过 TLS 与 peer 验证的连接，测试模拟相同合同，生产使用 Undici。`testProviderConnection(actor):Promise<{ok,profileRevision,usage?,checkedAt}>` 使用任务 3 / 6 的授权和当前 profile。

- [ ] **Step 1: 写测试。** localhost、私网 / link-local / 保留网段、IPv4-mapped IPv6、公私混合 DNS、第二次 DNS 返回私网、非法协议和重定向拒绝；模拟解析与实际 socket 绑定不符时不发送 Authorization。只使用内存 / 本地模拟 transport，不允许真实远端请求。

```ts
await expect(resolvePublicAddresses('mixed.example', mixedDnsLookup)).rejects.toThrow();
expect(sentRequests.filter(request => request.destinationIsPrivate)).toHaveLength(0);
expect(modelCalls).toHaveLength(1);
```

- [ ] **Step 2: 运行 RED。** network unit 与 `connection-test.test.ts`，测试固定 fake Key / Provider；不读取用户 `.env.local`。
- [ ] **Step 3: 实现传输。** 使用 ipaddr.js 归一化和单播范围判断，DNS 全量验证后，Undici connector 绑定已验证 IP 并保留原 hostname / TLS SNI；连接不再自行二次解析，校验 peer。禁用环境代理和重定向，限制总时间与响应体，保留请求取消。SDK 的通用 URL 校验仍复用，服务端额外限制不能被普通 fetch 回退绕开。
- [ ] **Step 4: 实现连接测试。** 严格使用本人已保存 profile 和一个短固定测试段，通过现有 Provider / 校验流程请求一次，maxRetries=0；不创建文档或启动历史翻译。限制频率，调用前后检查用户和 profile 修订；停用、密码重置、Key 更换或请求取消时丢弃迟到结果并中止可取消请求。安全错误不携带上游 body 或 Key。
- [ ] **Step 5: 运行 GREEN。** 断言保存 / GET / 读 PDF 时 modelCalls=0，显式测试一次；畸形响应、鉴权失败、超时、超限与撤销不会重试或泄密。已有 SDK 和扩展单元回归通过。
- [ ] **Step 6: Commit。** `feat: validate provider egress and test personal connections`。

## Task 8: 主题、登录、用户管理与个人配置页面

**Files:** Create `apps/web/{package.json,index.html,vite.config.ts,tsconfig.json,playwright.config.ts}`、`src/main.tsx`、`src/app/{router,providers,session}.tsx`、`src/shared/{api-client.ts,styles/tokens.css,styles/globals.css}`、`src/shared/ui/{button,input,badge,dialog,alert-dialog,field,toast}.tsx`、`src/shared/layouts/{app-shell,page-header}.tsx`、`src/features/auth/{login-page,change-password}.tsx`、`src/features/users/{users-page,create-user-dialog,reset-password-dialog}.tsx`、`src/features/settings/provider-page.tsx`、`tests/{start-service.mjs,e2e/accounts.test.ts}`；这些 src / tests 路径均相对 apps/web。Modify 根 `build:site` / `test:site:e2e` 命令。

**Interfaces:** `apiRequest<T>(path:string,options?:{method,body?:unknown|FormData,signal?:AbortSignal}):Promise<T>` 限同源 `/api/v1`、credentials include，认证写请求自动带 session CSRF；JSON body 编码与 FormData 区分，204 对 `void` 调用返回 undefined。`useSession()` 提供 PublicUser / loading / logout，query key 以 user.id 起头。路由 `/login`、`/library`、`/settings`、`/admin/users`；资料库页面在任务 9 接通。

- [ ] **Step 1: 准备最小 Vite / 测试服务入口与空页面，写浏览器行为测试。** `accounts.test.ts` 使用任务 2 的真实服务 / 临时库，覆盖管理员登录、创建用户、普通用户登录、角色菜单、禁用直达管理路由、修改密码后重新登录、停用使旧标签页失效。网页端隐藏菜单之外，API 仍验证权限。
- [ ] **Step 2: 运行 RED。** `npm run test:site:e2e -- accounts.test.ts`；runner 编译服务和网站后以同源真实服务运行，缺页面 / 路由时失败。
- [ ] **Step 3: 实现 UI 与状态。** Tailwind v4 token 沿用 Spec 第 7 节全部颜色、间距、圆角与字重，复用归档原型的布局；每页一个深色主操作。Radix 实现键盘和焦点恢复，表单有 label / 错误 / pending，破坏性动作明确确认。用户名和标题作为文本呈现。
- [ ] **Step 4: 接通账号与配置。** Query / session 状态只存必要公共字段；登录切换或 401 时 abort 旧请求、清空旧用户 query、敏感表单与 PDF 视图。Key 输入保存后清空，空输入采用 keep，删除采用显式 action；未保存修改先保存再测试，并提示测试将产生一次模型请求。普通读取不自动测试。
- [ ] **Step 5: 运行 GREEN 与视觉检查。** 验证配置回显无完整 Key、错误聚焦、Dialog 恢复焦点；截图覆盖 1440px 明暗主题和 390px 登录 / 设置，无全页横向溢出。只持久化 theme 等非敏感偏好，API Key / 会话 token 不写 localStorage。完成 `npm run build:site` 和相关 e2e。
- [ ] **Step 6: Commit。** `feat: add private site shell and account pages`。

## Task 9: 真实资料库、PDF 上传与原件阅读

**Files:** Create `apps/web/src/features/library/{library-page,document-row,upload-dialog,document-page,pdf-source}.tsx`、`apps/web/tests/e2e/{library,pdf-source,account-isolation}.test.ts`；Modify router 和测试服务 setup。

**Interfaces:** `PdfSource({sourceUrl,title}:{sourceUrl:string,title:string})` 只接受由公共文档 ID 生成的同源 URL；PDF.js worker / fonts / cmap 由本地构建资源提供。列表使用 DocumentList，sourceUrl 为 `/api/v1/documents/<id>/source`。

- [ ] **Step 1: 写测试。** 空库没有示例计数；上传合成 3 页 PDF 后条目与详情出现，刷新保留，PDF.js 能实际渲染三页并切换 / 缩放。上传过大、错误文件、重试、401 和删除中断的错误有原位提示，不能显示成功进度。另一浏览器 context 和同一页面退出换账号都不能看到旧资料。
- [ ] **Step 2: 运行 RED。** `npm run test:site:e2e -- library.test.ts pdf-source.test.ts account-isolation.test.ts`。
- [ ] **Step 3: 实现列表与上传。** q / page 放 URL，用户 query key 隔离；上传使用 AbortController 和稳定幂等键，服务器确认后才显示“原文已保存 / 等待本地处理”。S1 添加入口只暴露已实现 PDF 上传；其他来源入口在后续任务接通后出现。原文件名只作文字和标题默认值。
- [ ] **Step 4: 实现原件视图。** 使用 PDF.js getDocument、独立 worker、同源凭据和受控 Range，显式 `isEvalSupported:false`；只挂载当前页，页码 UI 从 1 开始、内部从 0 开始。切换页取消旧 render task；退出文档 / 账号销毁 loadingTask、worker 和 canvas。加载失败提供原件下载和重试；S1 不显示不存在的译文栏。代码 / 原件宽度保持局部滚动，390px 可用。
- [ ] **Step 5: 运行 GREEN 与截图。** 检查 PDF、列表和主题的 desktop / mobile 截图，与批准原型核对；断言打开 / 翻页 modelCalls=0、旧账号异步响应不回填新页面、后续请求因撤销得到 401 / 404。`npm run check` 继续通过，相关 site e2e 通过。
- [ ] **Step 6: Commit。** `feat: add personal pdf library and source reading`。

## Task 10: 本机启动、持久卷、重启与 S1 交付记录

**Files:** Create `.dockerignore`、`apps/document-service/Dockerfile`、`deploy/{compose.site.yml,compose.site-dev.yml}`、`scripts/{dev-site,create-site-secrets,check-site-restart}.mjs`、`tests/site/secrets.test.mjs`、`docs/{learning-site-install,learning-site-s1-validation}.md`；Modify service main / static serving、根 `package.json`、`.env.example`、README 及应用 README。

**Interfaces:** `npm run site:db` 启动只向 loopback 暴露的开发数据库；`npm run dev:site` 启动 API / Vite 并正确转发信号；`npm run site:keygen` 只向忽略的 `.env.local` 添加缺少的 keyring 变量，已有值不覆盖，权限 0600、无 Key 输出；`npm run site:admin` 使用任务 3 CLI。`npm run check:site` 在独立 PostgreSQL 中运行服务集成和网站 e2e；`npm run test:site:restart` 使用独立 Compose project 做重启验收。

- [ ] **Step 1: 写可执行检查。** `check-site-restart.mjs` 创建随机 project / 端口 / 卷 / 凭据，真实登录、创建用户、上传合成 PDF、保存 fake API profile，重启 app 和 db，再验证文档 hash、配置解密与授权。finally 只 `down --volumes` 自己的 project；密码走 stdin，配置通过临时受限 env 文件，不打印值。`tests/site/secrets.test.mjs` 验证 keygen 保留已有配置和 Key、缺项才添加、输出不含密钥、文件权限为 0600，使用测试临时文件。
- [ ] **Step 2: 运行 RED。** `npm run test:site:restart`，缺少镜像 / Compose 启动材料时明确失败，不误用用户已有数据库。
- [ ] **Step 3: 实现启动与镜像。** 多阶段 npm ci / build；静态资源与 API 同源，Fastify static 的 SPA fallback 排除 `/api` 和不存在资源。生产配置必须 HTTPS；S1 Compose 是 loopback 本机预览，明确使用 local mode，数据库与对象使用独立命名持久卷。`.dockerignore` 排除密钥、`.git`、node_modules、data / temp / releases、parser 环境、模型、运行及测试产物，主密钥只在运行时注入。开发 override 的数据库端口只绑定 `127.0.0.1:54330`。
- [ ] **Step 4: 完成命令与文档。** `check:site` 仅增加真实 PG / UI 检查，不改变既有 `check` 为付费或 Python / Docker 必需命令。记录初始化、登录、管理用户、API 配置、PDF 保存、数据目录、退出与测试步骤；标明 S1 原件阅读与 S2 完整译文阅读的交付边界。安装说明有参数生成方式，无可直接复用的默认密码。
- [ ] **Step 5: 验证 GREEN。** 运行 `node --test tests/site/*.test.mjs`、`npm run check`、`npm run check:site`、`npm run test:site:restart`，完整输出通过后登记真实数量、截图路径、版本和限制。构建静态资源 / 镜像检查无测试密码、fake Key 和本机路径；独立审查依用户选定执行方式进行，问题修复后只重跑受影响检查及必要整体回归。
- [ ] **Step 6: Commit。** `feat: package the private learning site foundation`。

## 3. S2 接口边界

这里只固定 S1 必须保留的连接点，不将 S2 产品代码提前放入 S1。

| S1 保留的依据 | S2 接入位置 |
| --- | --- |
| SourceIdentity 的原件 hash / sourceVersionId | 包绑定同一 owner / document / source，不能按文件名覆盖 |
| `documents.current_source_id` 与独立 source_versions | parse run、translation run 和当前可读版本另建增量迁移 |
| ObjectStore 的不可变写入和鉴权资产 URL | 导入包所有资源逐项验证后写入，最终事务发布 |
| `PdfSource` 与同源 Range API | 对照 Reader 的左侧原件、原页定位和缩放 |
| 可复用 Provider / owner / authVersion | 本地 Node 翻译与服务器任务分别使用自己的授权配置，导入包不含 Key |
| contracts 的独立 workspace 与既有 P0 schema | 新增 `schemas/{reader-ir,document-bundle}.schema.json` 和 `src/{reader,bundle}.ts`；保留原 P0 schema |

S2 Plan 另行定义 `reader-ir/1`、`pagelingo-document-bundle/1` 的 schema、来源绑定、可信 renderer 与本地 CLI；PDF 来源仍是旋转后 CropBox、左上、0–1、pageIndex 从 0 开始。S1 不提供返回假成功的导入路由或未运行的 worker。

## 4. 自审与验收对应

| Spec 条目 | S1 对应 | 后续归属 |
| --- | --- | --- |
| R02–R05 / A01 / A03 | 任务 1–4、6–8：账号、密钥、隔离与撤销 | 设备 / 任务授权随 S3 接入同一版本检查 |
| R01 / R11 / A02 / A07 原件部分 | 任务 2、5、9、10：保存、本人列表 / 原件、重启 | 包与译文 S2，其他类型 S3–S4 |
| R07 / R13 / A13 页面部分 | 任务 8–9：主题、窄屏、PDF 阅读与缓存清理 | 阅读进度 / 双屏 S2、集合 / 标签 S4 |
| A15 持久化部分 / A16 | 任务 10：重启、权限和既有回归 | 公网 HTTPS、完整备份恢复 S5 |
| R06 / R08–R10 / R12 / A04–A06 / A08–A12 / A14 | S1 提供协议、原件与安全边界 | S2–S5 分阶段验收；不能标为 S1 已完成 |

计划自审时逐项核对文件责任、共同类型 / 方法名、Review Focus 的测试归属，以及 S1 与后续范围；修复遗漏后再交用户审阅。本计划只包含明确的接口、参数、测试断言和验证动作，实现正文留给执行任务。

**建议执行方式：Subagent-driven。** 任务按顺序交付，每任务由新实现者与独立审阅者检查，再做整分支审阅。账号、密钥、出站传输和文件访问的交互值得阶段审查；代价是更多独立上下文。Native 方式由当前会话顺序实现，最后做一次独立整分支审阅，资源开销较少。用户已授权连续执行，实现方采用推荐的 Subagent-driven 方式。

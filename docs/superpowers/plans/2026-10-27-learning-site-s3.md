# Learning Site S3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在电脑插件收藏网页后，将原文、可获取资源与匹配译文保存在本人资料库；中文直接阅读，外语按本人设置在服务器后台翻译，关闭原网页后仍可阅读。

**Architecture:** 插件负责当前页面与原文恢复、资源获取和持久化 outbox；API 验证设备身份与采集材料，生成不可变网页来源、Web Reader IR 与可读版本。独立 Node worker 复用 translation-core，持久化检查点并发布译文；网页协议独立于 PDF，语义块、校验与可信渲染共用实现。

**Tech Stack:** 沿用 Node.js 24.13.0、TypeScript 7.0.2、React 19.3.0、Fastify 5.12.7、PostgreSQL 17、Zod 4.6.7、Playwright 1.63.0、idb 8.0.3、translation-core 0.4.0。新增 DOMPurify 3.4.17、Readability 0.6.0；Node DOM 使用已兼容当前 Node 的 jsdom 29.1.1，类型包 @types/jsdom 30.0.0；parse5 8.0.1 继续复用。锁定精确版本，不安装 Python 或模型。

**Spec:** [已批准的个人学习站 V1 设计](../specs/2026-10-26-personal-learning-site-design.md)，主要实现 §4、§5.1–5.2、§5.4、§6.3、§8–12 与 §13 的 S3；重点覆盖 A02–A06、A12–A13、A15–A16 的网页部分。

状态：2026-10-27 用户已批准，进入实现。S1 / S2 已合入并同步 main，基线 `081be39`；合并后 `npm test` 为 47 文件 / 640 测试通过。计划写在现有隔离 worktree 的 `feat/learning-site-s3`，main 不写功能代码。沿用已经选择的逐任务实现与独立审查方式，连续执行，不逐任务再次询问。

任务执行时，每份 brief 附本计划的 Global Constraints 与 §1–2 冻结合同。

## Global Constraints

- 各用户保存自己的数据，首版不共享。所有业务读取、写入、任务领取和文件响应都从会话 / 设备身份取得 owner，忽略客户端自报 owner。
- 管理员角色只额外开放账号管理 API，资料读取仍按所属用户执行。
- 原件、raw、source IR 和已完成译文版本不可原地覆盖。
- 用户 Key 不写入任务快照、日志、HTML、普通资料导出或 parser 环境。
- SDK 保护、术语、校验和长段拆分继续为公共实现，适配器不复制一套保护算法。
- 中文资料默认标记“无需翻译”；语言判断、普通阅读、保存、导出与打开旧译文零模型调用。
- 默认 npm 检查不安装 Python / 模型，也不调用真实 LLM。
- 网页快照清洗并在隔离环境展示，禁用任意脚本、表单、顶层导航和未授权网络请求。站内正文从白名单结构渲染。
- 原网页脚本、表单状态、Cookie、Authorization 和插件注入界面不属于采集包；原有插件翻译配置保持独立。
- 原 P0 产物和已发布包保持不变，所有新处理写入新 run / 目录。
- 桌面优先，沿用已确认的灰色 / 暖灰 / 青绿及明暗主题；移动首屏保留状态与有用正文，表格 / 代码只在局部横滚。
- strict TypeScript、ESM、两空格、单引号、分号；DOM / Chrome / 数据库与持久化留在对应适配层。
- 路径约定：未加 workspace 前缀的 `src/`、`tests/unit/`、`tests/integration/` 相对 `apps/document-service/`；扩展与网页路径显式写出，不在仓库根目录创建同名目录。

## Review Focus

1. 已翻译、纯译文模式、SPA 切页或正文变动：收藏必须保存真实原文及其资源，不混入译文 / 插件 UI，不采成另一个 X 回复或知乎回答。任务 2 / 7 / 8 固定回归。
2. 浏览器 worker 被终止、文件传到一半、服务器已提交但响应丢失、重新配对成其他账号：重投不重复入库 / 付费，旧 outbox 不向新账号上传。任务 5 / 6 / 8 / 13 固定回归。
3. 恶意 HTML / CSS / SVG、DOM clobbering、`__proto__`、资源重定向及 DNS rebinding：只作数据，不能取得主站能力或把服务变成内网代理。任务 2 / 3 / 9 / 10 / 12 固定回归。
4. 换 Key / 模型、取消、停用、重启与旧 worker 迟到：只用当前用户的有效配置，已确认结果保留，过期 epoch 不发布，流式响应不被误当作未收到首响应。任务 4 / 9 / 11 / 13 固定回归。
5. S3 升级后的已有 S2 包与长网页：旧 PDF 原件 / 已导入版本 / 正式包仍可用；网页无假 PDF 页码、无整篇隐藏 DOM，读到一半不因新译文发布而跳页。任务 0 / 3 / 12 / 13 固定回归。

---

## 1. 本阶段边界与现状

交付插件配对、X / 技术博客 / 知乎回答和文章 / 公众号正文采集、资源快照、链接记录与公开文章补抓、后台网页翻译、三种阅读模式和网页进度。GitHub repo / 固定版本 arXiv 适配、发现来源关系、标签 / 集合 / 回收站 / 全库搜索归 S4；其链接在 S3 仍可保存为“仅链接”，不伪称 README 或论文已归档。完整备份 / 公网部署归 S5；S3 增加 worker 的开发与 Compose 启动是运行本阶段所必需。

已核对代码：

- S2 的 `ReaderIR`、`ReaderDescriptor.pages`、`ReadingPosition.pdfPageIndex` 与完整包均是严格 PDF 合同；网页新建 `web-reader-ir/1` 等合同，不填假的页码、PDF asset 或 parser 身份。
- 插件 `ProtectedBlock.nodes / domSlots` 和 `DomRenderer` 保留原文；`snapshotSourceNodes()` 只是变化指纹，缺少图片与归档字节，不能当快照。
- 当前鉴权只有 session；没有 devices、配对、outbox、服务器 glossary 或网页 job。`getForCall(actor)` 依赖会话，不能拿旧浏览器 session 执行长期任务。
- `createOutboundFetch` 面向 Provider 连接测试，禁止 query / redirect，且缓冲响应；公开网页抓取和长流式翻译需要各自策略，不能放松旧接口。
- renderer 指纹覆盖 contracts / SDK 的源码。增加网页合同会改变它，必须显式支持已发布 S2 renderer `0.1.0 / 3bfbbf4ce02a787185643792d617f80cb960261d108ad0ce224b0909ea4d47c3`，不能只要求用户重新导出旧包。

以下默认值是实现方建议，供本计划审核：自动翻译默认关闭；配对码 5 分钟 / 单次消费；设备 token 30 天；网页上传按文件恢复，不先实现字节 Range 续传；网页 worker 全局并发 2、同用户并发 1。源码实现过程中若这些公开合同有缺口，先修正计划与共同 fixtures，再改调用方。

## 2. 冻结的跨任务合同

本节在执行时随任务 brief 传递，不让后续实现者猜前一任务的名称。

### 2.1 身份、版本与内容

- `captureId` 是插件生成并持久化的 UUID；同一条 outbox 重试始终使用同一 UUID / Idempotency-Key。ingestion、document、sourceVersion、readerVersion、job、device 使用不同 UUID。
- 新增 `WebCaptureManifest`（`web-capture/1`）、`WebReaderIR`（`web-reader-ir/1`）、`WebTranslation`（`web-reader-translation/1`）、`WebReaderIndex / WebReaderChunk / WebReaderDescriptor`，Zod strict + JSON Schema 同步。contracts 升为 0.3.0；已有 PDF JSON 形状与 `reader-ir/1` 不变。
- manifest 含来源 URL、候选 canonical、类型 / 来源、标题 / 作者 / 来源时间 / 采集时间、scope、原文 HTML 文件描述、资源描述、可获取的原 CSS 及可选现有译文；每个实际文件都含 `id/path/bytes/sha256/mediaType/role`。每个资源（含缺失项）明确 `role:image|css`，可用资源须与文件角色相符。不含 owner、Token、Key、请求头或 DOM 运行对象。
- scope 区分 article / x-post / answer，并含 `completeWithinScope` 和警告。只保存单条回答 / 主帖不代表整个问题 / 线程；展开不足、不可读 frame、closed Shadow DOM、付费或未加载区域明确标记。
- `normalizeCaptureUrl(url)` 只去除已知 `utm_* / fbclid / gclid / msclkid` 追踪参数，保留其余 query / hash；不复用 SDK 的缓存 URL 归一化，不用候选 canonical 自动合并不同来源。来源、导航及 canonical URL 只允许 HTTP/HTTPS，禁止 userinfo。资源另用专用 URL 合同，支持 HTTP(S)、有界 PNG/JPEG/WebP/GIF base64 data 图片和与来源同 origin 的 blob:http(s)；data/blob 不用页面 URL 归一化，只在绑定当前文档的授权采集中解析成实际字节，不能成为服务端通用 fetch。
- source 的 SHA 是最终来源 manifest 的实际字节 SHA；`contentFingerprint` 只用于同 owner、来源身份与 scope 下的去重。它基于服务器规范化的正文、结构、资源摘要与缺失状态，排除 captureId / 采集时间 / 上传尝试。可用 blob 图片用 `{kind:'document-blob',origin}` 加实际文件摘要表示指纹来源，忽略临时 UUID；manifest 保留完整 locator，缺失 blob 仍保留精确地址与原因。HTTP/data 行为不变。相同 URL 不同内容建新 source；相同内容复用 source，保留新的收藏事件；不跨用户去重。
- Web IR 复用 `TranslationBlock`、格式 / protected 语义和树状容器；新增网页表格 / 行 / 单元格。Web sourceRef 为 `{ nodeId, quote, prefix, suffix }`，nodeId 在固定快照内唯一；重复段落仍有不同 block ID。Web parse ID 仍用 `p_<sha256>`，但来自 source manifest / projector / config 摘要，不伪造 Python 或 PDF 信息。
- Web text block 可带 `headingLevel:1..6`，由 projector 从真实 h1–h6 保留，含合成文本段；不加入 SDK value 或 PDF 合同。无此元数据时渲染器按结构层级降级。
- `WebReaderIR.source.kind='web'`，无 pages。`WebLanguageDecision` 为 zh / en / foreign / mixed / und，附 sourceLanguage 与 reason；foreign 只扩展 Web 合同，PDF 既有四值语言合同与判断不变。
- `WebModelTranslation` 复用现有单元 / block 结果模型，保持 `web-reader-translation/1`，绑定实际 Web IR 字节 SHA。`WebTranslation` 是模型与导入产物的 union；`WebImportedTranslation` 使用 `web-imported-translation/1` / generationKind=import，保留候选来源 / 版本 / 语种及已验证的原块结果证明，无 job / profile / budget / 模型用量伪造。Web generation kind 单独扩展 import，PDF 合同不变。适配器使用 SDK `planUnits / encodeBlock / validateStructure / decodeTranslation`；模型提供的 HTML / 格式树不作源依据。
- 已有插件译文另用 `WebCaptureTranslationCandidate`（`web-capture-translation-candidate/1`），不绑定尚未生成的服务端 IR。它携带原文 snapshot / fingerprint、语种与 SDK / prompt / protection 版本及逐块 `{nodeId,sourceTextSha256,source:TranslationBlock,rawText}`；文本摘要为 UTF-8 `naturalText(source.content)`，不归一化空白，rawText 为 glossary 恢复后的完整 SDK result.text。服务器逐块比较自己的原文投影并重放 SDK 校验；不支持或不匹配只跳过候选并警告，原文照常保存。候选最多20,000块、单块512 KiB、文件16 MiB；draft 用独立类型允许资源未完成时 sourceContentFingerprint=null，其余证明仍绑定实际清洗快照。任务8完成资源描述后计算真实指纹并验证严格上传合同；不传译文 DOM HTML，不伪造 IR。共享纯快照源块投影复用同一语义与行内实现；不能证明一致的格式/保护/section 结果明确跳过。
- `WebDocumentSummary` 与原 PDF summary 构成 `DocumentSummary` union。网页 `source` 可为 null（仅链接），不能让 PDF 原件路由返回网页 manifest。`kind` 保留 V1 的 article / x-post / repository / paper / pdf；S3 后两种来源只作链接记录。

### 2.2 大小与可读性预算

`defaultCaptureLimits`：HTML 8 MiB、单资源 16 MiB、一次采集 64 MiB、文件 256、不同资源 origin 16、DOM 节点 50,000、结构深度 64、正文块 20,000、IR 16 MiB、图片单边 16,384 / 总像素 32,000,000；GIF 最多 128 帧且累计帧像素不超过 64,000,000。Math fragment 最多 4,096 节点 / 64 KiB。超限不截掉证据伪称完整；可保留链接 / 已确认部分并显示准确状态。

Web Reader 分片最多 128 blocks / 256 KiB，单超大块最多 512 KiB；正文窗口只保留当前和相邻两片，资源 URL 随窗口 / 账号释放。scope 完整性、保存状态与翻译状态分开。

快照完整原件与预览分开：保留完整的限定范围 HTML，另外生成最多 128 个语义块 / 512 KiB HTML / 32 MiB 引用资源的预览片段，保留必要祖先与 source node ID。只挂载正在看的一个快照片段，不把完整长网页放入隐藏 iframe；超大单元仅提供原件下载与明确提示，不能暗中截断。

采集 HTTP 请求 20 秒，有限重定向最多 5 跳；outbox 自动退避 2 秒起、上限 5 分钟、最多 5 次后等待显式重试。server job 使用 SDK 有界重试与持久化 `nextRequestAt`，不另复制一套 LLM 重试器。配置可收紧结构上限；提高操作字节预算必须公开到上传界面并补容量回归。

### 2.3 核心函数

| 所属 | 公开给后续任务的接口 |
| --- | --- |
| contracts | 上述 DTO / schema、`CaptureLimits / defaultCaptureLimits`；不导出服务端凭据或会话内部对象 |
| web-capture | `sanitizeSnapshot(input: SnapshotInput, environment: SnapshotEnvironment): SanitizedSnapshot`；`projectWebReader(snapshot, manifest, options: WebProjectionOptions): Promise<WebReaderIR>`；`validateWebGraph(ir): void`；`normalizeCaptureUrl(url): string`；`captureContentFingerprint(snapshot, resources): Promise<string>` |
| web-capture source | `projectSnapshotTranslationSources(snapshot:SanitizedSnapshot, limits?:CaptureLimits): Array<{nodeId:string,source:TranslationBlock}>`；root 与 browser 入口导出，和完整 projector 共享语义/行内投影，无伪造 manifest/IR；资源解析只影响 Reader asset binding，不改变 SDK source value |
| web-capture | `buildSnapshotPreviews(snapshot, resourceResolvedManifestDraft, limits): Promise<SnapshotPreviewBuild>`；`inspectImageResource(bytes, file, limits): Promise<WebReaderAsset>`；`resolveSnapshotAnchor(index, nodeId): {previewId,anchorId}|null`，预览 ID / node ID / 资源闭包进入不可变 source manifest |
| web-capture/browser | `sanitizeBrowserSnapshot(input, limits?, resources?): SanitizedSnapshot`；使用原生 DOM，不包含站点适配或 Chrome I/O，也不导入 jsdom |
| web-capture/node | `extractPublicArticle(html, url): SanitizedSnapshot`；禁脚本 / 子资源的 jsdom + Readability；仅在可终止 worker 内运行 |
| renderer | `toWebTranslationDocument(ir, selection, sourceLanguage?): TranslationDocument`；`validateWebTranslation(ir, translation): ValidatedWebTranslation`；`buildWebReader(ir, translation?: WebTranslation|null): WebReaderBuild`；`renderWebChunk(chunk, { mode, resolveAsset }): TrustedReaderHtml`，mode 为 source / translation / bilingual |
| renderer import | `buildWebImportedReader(ir, imported): {build:WebReaderBuild,translation:WebImportedTranslation|null,rejectedBlockIds:string[]}`；共享分片规划，按最小正文及必要上下文的实际预算剔除不可展示的导入候选；最多两轮完整规划，保留原文和不相关的有效译文，不改变普通 builder / PDF 行为 |
| renderer compat | `resolveTrustedCatalog({version, codeSha256}): TrustedRendererCatalog`；现有 `createStaticFilePlan(build, metadata, catalog?)` 增加可选目录选择，原调用不变 |
| devices | 在服务内部定义 `CapturePrincipal = {kind:'session'; actor:Actor} | DeviceActor`，Actor 是现有 auth/sessions 的类型；`requireCapturePrincipal(request, scope): Promise<CapturePrincipal>`；`assertCapturePrincipalCurrent(client, principal): Promise<void>` |
| captures | `createWebCapturesService({db,store,...})` 返回 create / status / receiveFile / commit / cancel；commit 只发布经服务器投影验证的版本 |
| extension outbox | `enqueueCapture(binding, draft): Promise<string>`；`drainOutbox(binding, signal): Promise<void>`；`resumeOutbox(binding): Promise<void>`；绑定改变不能领取旧 owner 项 |
| extension collector | 在 `apps/extension/src/archive/collector.ts` 实现 `collectOriginalCapture(document, options): Promise<CaptureDraft>`；返回 JSON DTO 与待取资源，不通过消息发送 Node / HTMLElement。范围不可确定时抛出 `CaptureUnavailableError`，携带可序列化 `{kind:'link-only',url,title,warnings}`，由任务8保存链接，不伪造空采集 |
| transport | 保持原 `createOutboundFetch`；新增 `createCaptureFetch(options)` 和 `createProviderJobFetch(options): typeof fetch`，共用 DNS / TLS / peer 校验 |
| jobs | `claimWebJob(workerId): Promise<JobLease|null>`；`createJobStateStore(lease): TranslationStateStore`；`createOwnerCache(ownerId): TranslationCache`；`runWebJob(lease, dependencies): Promise<void>` |
| web progress | `resolveWebPosition(descriptor, saved): ResolvedWebPosition`；`useWebReadingProgress(...)` 复用交互来源 / CAS 机制，使用网页 DTO 与端点 |

`TranslationStateStore` 的准确 SDK 方法为 `load()`、`save(checkpoint, cacheWrites)`；`TranslationCache` 为 `get / putMany / delete`。数据库适配器原子保存检查点与缓存，失败围栏抛出 SDK `CheckpointConflictError`，不能降级到仅内存执行。

`JobLease` 是任务4在 service repository 中定义的内部类型，不是客户端 DTO：共同字段为 jobId / ownerId / authVersion / epoch / leaseOwner / leaseUntil / slotId / slotEpoch；按 kind 区分 fetch-link（documentId / url）与 translate（documentId / sourceVersionId / parseId / profileRevision / glossaryRevision）。repository 同时提供 `assertJobLeaseCurrent(client, lease)`；任务9/10不依赖尚未实现的 worker main，claim / heartbeat 编排由任务11完成。

预览先以资源已经解析、预览为空的 manifest draft 构建，`SnapshotPreviewBuild` 返回 `{index:SnapshotPreviewIndex,files:Array<{descriptor:CaptureFile,html:string}>}`，包含实际预览字节摘要及资源预算。将生成文件与 index 加入最终 manifest 后再投影 IR，避免预览与来源摘要循环依赖。`WebProjectionOptions` 为 `{manifestBytes:Uint8Array,assets:readonly WebReaderAsset[],limits?:CaptureLimits}`；核对这些实际字节解析后的合同与参数一致，来源 SHA 使用实际 manifestBytes。资源检查核对实际字节 / SHA / 图片元数据，局部资产 ID 对应 CaptureFile.id。node / block ID 不依赖最终 manifest SHA。摘要相关函数用原生 WebCrypto 异步计算，不伪造同步摘要。

root 的 `SnapshotEnvironment` 只注入字符串输入 / 输出的清洗能力；DOMPurify / DOM 对象留在 browser / node adapter。root 用 parse5 处理纯数据树并进行清洗前后检查，不新增 SanitizedSnapshot tree 字段。

重复清洗通过 `SnapshotEnvironment.resources?:readonly PendingCaptureResource[]` 提供已验证 manifest 的资源上下文，只解析已知占位 ID，不把原始 URL 暗藏在 HTML 中。`replayResourcesFromManifest(manifest)` 生成此上下文；服务端重新校验用 `sanitizeNodeSnapshot(input,limits?,resources?)`，不再次运行 Readability。二次清洗须保持正文指纹、node 映射与 SVG 局部引用。CSS 采集由插件完成，归档 CSS 始终不执行。

关键 DTO 的字段名固定如下，其余嵌套 schema 在任务 1 的对应模块定义：

```ts
type DeviceDTO = { id: string; name: string; createdAt: string; expiresAt: string; revokedAt: string | null };
type WebSourceRef = { nodeId: string; quote: string; prefix: string; suffix: string };
type WebSourceIdentity = {
  documentId: string; sourceVersionId: string; manifestAssetId: string;
  sha256: string; bytes: number; snapshotSha256: string;
};
type WebReaderDescriptor = {
  documentId: string; versionId: string; source: WebSourceIdentity; parseId: string;
  index: WebReaderIndex; assetMap: Record<string, string>; snapshots: SnapshotPreviewIndex;
  translationStatus: ReaderTranslationStatus; warnings: string[];
  progress: WebReadingProgress | null; restoreHint: 'version-updated-source-start' | null;
};
type WebReadingPosition = {
  readerVersionId: string; sourceVersionId: string; parseId: string;
  blockId: string | null; blockOffset: number;
  view: 'content' | 'snapshot'; contentMode: 'source' | 'translation' | 'bilingual';
};
type WebReadingProgress = { position: WebReadingPosition; revision: number; updatedAt: string };
// WebReaderIndex 使用 chunks/toc/blockLocations，blockLocations 提供 chunkId/nodeId/previewId；
// WebReaderChunk 使用 id/parseId/sourceSha256/blocks/contextBlockIds/nodes/roots/assets，均无 PDF pageIndices。
```

`buildWebReader(ir,translation)` 不持有快照 index，输出的 previewId 可为 null；来源定位以 descriptor.snapshots 与 source node ID 查找为准，不猜预览 ID。跨分片的表头 / caption / 跨行单元格可重复携带原块，明确列入 `contextBlockIds`；每个主块只属于一个分片，上下文副本也计入块数 / 字节预算，不能产生新的翻译单元或冒充主进度 / TOC 锚点。上下文 DOM / SVG ID 按 chunk / 显示侧限定。

尚无翻译产物时直接构建原文 Reader，generationKind 为 none；中文或没有可翻译文字为 not-required，其余保留待译 / 手动选择状态。不为原文阅读虚构 Provider、job 或翻译摘要，Web reader version 的 translation 引用允许为空。

导入产物使用真实来源 / IR 字节绑定及可重放的原块证明，逐块对照服务器投影并执行 SDK 校验；不匹配只跳过候选并提示，原文保留。数据库仅允许 import 译文的 job 为空，模型产物仍须匹配真实任务；独立 owner / document / source / parse / asset 外键不可因空 job 被跳过。Reader 可引用真实导入产物，capture.jobId 仅返回真实服务器任务，所有产物保持不可变和资产注册。

### 2.4 API 与状态

| API | 身份与输入 / 输出 |
| --- | --- |
| `POST /api/v1/devices/pairing-codes` | session + CSRF，返回一次性 code / expiresAt；服务端只存摘要 |
| `POST /api/v1/devices/exchange` | code / deviceName / extensionId / extensionVersion，返回 token、device、owner 摘要与 siteId；不使用网站密码或 Cookie |
| `GET /api/v1/devices`、`POST .../:id/revoke` | session，仅本人；撤销即时阻止新写入与迟到提交 |
| `POST /api/v1/captures` | session 或有 scope 的 device；manifest、可选 targetDocumentId、translationIntent；Idempotency-Key 必填 |
| `GET /api/v1/captures/:id` | 返回状态、已收文件与 missingFileIds、最终 document / source / reader / job ID |
| `PUT .../:id/files/:fileId`、`POST .../:id/commit`、`POST .../:id/cancel` | 文件独立校验 / 幂等，最后统一提交；文件传一半重传该文件 |
| `POST /api/v1/documents/links` | session 或 links:write device，UUID Idempotency-Key 必填；JSON合同不变，同 owner/key/输入返回原结果，变更输入409；始终先保存链接，支持的公开 article 排 fetch job，失败仍有条目 |
| `GET /api/v1/documents/:id/web-reader`、`.../web-reader/versions` | session，默认当前版本，显式 versionId 可历史阅读 |
| `GET .../web-reader/versions/:versionId/chunks/:chunkId`、`.../assets/:assetId` | session，仅已发布注册资源；返回 no-store，普通阅读不出站 |
| `GET .../web-snapshots/:sourceVersionId/manifest`、`.../files/:fileId` | session；只读归档数据，HTML / CSS 原件 attachment + octet-stream + nosniff，不在主站执行 |
| `GET / PUT .../web-progress` | `WebReadingPosition` + 文档级 CAS；409 不自动覆盖 |
| `POST .../web-jobs`、`GET /api/v1/web-jobs/:id`、`POST .../:id/cancel`、`POST .../:id/retry` | session；显式翻译 / 重译 / 重试；同输入重投幂等，配置变化不能无声采用新 Key |
| `GET / PUT /api/v1/settings/save-preferences` | GET 接受 session 或有 preferences:read 的 device，只返回非敏感偏好；PUT 仅 session，expectedRevision + autoTranslate，初始 false，不扫描并启动历史任务 |
| `GET / PUT /api/v1/settings/glossary` | session；expectedRevision + SDK glossary entries；保存不可变修订 |

设备仅有 `captures:write / captures:read / links:write / preferences:read`；不能访问 provider / admin / 全资料库 / Reader / 原件接口。有 Authorization 时必须验证该设备，不得失败后退回 Cookie 身份。Cookie 写操作仍要求 Origin / CSRF；设备请求 `credentials:'omit'`，不启用任意网页凭 Cookie 跨域写入。

capture 状态：created → receiving → validating → completed，或 failed / cancelled；completed 附 `saveStatus=original-saved|partial-resources`。仅链接是文档状态，不伪装已完成采集。job 状态：queued / running / paused-config / partial / completed / failed / cancelled；未配置 Key 时不创建可执行付费任务，文档显示 awaiting-config。

手动创建 job 可指定 `sourceLanguage` 与 `selectionBlockIds`。语种使用2–63字符的保守 BCP47 形式，und / mul / zxx 不能表示明确语种；自动识别范围不扩大。选择存在时必须非空、唯一、最多20,000个 block ID，服务器按固定 IR 核对成员并归一到阅读顺序；不指定则整篇。确定后的语种与选择随不可变 job 输入持久化并参与身份摘要，WebJob DTO 用 null 表示未覆盖语种 / 整篇选择。默认 mixed / und / 短文仍需用户明确选择语种，中文默认零调用。

### 2.5 原件、快照与渲染

1. 克隆原文，不操作活页面恢复译文模式。unwrap `data-pl-source`，移除 `data-pl-owned`，使用原文绑定 / 变化指纹核对候选译文。脚本、表单值与隐藏应用状态不进入快照。
2. DOMPurify 启用 HTML / SVG / MathML 安全处理与 DOM clobbering 防护；禁止 script、iframe、object、embed、form、input、meta refresh、base、事件属性、srcdoc。原 CSS 可归档，但不直接执行；预览样式只来自已校验的颜色 / 对齐 / 字重 / 字形 / 字号 / 行高 / 空白及边框等有限展示属性，禁止 url / import / expression / 定位覆盖。最终替换资源引用后重新清洗和验证，不把后处理当作天然安全。
3. 资源进入归档后不保留 hotlink。无法取得或不支持的资源列明确缺失原因，原文仍可读。普通图片为 PNG / JPEG / WebP / 有界 GIF，检查实际字节 / 尺寸；SVG 图像不能作为任意主域文档直接执行。
4. 有 LaTeX 的公式用现有 KaTeX 路径；无 LaTeX 的 MathML / SVG 形成已清洗的 `SafeMathAst` protected 对象。SVG 仅支持 svg/g/defs/path/use/text/tspan/rect/line/polyline/polygon/circle/ellipse，href 只能指向本 fragment 内定义；MathML 支持基本排版、上下标、分式、根式、矩阵与纯文本 TeX annotation。禁止外部 href、foreignObject、style、动画与 filter；未知结构原快照保留并提示，不猜 LaTeX。引用 ID 按 block / inline / source-or-translation 实例重写，避免双语重复公式冲突。
5. 站内回溯快照由父页面认证下载选中预览片段和资源，验证摘要后将受支持图片嵌成 data URI，生成自包含 Blob HTML。iframe 不允许 scripts / same-origin / forms / top-navigation，CSP 只准 data 图片与有限内联样式，禁止出站；不依赖 opaque frame 取 Cookie 或读取父页面的 Blob 资源。按 Blob HTML 的固定 node anchor 定位，原网站链接由外层正常 Reader 打开。退出 / 换账号撤销 Blob、移除 iframe、丢弃迟到响应；不放宽全站 CSP。
6. 正文用可信 Web renderer；双语每个源块只有一个定位 ID，protected 内容不重复翻译。SDK 解码恢复源绑定；警告以文本完整保留，字典用 Map / own-property，包含 `__proto__ / constructor / toString` 回归。

nodeId / anchor / 资源映射根据最终清洗结果建立并再次验证，不能假定 DOMPurify 会原样保留输入 id。阅读视图使用站点主题，保留语义性行内强调，不把来源整页的固定黑字 / 白底计算样式灌入深色正文；回溯快照单独说明外观清洗范围。

### 2.6 持久化、发布和任务规则

只新增迁移 006，不改 001–005。扩展 documents 的 kind / 可空网页文件名，沿用 assets / source_versions 存实际 manifest 对象；新增持久单行 site_metadata UUID、web source metadata、web parse / translation / reader versions / chunks / progress、captures / files、devices / pairing、glossary revisions / preferences、fetch jobs / translation jobs / checkpoints / owner cache 与两个 web_worker_slots。设备记录配对 session 的标识以便普通 logout 定向撤销，但会话自然到期清理不自动删除独立设备。复合 FK 带 owner / document / source / parse；不可变产物保留 UPDATE 拒绝，账号停用不能被旧任务恢复。

链接请求以 owner/key 保存不可变请求摘要及结果；公开抓取另有按 owner/job 固定的不可变 acquisition，保存不同的 capture/ingestion UUID 与实际原文资产、manifest身份。下载原文先注册为受 GC 引用保护的 assets，再由可终止 worker 读取并提取，重试复用原字节。captures 的来源精确区分 session/device/fetch_job，fetch_job_id 绑定真实 owner/document/job/authVersion，与完成结果 job_id 分开；内部发布使用当前 JobLease，不能伪造会话或设备身份。重活在事务外，最终授权/lease/epoch/依赖复检和注册在短事务内。

PDF 的 current_reader FK 保持；新增 current_web_reader FK 与 kind / 单指针约束。网页另记 latest captured source 与 requested job：新源总可历史查看，当前可读 source / reader 一起切换，不能混用。重复 capture 不回滚当前版本。沿用 S2 的双轴保护：旧完整译文不被待译 / 失败替换，已有部分成果不被空结果替换；新的未晋升版本仍可显式选择。

短事务锁序为 user → device（如有）→ capture/job → document → 现有 `(204716,2)` 发布清理锁。校验、网络、DOM、SDK / renderer 重活不占事务。对象写入后、提交引用前再查身份 / epoch / 所有依赖；孤立对象至少 24 小时后清理，不能删历史可读引用。

job 绑定 owner、authVersion、source / parse、非敏感 Provider revision 与 immutable glossary revision；不得拿浏览器 session 代替 worker 身份。每次网络调用前、检查点保存与发布时重新验证；运行中监视停用 / 换 Key 并 abort。配置变化进入 paused-config，用户明确用当前配置创建新 run，旧结果保留。原 glossary 修订供原 job 重放，新修订不触发旧资料重译。

lease：heartbeat 5 秒、30 秒失效；claim 使用 SKIP LOCKED 并增加 epoch。全局 2、同 owner 1；SDK 保存逐单元检查点，完整可读版本按首个完成 / 25% / 50% / 75% / 终结点有界发布，不逐单元重建整篇。取消增加 epoch；由当前授权的终结器从最后确认检查点保存可读部分，旧 worker 无权提交。重置 / 停用 / allDevices logout 围栏所有旧 authVersion；普通 logout 撤销本 session 及其配对设备，已接收服务器任务与浏览器生命周期分开。

并发限额跨进程由数据库 slot lease 实施，不只用进程内 semaphore。先以 user 行锁串行同 owner 领取，再领取空闲 / 已过期 slot 与 job；不能在复用 slot 时锁另一个 owner。所有检查点 / 发布还验证 slot 身份与 epoch；过期旧 job 由按 owner 的回收过程重新排队，释放 slot 必须匹配旧 job/token，不能清掉后来者。运行态 owner 唯一约束防并发超领，测试必须启动两个独立 worker。

阅读中固定已打开的 readerVersion；新译文只提示可切换，不自动重挂正文。Web position 为 `{readerVersionId,sourceVersionId,parseId,blockId,blockOffset,view:'content'|'snapshot',contentMode:'source'|'translation'|'bilingual'}`，无 pdfPageIndex。按所选版本历史恢复；新来源用唯一 quote + prefix/suffix 映射，不唯一则降级到起点并提示，旧记录保留。只记录主正文位置；被动布局 / 恢复零 PUT；沿用 debounce 1500ms / maxWait 5000ms、串行 CAS、显式冲突继续。

## 3. 文件与任务

每项实现提交前完成所列 RED→GREEN 与相关检查；任务间通过上面的 DTO / 接口连接。私有辅助模块按责任拆分，新增公开协议先回到本计划。一次最终整分支审查集中修正实际问题，执行记录、验证摘要与重要裁定保存在正式文档，临时报告不得强制加入 Git。

执行次序修正：任务7完成后先执行任务10，再执行8、9和11–13。任务8的真实链接回退依赖任务10的 links API；任务10所需的会话/设备、仓库、采集发布与资源合同已由任务4–7提供，翻译调度连接仍由任务9/11完成。各任务范围不变，避免消费端只能对尚未实现的接口做模拟验证。

### Task 0: 先交付 S2 目录兼容与固定包基线

**Files:** 新建 `packages/document-bundle/tests/fixtures/s2-final/`、`scripts/check-s2-compat.mjs`、`packages/document-renderer/src/catalog-registry.ts`、`packages/document-renderer/compat/s2-0.1.0/`；修改 `packages/document-renderer/src/static.ts`、其 catalog 生成脚本与 package files、`packages/document-bundle/src/static-assets.ts`、`packages/document-bundle/tests/bundle-validation.test.ts`、`apps/document-service/Dockerfile` 的 compat COPY、workspace 版本 / lockfile。真实 S2 包只读使用 `data/pdf-s2/final-fix/current/`。
**Interfaces:** 首先冻结自有内容的 S2 0.1.0 / 3bf… 小包、历史运行时 / CSS 与 metadata；实现 `resolveTrustedCatalog` 和可选 catalog 参数，renderer 当前版本升 0.2.0。`check-s2-compat.mjs --input <file-or-dir> --output <new-dir>` 支持只读遍历 ZIP；不以新代码重建旧 fixture 冒充兼容。
- [x] **Step 1:** 在任何合同 / renderer 改动前生成含列表 / 代码 / 公式 / 重复段落的固定 S2 fixture，保存 UUID / bytes / hash。为目录改变写 RED：旧包在仅当前目录策略下会被拒绝，旧 fixture 不能变。
- [x] **Step 2:** 实现当前目录与唯一已发布 S2 目录选择，仍验证固定资产与逐个生成文件；`await expect(validateBundle(oldFixtureSource, options)).resolves.toBeDefined()`。篡改旧运行时并同步修改文件声明 hash 后仍须拒绝；未知历史 codeSha 同样拒绝。
- [x] **Step 3:** 运行 `npm run test --workspace @pagelingo/document-renderer --workspace @pagelingo/document-bundle --workspace @pagelingo/pdf-cli` 与兼容脚本，四个 S2 包在升级后通过；记录原输入 hash，不重新解析、不写旧目录。
- [x] **Step 4:** 提交 `feat: retain published S2 renderer compatibility`。本任务必须早于任务1，避免新合同立即破坏固定旧包测试。

### Task 1: 网页合同、语言与输入预算

**Files:** 新建 `packages/document-contracts/src/{web-capture,web-reader,web-translation,web-api,web-progress,devices,web-jobs,save-preferences,glossary,language,language-words}.ts` 与领域 schemas；新建 `packages/document-contracts/tests/{web-capture,web-reader,web-api,web-language}.test.ts`；修改该包 `documents.ts`、`index.ts`、现有 schema 生成脚本、各依赖版本；修改 `apps/pdf-cli/src/language.ts` 为共享纯函数薄适配。
**Interfaces:** 产出 §2 DTO、schema、limits；共享 `detectLanguage / blockLanguage / naturalText` 保持现有 PDF 判断结果，不能把原 CLI 的 fs 字典读取带进浏览器。
- [x] **Step 1:** RED：`accepts_web_refs_without_pdf_pages`、`preserves_pdf_v1_shape`、`retains_query_and_hash`；`expect('pdfPageIndex' in webPosition).toBe(false)`，URL 合同接受并保留 query / hash，归一化实现由任务2交付。测试 byte SHA / fingerprint 区别、缺资源声明、重复 ID、过深 JSON、伪 owner、超限及 mixed / und。
- [x] **Step 2:** 实现 strict 合同 / schema parity；将既有词典生成 `language-words.ts` 纯数据并测试与原 fixture 一致，使其字节也进入代码目录摘要；保留既有中文 / 英文规则。Web 仅对不少于40字母、原规则非 mixed/zh/短文、页面语言提示与脚本一致的 fr/de/es（Latin≥90%）、ru（Cyrillic≥90%）、ko（Hangul≥80%）、ja（Hiragana/Katakana≥20%）认定 foreign；其余 und 手动选择。中文提示与英文 meta 冲突仍零自动调用，语言识别永不请求模型。
- [x] **Step 3:** 运行 `npm run test --workspace @pagelingo/document-contracts --workspace @pagelingo/pdf-cli`、两包 typecheck 与 schema 生成核对；PDF 原有语言 fixtures 输出不变。
- [x] **Step 4:** 提交 `feat: define web capture and reader contracts`。

### Task 2: 共用快照清洗与 Web IR 投影

**Files:** 新建 `packages/web-capture/{package.json,tsconfig.json,README.md}`、`packages/web-capture/src/{index,browser,node,sanitize,styles,resources,safe-math,projector,graph,fingerprint,snapshot-previews}.ts`、`packages/web-capture/tests/{sanitize,projector,resources,snapshot-previews}.test.ts`、`packages/web-capture/tests/browser/snapshot.test.ts`；修改 root scripts / lockfile。
**Interfaces:** 实现 §2.3 web-capture 接口；根 entry 仅纯数据，browser entry 不引入 Node，node entry 使用 jsdom；输出服务器与插件可重放的规范化快照。
- [x] **Step 1:** RED：`removes_active_content_after_resource_rewrite`、`preserves_tables_math_and_repeat_ids`、`fingerprint_ignores_capture_time_not_content`。`expect(normalizeCaptureUrl('https://e.test/a?id=7&utm_source=x#part')).toBe('https://e.test/a?id=7#part')`；覆盖 namespace mutation、恶意 CSS、__proto__、表单值、外部 SVG use、两个相同 SVG 的引用隔离。
- [x] **Step 2:** 实现克隆 → 结构 / URL / 样式处理 → 最终 DOMPurify 清洗及复检；SafeMathAst / 图片真实字节和结构预算，按源块 / 资源预算切分预览并保留祖先 / 表格上下文；只在副本运行 Readability。未支持内容保留可回溯材料和具体警告。
- [x] **Step 3:** 在新包定义并运行 `test / typecheck / test:browser` scripts，Node + Chromium 同语义 / source mapping；`expect(executedScripts).toBe(0)`、`expect(unregisteredRequests).toEqual([])`。未知格式不得伪完整；browser bundle 不含 node: / jsdom。
- [x] **Step 4:** 提交 `feat: sanitize and project archived web documents`。

### Task 3: 共用语义渲染与 Web Reader

**Files:** 新建 `packages/document-renderer/src/{web-translation,web-chunking,web-html,semantic-html}.ts`、`packages/document-renderer/tests/{web-reader,web-translation}.test.ts`；修改该包 `html.ts / translation.ts / index.ts` 与 README；沿用任务0的目录机制。
**Interfaces:** 提供 §2.3 Web 函数；保持任务0已交付的旧目录兼容，PDF wrapper / 静态文件字节语义不变。
- [x] **Step 1:** RED：`accepts_published_s2_catalog_after_upgrade`、`rejects_unknown_catalog_and_changed_legacy_bytes`、`renders_bilingual_cells_without_duplicate_ids`；测试 Web sourceRef 无 PDF 页、20k blocks、512KiB 单块与重复公式实例。
- [x] **Step 2:** 提取内容恢复 / 可信 HTML 小模块，PDF wrapper 保持输出；Web 单独处理表格、snapshot 节点引用与双语。Web translation 只通过公共 SDK 规划 / marker 校验 / 解码。
- [x] **Step 3:** 运行 `npm run test --workspace @pagelingo/document-renderer --workspace @pagelingo/document-bundle --workspace @pagelingo/pdf-cli`、typecheck 与 Node import smoke。`expect(Math.max(...build.chunks.map(c => c.blocks.length))).toBeLessThanOrEqual(128)`；旧固定包与四个 S2 原包通过，未知历史 hash 仍拒绝。
- [x] **Step 4:** 提交 `feat: render archived web content and retain S2 compatibility`。

### Task 4: 数据迁移与持久仓库

**Files:** 新建 `apps/document-service/migrations/006-web-capture.sql`、`apps/document-service/src/{devices,web-captures,web-readers,web-jobs,glossary}/repository.ts`、`apps/document-service/tests/integration/web-database.test.ts`；修改 `apps/document-service/src/db/migrate.ts`。
**Interfaces:** 持久化 §2.6 实体；repository 只做绑定 SQL。source / reader 的 FK 与 kind 约束、job epoch、设备 / profile / glossary 修订在数据库中可验证。
- [x] **Step 1:** RED：`migrates_populated_s2_without_changing_pdf_rows`、`rejects_cross_owner_web_refs`、`rejects_immutable_updates`、`keeps_pdf_and_web_current_separate`。
- [x] **Step 2:** 新增 006；新增 nullable 网页字段、latest source / requested job 与当前网页 Reader FK。source manifest 使用 assets 的实际 byte hash；checkpoint / owner cache 单独可变行，不借用不可变 S2 translation_runs。
- [x] **Step 3:** 用 `npm run test:service:db -- --run tests/integration/web-database.test.ts` 在独立 schema 验证迁移重放 / rollback / 约束；`expect(oldMigrationChecksumsAfter).toEqual(before)`，旧 PDF 数据 / Range / reader FK 仍通过。
- [x] **Step 4:** 提交 `feat: persist private web captures and job state`。

任务4验证记录：28项新增数据库回归、类型检查和构建通过；整套151/152，旧PDF幂等测试超时后单独复跑通过。任务5在无本任务并行负载、单worker运行下取得170/170通过（设备期限常量修正前）；最终源码冻结后的全量运行仍在任务13执行，不以单测复跑冒充全量通过。

### Task 5: 配对、设备授权与设置入口

**Files:** 新建 `apps/document-service/src/devices/{service,routes,guards}.ts`、`apps/web/src/features/settings/devices-panel.tsx`、对应 service / web tests；修改 service `auth/routes.ts / users/service.ts / app.ts`、web `features/settings/provider-page.tsx`。
**Interfaces:** 实现 §2.4 device API 与 CapturePrincipal。随机配对码至少 128bit、token 256bit，数据库只存摘要；配对创建 / 消费绑定 user authVersion 与原会话。
- [x] **Step 1:** RED：一次性消费并发只能成功一次、5 分钟过期、限流、token 不可读 Key / admin / Reader；普通 logout 撤销该 session 配对设备，allDevices / 密码重置 / 停用撤销全部旧 authVersion。
- [x] **Step 2:** 实现配对、列表、撤销及 scope 鉴权；无效 Bearer 不回退 Cookie；设备认证不放宽 session Origin / CSRF。
- [x] **Step 3:** 新增 `tests/integration/devices.test.ts` 与 web `tests/e2e/devices.test.ts`，通过现有 DB / site runner 执行；`expect(secondExchange.statusCode).toBe(401)`、`expect(otherOwner.statusCode).toBe(404)`。撤销后的最后文件 / commit 不发布，设置读取与日志无完整 token / Key。
- [x] **Step 4:** 提交 `feat: pair and revoke capture devices`。

### Task 6: 采集接收、原文版本与私有资源 API

**Files:** 新建 `apps/document-service/src/web-captures/{service,routes,staging,publication,validation-worker}.ts`、`apps/document-service/src/web-readers/{service,routes,assets}.ts`、测试 helpers / integration；修改 service `documents/{repository,service,routes}.ts`、`cli/cleanup-staging.ts`、`app.ts / config.ts`。
**Interfaces:** 实现 captures / snapshots / reader 私有 API；create → 独立文件 PUT → commit。commit 在可终止 worker 中复检与投影，不信任客户端 Reader IR 或译文格式树。
- [x] **Step 1:** RED：中断单文件后 missingFileIds 正确、同 key 不同 manifest 冲突、commit 丢响应可重取 completed；同 URL 内容变了建版本，相同内容不重复建源；web 不能绑定 PDF 目标。
- [x] **Step 2:** 实现独占暂存、实际 hash / MIME、完整性状态、不可变对象与短事务发布。可选译文逐单元 SDK 校验，只接收与原文绑定匹配的结果；不匹配不丢原文、不标完成。
- [x] **Step 3:** 新增 `tests/integration/{web-captures,web-reader-routes}.test.ts` 并用现有 DB runner 执行：取消 / revoke / cleanup 竞态、对象最后时刻丢失、越权、HTML attachment、资源闭包、旧 current 不退化；`expect(modelCalls).toBe(0)`。长验证期间用户锁可用。
- [x] **Step 4:** 提交 `feat: receive and publish private web captures`。

任务6已通过独立审查与修复复审。工作区787项、完整数据库184项在最后局部修正前通过；后续渲染器83项、网页集成18项及最终发布修复25项、相关类型检查与构建通过。浏览器全量56/57，失败用例及其所属14项测试随后在原时限下通过，原因尚未确认；原失败截图在复跑时丢失，日志和错误文字已保留。最终冻结源码的全量验证仍由任务13执行。

### Task 7: 浏览器原文采集与四类来源

**Files:** 新建 `apps/extension/src/archive/{collector,original-tree,resource-manifest,existing-translations}.ts`、`apps/extension/src/archive/adapters/{blog,x,zhihu,wechat}.ts` 与 fixtures / unit / e2e；修改 `apps/extension/src/content/{index,page-controller}.ts`、必要的 DOM 公开只读接口。
**Interfaces:** `collectOriginalCapture(document, options)` 实现原文快照；返回 CaptureDraft。受信任扩展发起一次 capture grant，绑定 tab / frame 0 / documentId / URL / revision；网页不能选择上传站点或发起通用 fetch。
- [x] **Step 1:** RED：在 source / translation / bilingual 模式收藏产生相同原文；不含 data-pl-owned、API 设置、表单值；相同文字段落不同 ID，DOM 更新会中止旧采集。
- [x] **Step 2:** 复用现有 X 正文作用域，另收主帖媒体 / 作者 / 时间 / 外链，不混入引用与回复。博客保留 article 结构；知乎按明确回答身份或文章取根，不能判定时保留链接并引导独立回答链接；公众号保留必要 query 与 lazy data-src。不自动展开登录 / 验证或递归抓外链。
- [x] **Step 3:** 新建 `apps/extension/tests/unit/{archive-original,archive-adapters}.test.ts`、`apps/extension/tests/e2e/archive-source.test.ts`，用 extension test / e2e runner 执行。`expect(savedOriginalInThreeModes).toEqual([original, original, original])`；未加载主帖不能改采回复。候选译文必须匹配原文指纹，不匹配只跳过候选并警告。
- [x] **Step 4:** 提交 `feat: capture original browser articles and source boundaries`。

任务7已通过独立审查与修复复审。修复前工作区817项、扩展完整浏览器57项通过；最终合同/采集/扩展/渲染器334项、原生浏览器6项、采集端到端3项与相关类型检查/构建通过。旧采集完成不能恢复资源授权，blob合同大小写与来源校验一致，主帖链接卡片与引用/回复分开。不能严格证明匹配的已有格式/保护/section译文明确跳过；真实资源获取、持久上传及最终来源验收仍属后续任务。

### Task 8: 连接站点、资源获取与持久 outbox

**Files:** 新建 `apps/extension/src/archive/{binding,client,database,outbox,upload,resources,grants}.ts`、`apps/extension/src/options/site-connection.tsx`、`apps/extension/src/popup/capture-panel.tsx`、对应 tests；修改 manifest、service-worker、options / popup 入口。
**Interfaces:** 实现 §2.3 outbox 接口。绑定 `{siteOrigin,siteId,ownerId,deviceId,generation}`；token 只在 trusted extension storage，原 LLM settings 不迁移 / 上传。IDB 单独 archive 数据库，普通翻译清缓存不删待上传材料。
- [ ] **Step 1:** RED：outbox 关闭 popup / 终止 service worker 后恢复，文件失败只重传缺项；server commit 响应丢失不建新 capture；A→B 重新配对不读取 / 投递 A 项，旧响应不复活 UI。
- [ ] **Step 2:** 站点仅 HTTPS 或 loopback 开发 HTTP、固定 origin / 端口，API 拒绝 redirect、credentials omit。权限仅用户点击时申请具体站点 / 资源 host；资源 bytes 不附带 Cookie / Authorization 元数据。content→background 是有界 JSON，二进制用不超过 256KiB 的 base64 帧，不能传 Blob / Node。
- [ ] **Step 3:** 先持久化源数据，再存每个已获取文件和最终 manifest；HTTPS / data / 当前页面 blob 资源有各自可验证来源，未授权 / 失效 / 防盗链失败保留 missing。alarm / startup / 显式重试接续，有界退避；消息必须匹配 capture grant 和 document 身份。
- [ ] **Step 4:** 新增 `apps/extension/tests/unit/archive-outbox.test.ts`、`apps/extension/tests/e2e/archive-upload.test.ts`，用 extension test / e2e runner 验证配对、中文无 Key、授权拒绝、page close、worker kill、丢 ack、账号切换和撤销。`expect(serverDocumentCountAfterRetry).toBe(1)`、`expect(bAccountUploadedAItem).toBe(false)`；确认前不显示“原文已保存”。提交 `feat: persist and resume extension capture uploads`。

### Task 9: 保存偏好、术语与长期任务身份

**Files:** 新建 `apps/document-service/src/glossary/{service,routes}.ts`、`apps/document-service/src/web-jobs/{profile,preferences,routes}.ts`、`apps/web/src/features/settings/{save-preferences,glossary-panel}.tsx`；修改 Provider settings UI / app，新增 integration / browser tests。
**Interfaces:** 实现 prefs / glossary / create job / cancel / retry API；`resolveJobProfile(lease)` 以 owner / authVersion / profileRevision 检查并临时解密，不复用 requireSession 或把 Key 返回 DTO。
- [ ] **Step 1:** RED：默认 auto=false；保存 / 测试配置不启动历史资料；用户显式开始才建 job；中文 / no-language 零请求；术语用 SDK 校验 / 合并 / 上限，跨用户隔离。
- [ ] **Step 2:** 保存不可变术语修订与非敏感 job 配置，profile 修订不匹配暂停。新模型 / 新术语只在新 run 使用；重试只接受相同有效配置，失效时返回明确 PROFILE_CHANGED，引导显式新 run。
- [ ] **Step 3:** 新增 service `tests/integration/{web-job-settings,glossary}.test.ts`、web `tests/e2e/web-job-settings.test.ts`，经 DB / site runner 验证 keep / replace / delete Key、换配置并发、旧来源可读、停用不能启动；`expect(callsAfterSavingProfileOnly).toBe(0)`，device 不能读 glossary / Provider，错误 / 快照无假 Key。
- [ ] **Step 4:** 提交 `feat: bind web jobs to personal settings and glossary`。

### Task 10: 链接记录与受控公开页面补抓

**Files:** 新建 `apps/document-service/src/network/{pinned-transport,capture-fetch,provider-job-fetch}.ts`、`apps/document-service/src/web-captures/{links,fetch-runner}.ts`、相关 unit / integration；修改既有 safe-fetch 只提取共用连接层，旧 Provider 接口保持严格。
**Interfaces:** 实现两种新 fetch、`POST /documents/links`、`runFetchJob(lease)`；公开 article 用 Readability clone + 同一清洗投影；X / 知乎 / 公众号需浏览器时保留链接与待补原因，不伪装服务端已取得登录正文。
- [x] **Step 1:** RED：含 query 文章可取、每跳 DNS / 实际 peer 校验、public→private 重定向拒绝、IPv4 / IPv6 / mapped / metadata 地址拒绝、实际解压字节超限中止；旧 Provider query / redirect 仍拒绝。
- [x] **Step 2:** capture fetch 只作公开 HTTP/HTTPS GET/HEAD，允许正文所需 query、拒绝 userinfo 与 HTTPS→HTTP 降级；凭据不跨 host 转发，重定向逐跳验证。Provider job fetch 保持原 HTTPS / 无 query / 无 redirect 规则，在 headers 到达时返回受限流，消费完 / abort 才关闭 agent，不提前缓冲整条 SSE。
- [x] **Step 3:** 新增 `tests/unit/{capture-fetch,provider-job-fetch}.test.ts` 与 integration `web-links.test.ts`，执行 service unit / DB runner。断续 SSE 应在 body 完成前返回 headers，`expect(connectedAddresses).toEqual(validatedAddresses)`；超时 / cancel 关闭 agent，帖子无正文仍仅链接。复用 TLS / DNS 测试注入，不新增生产私网绕过开关。
- [x] **Step 4:** 提交 `feat: fetch public articles with bounded streaming transport`。

任务10已通过独立审查，无重要问题。最终数据库216项、类型检查与构建通过；服务端单元129项在登录页识别修正前通过，修正后受影响2项及最终数据库覆盖通过。审查中的跨域重定向与真实worker探针通过，永久回归补充及测试输出提示在任务13归整。公开补抓目前保留UTF-8正文，图片/CSS/blob明确标记缺失；登录或不可读内容保留链接，插件资源获取与后台调度仍由后续任务完成。

### Task 11: 后台翻译 worker、检查点与发布

**Files:** 新建 `apps/document-service/src/web-jobs/{lease,state-store,cache,translation-runner,publication,finalize}.ts`、`apps/document-service/src/worker/main.ts`、测试 fixtures；修改 service `app.ts` 的 job 入队连接、dev-site / test-site worker 生命周期、Docker / Compose 构建与 worker 服务。
**Interfaces:** 实现 claim / SDK state-store / cache / runWebJob；worker 调用 fetch runner 或 translation runner。API 只入队和授权，不以请求生命周期托管模型调用。
- [ ] **Step 1:** RED：停止浏览器后继续；杀进程恢复只补未完成单元；两用户缓存 / 用量隔离；同 capture 重投只建一个自动任务；两个独立 worker 下 `expect(maxRunningGlobal).toBeLessThanOrEqual(2)`、`expect(maxRunningPerOwner).toBe(1)`，SDK429冷却跨重启保留。
- [ ] **Step 2:** SDK TranslationEngine + owner cache + 原子 checkpoint；有界部分可读版本；fresh owner/profile/lease 围栏、流式 abort、不可变对象与短事务发布。取消终结器从最后确认 checkpoint 保留部分结果，旧 epoch 写入抛 CheckpointConflictError。
- [ ] **Step 3:** 新增 integration `tests/integration/{web-jobs,web-job-restart,web-publication}.test.ts`，经 DB runner + 独立 mock-worker 子进程验证换 Key、停用、取消、lease、旧 job 迟到与清理竞态；`expect(replayedCompletedUnitRequests).toBe(0)`、`expect(currentVersionAfterLateOldPublish).toBe(newVersion)`；Key 不进入任何序列化状态 / 日志。
- [ ] **Step 4:** 开发与 Compose 启动独立 worker；使用同持久卷 / 数据库 / 运行时密钥，验证 schema 后领取。测试用可注入 mock Provider entry，不在生产加“允许私网 / 忽略验证”环境开关。提交 `feat: translate archived web documents with durable workers`。

### Task 12: 网页资料库、阅读、快照与进度

**Files:** 新建 `apps/web/src/features/web-reader/{web-reader-page,web-reader-content,snapshot-preview,web-source-locator,web-job-status}.tsx`、该目录的 `{web-reader-window,resolve-web-position,use-web-reading-progress}.ts`、`apps/web/src/features/library/link-dialog.tsx`、对应 e2e；修改 library page / document-page / row / router，按最小接口提取通用 chunk window / interaction writer，PDF wrapper 保持现状。
**Interfaces:** 消费 Web descriptor / chunks / snapshots / jobs / progress；同一 source / selected version 固定正文；WebReadingPosition 不含任何 PDF 字段。
- [ ] **Step 1:** RED：中文 / 英文原文 / 译文 / 段落双语、无 API 可读、关闭原站后图片公式仍在；恶意 snapshot 无脚本 / 出站 / 主站 Cookie 读取，退出和换账号释放全部 Blob 与窗口。
- [ ] **Step 2:** 实现 link 添加、分别展示保存 / 语言翻译 / job 状态，完整警告收起可展开。快照 Blob iframe 与可信正文区分，sourceRef 定位固定节点；原网站链接保留。新译文提示切换，不打断当前段落。
- [ ] **Step 3:** 20k-block 正文窗口最多3片、快照仅1个有界预览片段；重复 quote 有歧义时不假定位。验证跨设备 / 历史版本 / 新快照降级 / CAS冲突显式继续 / 慢保存maxWait / 迟到请求隔离；三模式被动恢复零 PUT、零模型请求。
- [ ] **Step 4:** 新增 `apps/web/tests/e2e/{web-reader,web-progress,web-snapshot}.test.ts` 并用 site runner 验证：`expect(visibleTextHeight).toBeGreaterThanOrEqual(240)`、`expect(passiveProgressPuts).toBe(0)`。390×844明暗主题含restore/conflict/warnings，表格/代码局部横滚；旧PDF四旋转、20k窗口和账号隔离回归。提交 `feat: read archived web snapshots and bilingual content`。

### Task 13: 端到端来源、升级、重启与交付

**Files:** 新建 `scripts/check-web-capture.mjs`、`docs/learning-site-s3-validation.md`、`docs/extension-site-capture.md`、`docs/superpowers/specs/assets/2026-10-27-s3-validation/`；修改安装文档 / 包 READMEs / test-site / restart / root scripts / Docker 清单。
**Interfaces:** `npm run check:web-capture -- --samples <samples.json> --output <new-dir>`；fixtures / 当前真实来源输入分开记录，默认 mock Provider，无环境 Key 读取和付费调用。
- [ ] **Step 1:** 真扩展 → 站点 API → private ObjectStore → 独立 mock worker → reader 全链路；各类采集至少覆盖中文 / 英文、图、代码 / 公式、X回复边界、知乎回答与公众号 lazy 图。原站不可达后仍能读已存资料；每份真实样本记录 URL、时间、scope、资源 hash 和未验项，不以合成 fixture 冒充当前真实来源。
- [ ] **Step 2:** 服务 S2→006 升级、浏览器 worker / 服务器 worker 中断、丢 ack、取消 / 换 Key / 停用、保留卷重建 API/worker/db后验证资料、部分译文、术语、进度、私有资源与权限；旧 S2 固定包及四个原包继续导入 / 下载复验，输入前后 hash 不变。
- [ ] **Step 3:** 冻结共享源码 / static / dist 后顺序执行 `npm ci`、`npm run check`、`npm run check:site`、明确 samples 的 `check:web-capture`、S2兼容校验和 `npm audit`。Python未改则沿用S2证据；若实际改动才追加pdf:lint/pdf:test与原布局检查。每条命令记录退出码 / 来源范围 / mock与语义质量边界。
- [ ] **Step 4:** 保存当前真实截图与来源验收矩阵；真实登录页无法取得时明确该 live case 未验证，不宣称该来源全部交付。开发 / 安装流程包含配对、权限、原文先保存、自动翻译偏好、撤销与重连，移除任何无效占位入口。
- [ ] **Step 5:** 自检并提交 `docs: document S3 capture workflow and validation`。由控制方统一进行整分支审查与针对性修正复核；合入 / 推送按用户最终集成选择，保留宿主管理 worktree。不得提前勾选最终验收或宣称真实语义质量通过。

## 4. 计划自检与执行交接

审核时关注：设备 scope 与会话不同；outbox 绑定站点 / 账号 / 代次；原始采集字节与规范化来源指纹不同；PDF / Web 来源合同和 current 指针不同；旧 S2 目录是显式兼容而非任意代码白名单；模型连接测试不排历史任务；网页 / 原件 / 已有译文读取不出站。

需求映射：A02 → 4–6/8/11–13；A03 → 9/11；A04 → 2/7/8/12/13；A05 → 6/9–13；A06 的当前 X 内容与范围 → 7/8/13，资料发现关系留在 S4；A12 → 6/8/9/11/13；A13 网页进度和窄屏 → 12/13，管理操作留在 S4；A15 升级 / 重启 → 4/13，完整灾备留在 S5；A16 → 0/3/13。

2026-10-27 已完成计划自身审查：S3 需求均映射至上述任务；核对了生产入口、SDK 方法及测试路径；将旧包兼容提前到任何合同修改之前；固定浏览器 / Node entry 边界、任务租约类型和跨进程并发规则，并为五类 Review Focus 指定回归。编写时尚未开始实现；当前执行进度以各任务勾选和验证记录为准，所列验收结果必须在实现后取得。

用户已审核并批准此 S3 具体计划，按任务顺序实现与审查。需要改变公开协议或阶段边界时记录明确决定，不以工作流检查点反复中断已授权实现。

## 参考依据

- [已批准的 V1 设计](../specs/2026-10-26-personal-learning-site-design.md)与[S2验收](../../learning-site-s2-validation.md)决定产品范围及既有兼容基线。
- [Chrome service worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：不能依赖长驻全局变量；上传状态存 IDB 并验证被终止后的恢复。[权限说明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)支持按实际 host 申请可选权限。
- [Readability](https://github.com/mozilla/readability)的解析会修改 DOM，因此只对副本调用；正文抽取不代替安全清洗。
- [DOMPurify](https://github.com/cure53/DOMPurify)说明 HTML / SVG / MathML 与 Node DOM 支持，清洗后改写仍需复检；[jsdom](https://github.com/jsdom/jsdom)用于不执行页面脚本的 Node DOM。2026-10-27 通过 npm metadata 核对版本：jsdom30.1.3要求Node24.15+，与当前24.13不符，故锁兼容29.1.1；执行时仍运行依赖审计和安全输入回归。
- [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)用于限制快照权限；opaque frame 不依赖主站 Cookie 取私有资源，父页面认证资源后将图片嵌入自包含 Blob HTML。实现后须以 Chromium 测试验证无脚本 / 网络 / 顶层导航。

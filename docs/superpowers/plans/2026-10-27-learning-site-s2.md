# Learning Site S2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地将 PDF 处理为可验证、可离线阅读的完整包，上传后在本人资料库中提供左 PDF / 右译文 HTML、原页定位和跨设备阅读进度。

**Architecture:** 正式 Reader IR 与译文合同连接现有 Python 解析、translation-core、可信共享 renderer 和网站。Node CLI 保存本地检查点并生成完整包；文档服务验证包、保存不可变对象，再原子发布可读版本。网站只读取结构化内容和本人资产；普通阅读不依赖本地处理机或模型服务。

**Tech Stack:** 沿用 S1 的 Node.js 24.13.0、TypeScript 7.0.2、React 19.3.0、Fastify 5.12.7、PostgreSQL 17.11、Zod 4.6.7、Vitest 5.0.3、Playwright 1.63.0、PDF.js 6.4.299；本地解析沿用 Python 3.12 / uv、MinerU basic 与现有 P0 布局投影。

**Spec:** [2026-10-26-personal-learning-site-design.md](../specs/2026-10-26-personal-learning-site-design.md)，用户于 2026-10-27 批准；主要实现 §5.3–5.4、§6.2–6.3、§10、§13 中的 S2。

状态：S1 已合入并同步到 main，基线为 `056c5c5`。用户于 2026-10-27 审阅并同意执行本计划；在 `feat/learning-site-s2` 分支沿用 S1 的逐任务实现、独立审查与最终整分支审查，无需逐任务再次确认。

## Global Constraints

- 各用户保存自己的数据，首版不共享。所有业务读取、写入、任务领取和文件响应都从会话 / 设备身份取得 owner，忽略客户端自报 owner。
- 管理员角色只额外开放账号管理 API，资料读取仍按所属用户执行。
- 原件、raw、source IR 和已完成译文版本不可原地覆盖。
- 本地配置中的 API Key 留在本地。包中包含脱敏的生成配置与用量，服务器导入包不需要取得该 Key。
- 用户 Key 不写入任务快照、日志、HTML、普通资料导出或 parser 环境。
- SDK 保护、术语、校验和长段拆分继续为公共实现，适配器不复制一套保护算法。
- PDF 的 `pageIndex` 从 0 开始；bbox 使用旋转后 CropBox、左上原点、0–1 归一化坐标。
- 默认 npm 检查不安装 Python / 模型，也不调用真实 LLM。
- 原 P0 产物和已发布包保持不变，所有新处理写入新 run / 目录。
- 使用 strict TypeScript、ESM、两空格、单引号、分号；数据库和文件系统依赖留在服务 / Node 适配层。

## Review Focus

1. 旧预览只有原文、部分页解析成功或图中仍是英文时，不能显示全文翻译完成；中文与不确定语言默认零模型调用。任务 1、4、5、9、12 覆盖。
2. 相同包重传、导入取消 / 失去 epoch、账号被停用及清理器并发时，不能发布缺对象的版本或回退当前成功版本。任务 7、8、9 覆盖。
3. ZIP 声明大小与实际解压量不符、路径别名、伪造资源类型、HTML / TeX 中的主动内容，不能越过容量、磁盘或站内执行边界。任务 2、3、6、8 覆盖。
4. 90 / 270 度、非零 CropBox、跨页段落、repair 缺少精确来源时，定位必须与真实 PDF 显示一致，不能用文字块的近似框冒充精确来源。任务 1、4、10、12 覆盖。
5. 切换用户、版本或快速跳章后，迟到的分片 / 保存请求不能混入当前页面、覆盖新进度，长书不能持续积累正文 DOM。任务 8、10、11、12 覆盖。

---

## 1. 范围、工作区与交付顺序

本阶段交付 A07–A10、A14，以及 A02 / A12 / A13 / A15 / A16 中与 PDF 导入、阅读、进度及重启有关的部分。网页采集、站内后台翻译、标签 / 集合 / 回收站、备份恢复分别按 S3–S5 实现；S2 不为这些功能加入占位按钮。

复用 `/home/liujia/.codex/worktrees/21fe/pagelingo` 隔离工作区，分支 `feat/learning-site-s2`。实现前在此工作区运行 `npm run check` 与 `npm run check:site`，记录退出码和基线；已有相同树的验收记录可以作为对照，不能代替改动后的验证。按任务 1–12 顺序执行，不并行修改存在接口依赖的模块。

先使用 BERT 16 页论文跑通所有阶段；再使用 Attention 15 页论文和两本长书扩展。首版正式适配 MinerU P0 + 已验证的布局投影；Docling raw 继续保留，但缺少适配时明确返回不支持，不能输出伪造的成功 IR。增强解析和语义译文质量单独记录，不以 basic 或模拟译文代表高质量处理已完成。

### 1.1 文件与职责

| 位置 | 职责 |
| --- | --- |
| `packages/document-contracts/src/reader.ts`、`reader-source.ts`、`reader-translation.ts` | Reader IR、来源、译文合同和结构校验 |
| `packages/document-contracts/src/bundle.ts`、`reader-api.ts`、`progress.ts` | 包、导入 / 分片 API、进度 DTO 和限制配置 |
| `packages/document-contracts/schemas/reader-*.schema.json`、`document-bundle.schema.json` | 与 TypeScript 合同一致的正式 JSON Schema；原 P0 schema 不改 |
| `packages/document-renderer/src/` | 纯数据投影、SDK 译文复验、分片、可信 HTML / 数学排版；无 DOM、磁盘和数据库 |
| `packages/document-bundle/src/` | Node ZIP 流、哈希、资源闭包、完整包读写；不访问业务数据库 |
| `apps/pdf-cli/src/` | Python 子进程、P0 兼容适配、语言选择、本地检查点 / 缓存和离线导出 |
| `apps/document-service/src/bundle-imports/` | 暂存、导入状态、围栏、原子发布和失败记录 |
| `apps/document-service/src/readers/` | 本人 Reader 版本 / 分片 / 资产、完整包下载与进度 |
| `apps/web/src/features/reader/` | 双栏、目录、有界内容窗口、原页高亮及进度交互 |
| `apps/web/src/features/library/bundle-import-dialog.tsx` | 新建条目 / 已有 PDF 的包导入、取消和错误反馈 |

`document-contracts` 升至 `0.2.0` 并更新所有内部引用；三个新 workspace（renderer、bundle、pdf-cli）使用 `0.1.0`，不发布 npm。translation-core 保持 `0.4.0`，不改变其保护 / 缓存语义。

### 1.2 新依赖与工具约定

版本于 2026-10-27 从 npm Registry 核对，安装使用 `--save-exact` 并提交锁文件：

| workspace | 新增依赖 |
| --- | --- |
| document-contracts（仅开发验证） | `ajv@8.20.0`、`ajv-formats@3.0.1`，验证分发 JSON Schema 的 shape fixtures |
| document-renderer | contracts `0.2.0`、translation-core `0.4.0`、`katex@0.19.1`（自带类型） |
| document-bundle | contracts、renderer、`yauzl@3.4.0`、`yazl@3.3.1`；开发依赖 `@types/yauzl@3.4.0`、`@types/yazl@3.3.1` |
| pdf-cli | contracts、renderer、bundle、translation-core、`parse5@8.0.1`；旧 exporter 的独立 KaTeX 0.19.0 环境沿用现有 renderer lock / 显式准备命令 |
| document-service | bundle、renderer；web 新增 renderer |

新包沿用仓库的 TypeScript / Vitest 版本及 ESM 构建。构建依赖顺序为 SDK → contracts → renderer → bundle → CLI / service / web。`npm run check` 的新单元测试只使用仓库 fixture 和模拟 Provider，不启动 Docker / Python。`check:site` 继续使用已有隔离 PostgreSQL 和真实 API 浏览器测试。

ZIP 采用 [yauzl 的逐项读取](https://github.com/thejoshwolfe/yauzl#readme) 和 [yazl 流式写入](https://github.com/thejoshwolfe/yazl#readme)；TeX 使用 [KaTeX trust / expansion 限制](https://katex.org/docs/options)。实施安装后审计依赖。旧预览依赖只在本地处理环境使用，不放入服务镜像，不以覆盖旧包产物解决升级问题。

## 2. 冻结的协议与运行参数

以下是 Spec §15 委托 Plan 决定的技术细节。任务不能自行改变身份、状态或路径语义。

### 2.1 Reader IR 与译文

- `ReaderIR.schemaVersion = 'reader-ir/1'`。包含 `metadata {title, originalFilename, language:LanguageDecision}`、`source {kind:'pdf', sha256, bytes, pageCount}`、`parse {id, inputManifestSha256, projectorVersion, configSha256, parserName, parserVersion, modelLockSha256, pythonLockSha256, coverage, status, requestedPageIndices, parsedPageIndices}`、`pages`、`roots`、`nodes`、`blocks`、`assets` 和 `warnings`。缺失的上游版本信息显式 null / warning，不能填造版本；脱敏 parser config 以 provenance 文件保存并校验 configSha256。
- `parse.id = 'p_' + SHA256(sourceSha256 + inputManifestSha256 + projectorVersion + configSha256)`。block / 容器 ID 分别以 `b_` / `n_` 开头，由该 parse 身份、raw pointer、结构子路径产生 32 位十六进制摘要。相同输入重跑 ID 不变；重复文字在不同位置有不同 ID；发现碰撞拒绝，不以文本去重。
- 旧预览兼容投影的 `projectorVersion` 固定为 `pagelingo-legacy-preview/1+<verified-preview-manifest-sha256>`，包含实现版本与已验证预览输入身份；不混入输出路径、时间或工作流 UUID。相同预览重跑的 ID 稳定，人工修复并更新有效 manifest 后形成新 parse 身份，避免同一 P0 run 的不同预览结构共享不可变 ID。
- `ReaderNode {id, kind:'section'|'group'|'list'|'list-item'|'callout'|'block', children, blockId?, presentation?}`；`block` 节点只引用一个 block，不能有 children。其他节点不能带 blockId；list 有 ordered / start，section 有 headingBlockId，callout 有 note / definition / example / prompt 语义。全部节点形成有序、无环、无共享子节点的树，每个 block 恰被引用一次。
- `ReaderBlock` 按 `type` 区分 `text`、`image`、`code`、`math`、`rule`，共同有 `id` 和 `sourceRefs`。text 的 `value` 完整复用 `TranslationBlock`，其 id 必须等于 block.id；附加 `bindings` 和 `language`，不得另造 inline 类型。image 保存 assetId、alt、role 和 originalRegion；caption 是单独 text block；code 保存原文和可选语言；math 保存原始 LaTeX、displayMode 和可选区域图回退。
- `bindings` 只允许链接（HTTPS / HTTP / mailto 或文内 block）、受限样式（强调 / 对齐 / 等宽枚举，color / backgroundColor 仅 `#[0-9a-f]{6}`）、protected 对象（inline math、code、literal、asset）。链接的两端 shape 使用相同 portable whitelist；WHATWG URL 合法性由 validateReaderGraph 检查，shape 通过不等于可直接展示。格式 / protected ID 都是 block 内局部 ID，绑定与 inline 引用逐个对应；资源引用是逻辑 assetId，不是磁盘路径。`ReaderAsset {id,path,sha256,bytes,mediaType,width,height}` 只用于 PNG / JPEG / WebP；原 SVG / HTML 可归档，不直接渲染。
- `PdfSourceRef {pageIndex, precision:'page'|'bbox', bbox?}`；bbox 是 `[x0,y0,x1,y1]`、有限数、严格正面积且在 `[0,1]`，page 不能携带 bbox。每页 `PdfPageMetadata` 保存 pageIndex、原始 MediaBox / CropBox、有效 displayCropBox、rotation `0|90|180|270`、displayWidth / displayHeight 和六元 pdfToDisplay 仿射矩阵（PDF user-space points → 旋转后有效 CropBox 的 display points，scale=1；再除显示宽高才得到归一化坐标）。正式 Reader parse.status 只允许 complete / partial，coverage 为 full / partial；full 要求全源页都已解析且 status=complete，子集或 partial 状态一律 partial。原 P0 full / sample 仅保留在 provenance，不修改；全失败 parser run 不作为可发布 Reader 输入。页面索引和 coverage 必须与全源页数一致；无法可靠确定的变换 / repair 降级为 page，并记录 warning。
- `ReaderTranslation.schemaVersion = 'reader-translation/1'`；包含独立 `id`（每次导出的不可变译文快照 UUID）、`jobId`、sourceSha256、parseId、readerIrSha256、SDK / prompt / protection 版本、sourceLanguage（nullable，含显式覆盖值）、targetLanguage、profile、预算、术语及其 hash、selectionBlockIds、Provider 的 model / endpointFingerprint、metrics、block 结果、unit 结果和整体状态。`generationKind:'model'|'mock'|'none'` 明确区分真实生成、流程验收模拟和无译文；模拟内容在包与页面显示标识。仅导出允许字段，不导出原始 Base URL、配置对象或 Key。
- `selectionBlockIds` 必须按 IR 阅读顺序选择 text block；`toTranslationDocument(ir, selectionBlockIds, sourceLanguage?)` 是唯一投影，默认使用 metadata.language 的确定语言，显式覆盖值随译文保存并在导入复验时重放。保存 SDK checkpoint.blocks 中的原始 protected text，不拿已恢复术语的 batch.text 反向编码。`planUnits` 重建完全相同的 inputs / units，逐单元 `validateStructure`，完整 block 通过 `decodeTranslation` 恢复可信原文对象与术语；不接受外来格式树直接替换源绑定。
- 每个 text block 有 `translated` 或 `source-only` 结果；后者原因限于 `language-not-required|manual-choice|pending|failed|cancelled`。unit 状态包含 `covered-by-block`，只在整个 block 的缓存 / 检查点结果通过复验时允许；否则 completed 必须有通过 SDK 验证的 rawText。未知 / 重复 / 缺失 block、unit 或不同源 hash 拒绝。
- 整体状态为 `not-required|pending|partial|completed|failed|cancelled`。仅中文 / 无自然语言内容为 not-required；外语未翻译或语言不确定为 pending；有成功译文且仍有待处理 / 失败单元为 partial；全部应译文本完成才为 completed。解析 coverage、缺页和保留原件区域单独显示，completed 不代表图片内文字已翻译。
- 当前版本保护分别判断译文与解析：旧译文 `completed|not-required` 即使 parse coverage 为 partial，也不自动切换到新的 pending / partial / failed / cancelled；旧 partial 译文不自动退回 pending / failed / cancelled 空白。全量解析且译文成功的当前版本还需避免降级到 partial parse。首次无 reader 时有效原文 / 部分版本可读，未提升的有效新版本保留历史供选择。

`LanguageDecision {language:'zh'|'en'|'mixed'|'und', reason}` 随 text block 保存；reason 限于 `no-language|han-only|insufficient-text|other-script|han-majority|mixed-script|english-heuristic|uncertain|document-inherited|user-specified`。语言决定不调用模型：`detectLanguage(text): LanguageDecision` 忽略 protected 内容后计数，依序命中停止：无字母为 und / no-language；只有 Han 字母为 zh；有效字母不足 40 为 und；假名 / 韩文等其他书写系统占比超过 5% 为 und；Han 占全部字母 ≥ 60% 为 zh；Han 与 Latin 各占 ≥ 20% 为 mixed；其余 Latin ≥ 90% 且匹配至少 3 个不同英文常用词、词数占比 ≥ 8% 才为 en；其他为 und。固定英文词表随合同 fixtures 提交。

先对全部自然文本判定文档语言，再判断各块。仅因长度不足而 und、且只有 Latin 的短标题 / 短段可继承已确定的文档 en，记录 document-inherited；中文、其他书写系统和 mixed 不继承。auto 只选择 en，zh / no-language 直接原文，mixed / 其余 und 明确待手工选择；用户可显式选全部 text 并覆盖源语言，默认不会为中文产生请求。这样英文论文的短标题可以翻译，中文引语仍默认保留。

### 2.2 包、资源与容量

`DocumentBundleManifest.schemaVersion = 'pagelingo-document-bundle/1'`，包含 packageId（UUID）、createdAt、title / originalFilename、source 身份、parse 身份、translation 身份 / 状态、renderer 版本 / 代码 hash 和文件清单 `{path, bytes, sha256, mediaType, role}`。必需路径沿用 Spec §10.3；清单列出除 manifest.json 自身外的全部普通文件，既不能漏文件，也不能多出 ZIP 文件。manifest 的 canonical JSON SHA-256 是包内容身份；ZIP 压缩方式 / 时间戳变化不构成新内容。

文件绑定统一为实际字节 SHA-256：source.pdf、source-ir.json、translation.json、provenance/input-manifest.json、provenance/parser-config.json 和所有清单项。manifest.readerIrSha256 / translation.readerIrSha256 绑定 source-ir.json 字节；manifest.translation.sha256 绑定 translation.json；parse.inputManifestSha256 / configSha256 绑定上述两个必需 provenance 文件。只有嵌入的 glossary 与 manifest 身份使用 SDK contentHash 的 canonical JSON。生产端复用 bundle 的 serializeBundleJson（UTF-8 stableJson，无 BOM / 换行）和 deriveParseId；安全的原始 P0 input-manifest 保留原字节，不能静默重排后仍声称原 hash。

parser-config 是 strict `{schemaVersion:'pagelingo-parser-config/1',parser:{name,version},options}`；身份与 IR 一致，options 仅允许当前 worker 的 tier、smallBackend、device、parseMode、imageAnalysis、vlm、pageRange、threadsRequested、onnxIntraOpThreadsRequested、onnxInterOpThreadsRequested，类型与范围见 bundle 的 parseParserConfig；未知键拒绝，生产者正向选择字段。原始输入本地保持不变；opaque raw 仅归档，不声称通用检测任意原文中的秘密。optional provenance/model-lock.json / python-lock.txt 如提供则验证原字节；缺少文件而保留上游非空 hash 时，IR 必须有 upstream-model-lock-not-bundled / upstream-python-lock-not-bundled 明确记录，不伪造或下载锁文件。

当前 Node bundle 实现的本地目录与可信资产 IO 使用 Linux /proc/self/fd 固定祖先目录，其他平台明确拒绝；S2 本地 CLI / 服务处理因此以 Linux 为基线。ZIP 格式、抽象 FileSource 和浏览器阅读不受此平台限制。originalFilename 只作普通 basename，不能携带目录、控制字符或 . / ..；正文中的合法路径例子保持原样。

manifest、Reader IR、translation 的 source / parse / hash 必须一致；文件 hash 是实际字节 hash。packageId 同 owner 相同 canonical manifest / 文件内容幂等，不同内容 409 `BUNDLE_IDENTITY_CONFLICT`。不同 owner 的身份互不查询；重复导入旧包不能回退较新的 current reader。

| 限制 | 固定默认值 |
| --- | --- |
| 压缩 ZIP / 原 PDF | 各 256 MiB |
| 实际总解压量 / 文件数 | 1 GiB / 10,000（含 manifest） |
| manifest / 正式 IR / translation | 2 MiB / 各 32 MiB |
| provenance 单文件 / 其余单文件 | 128 MiB / 64 MiB |
| 规范文件路径 | ASCII、≤ 240 字节；无 `\`、`:`、`%`、控制字符、空段、`.`、`..`、设备名及大小写别名冲突 |
| IR 节点 / block / 树及 inline 深度 | 各最多 100,000 / 100,000 / 32 |
| JSON 结构嵌套深度 | 128，计入对象与数组，在 JSON.parse 前检查 |
| 单个 text / code / LaTeX | 512 KiB / 512 KiB / 16 KiB |
| 显示图片 | 单张 ≤ 40,000,000 像素、每边 ≤ 16,384；按真实签名和尺寸检查 |
| API 实例并发包处理 | 1；每 owner 最多 1 个 active import，其他请求明确返回 busy |
| 上传 / 验证期限、失活及孤立对象清理 | 15 分钟 / 5 分钟；15 分钟无心跳可失败回收；对象仍沿用 ≥24 小时延迟清理 |

`BundleLimits` 字段固定为 `maxArchiveBytes,maxPdfBytes,maxExpandedBytes,maxFiles,maxManifestBytes,maxIrBytes,maxTranslationBytes,maxProvenanceFileBytes,maxOtherFileBytes,maxPathBytes,maxNodes,maxBlocks,maxDepth,maxJsonDepth,maxTextBytes,maxCodeBytes,maxLatexBytes,maxImagePixels,maxImageDimension`。配置覆盖使用 `PAGELINGO_BUNDLE_LIMITS_JSON` 的 strict 部分对象，未提供项取上表默认；maxPdfBytes 直接取已有 `PAGELINGO_MAX_PDF_BYTES`，不允许第二处覆盖；所有值必须是正的 safe integer。readerContractCeilings 导出的文件数、路径、节点 / block、树 / JSON 深度、文本 / code / LaTeX 和图片尺寸 / 像素是 Reader v1 的绝对结构上限；运行配置只可收紧，超上限明确拒绝。未被合同另行封顶的 archive / expanded / manifest / IR / translation / provenance / other-file 字节预算可提高。结构深度上限检查在递归 schema 解析前执行。

依据：本地 LLM 317 页 v11 ZIP 为 22,748,628 B / 468 文件，解压 114,843,382 B，preview.json 45,902,548 B、source-layout 42,962,972 B；RL 154 页 v6 为 25,352,416 B / 233 文件、解压 38,632,389 B。大的原生字符证据留在 provenance，正式 IR 不复制整套 evidence。限制由 RuntimeConfig 校验读取，并通过认证的 `GET /api/v1/bundle-imports/limits` 返回；服务端实际生效值是 UI 上限依据。

ZIP 从私有暂存文件逐项读取，`lazyEntries:true, strictFileNames:true, validateEntrySizes:true`；拒绝加密、不支持压缩方法、symlink / 非普通文件、重复或前缀冲突、声明和实际超限、截断流及未列清单的内容。输入路径永远不直接作为宿主机写入路径；暂存 / 对象文件使用服务生成 UUID，独占创建、0600，目录 0700。

站内只显示验证过的 IR、译文和白名单图片。上传 HTML / CSS / JS / 字体不作为站内代码执行。完整离线产物必须匹配本版可信 renderer 的文件模板 / runtime / CSS / 字体目录摘要；数据分片按 schema 校验并比对重建结果，不能仅相信上传者自报代码 hash。所有阅读资源必须在包内，外部超链接仅是用户点击的来源链接，不允许自动网络依赖。

### 2.3 分片、离线与进度

- `buildReader(ir, translation): ReaderBuild` 产出 `ReaderIndex` 和 `ReaderChunk[]`；index 有章节 / block → chunk 索引、物理页范围、语言 / 完整性提示和资源逻辑 ID。按源页边界且最多 128 blocks / 256 KiB JSON 分片；超出阈值的单 block 独占片，仍受 512 KiB 限制。跨页 block 只出现一次，多来源保留；分片保存容器祖先以重开列表 / callout，不能破坏阅读顺序或丢失编号。
- `ReaderChunk {id,parseId,sourceSha256,blockIds,blocks,nodes,roots,assets}` 保存源与经 SDK 恢复的译文，id 为顺序 `c_000001` 起；`ReaderIndex {parseId,sourceSha256,chunks,toc,blockLocations,warnings}` 中 blockLocations 精确映射 block → chunk / 源页。`ReaderDescriptor {documentId,versionId,source,parseId,index,assetMap,translationStatus,parseCoverage,warnings,progress,restoreHint}` 由 API 生成，assetMap 将包内逻辑 assetId 映射为当前 owner / version 的服务器 asset UUID，不能由上传 manifest 指定。
- 站内与离线均使用同一 `renderChunk(chunk, {mode, resolveAsset}): RenderedChunk`，只输出由内部 escape / 白名单 / KaTeX 生成的品牌类型 TrustedReaderHtml。KaTeX 固定 `trust:false,maxExpand:1000,maxSize:20,throwOnError:true`，每次新建 macros；失败显示原 LaTeX 或原件区域，不跨公式共享用户定义。`createStaticFilePlan(build:ReaderBuild, metadata:OfflineMetadata): StaticFilePlan` 同时产出确定性的 HTML / 数据片和可信 runtime / CSS / 字体摘要；renderer 只描述文件，Node bundle 适配负责从锁定依赖读取可信资产，两个入口都不执行上传脚本。
- StaticFilePlan 使用按文件惰性迭代，不能先把全书渲染 HTML / 字体拼入一个 Buffer；生成 / 校验按实际字节累计预算。单片渲染 HTML 上限 4 MiB、16,000 元素，复杂公式超限时回退原 LaTeX / 原件并提示，避免小型 TeX 输入放大整个服务或页面的内存。
- 桌面默认 split，PDF 和正文各自滚动；分隔条支持指针和键盘，宽度限 30–70%。原文 / 正文单看可选；正文可选译文或结构化原文。窄于 768px 默认正文，切换 PDF。目录可折叠；正文字号默认 18 / 大字 20px、行高 1.9，正文宽度 ≤720px，沿用 S1 token。
- 正文最多保留当前片及相邻各一片（3 片）DOM 与响应数据；离开窗口卸载、取消请求、删除 query cache。不通过隐藏整个文档实现窗口。目录超过 200 项按展开章节渲染，最多同时显示 200 项。
- 离线入口 `render/index.html` 使用本地普通 script 加载 JSON 注册分片，不依赖 file:// fetch / module CORS；JSON 转义 `<`、`&` 和行分隔符，不使用 eval。PDF 通过包内原件的浏览器内建预览 / 下载打开，定位附带页码；译文、图片、CSS、KaTeX 字体及全部分片无 CDN。站内继续使用 PDF.js，不能把上传入口 iframe 到主站。
- 导入 API 合同同 Task 7：`CreateBundleImportRequest {targetDocumentId?:string}`，`BundleImport {id,status,epoch,documentId?,readerVersionId?,errorCode?,createdAt,updatedAt}`；status 固定 `created|receiving|validating|completed|failed|cancelled`。创建 / 接收是两个阶段，不能折叠为一个 uploading 状态。`ReaderVersionSummary {id,createdAt,sourceVersionId,parseId,translationStatus,parseCoverage,warnings}`；`ReaderVersionList {items,total,page,pageSize}`，分页默认 1 / 20、上限 100；作为 Task 8 的导出 DTO。
- `ReadingPosition {readerVersionId, sourceVersionId, parseId, blockId:null|string, blockOffset:0..1, pdfPageIndex, view:'split'|'source'|'content', contentMode:'source'|'translation'}`；offset 是块内垂直相对偏移。`ReadingProgress {position, revision, updatedAt}`；写入必须带 `expectedRevision`，使用文档级 CAS，初始 revision=0。
- 每个 reader version 保留独立历史位置，文档保存最后成功恢复位置。新版本按相同 parse / block 恢复；找不到时降级到物理页对应片，提示“版本已更新，已定位到原页”，保留旧记录。不以打开页面产生的程序滚动立即写入新进度。
- `GET /progress` 返回实际最后确认位置；`ReaderDescriptor.progress` 则是所选版本的有效恢复位置，配当前文档级 revision / ack updatedAt。优先该版本历史，否则只按相同 parse / 有效 block 映射，失效时 blockId=null、offset=0 并按物理页恢复。历史位置不能携带旧 revision 作为新的 CAS 确认；读取与恢复不写进度。
- 用户滚动 / 翻页后 1.5 秒 debounce 保存，持续阅读最多每 5 秒一次；离开时 best effort。409 `PROGRESS_CONFLICT` 不静默重试覆盖，提供继续当前位置的显式操作；401 清理会话与所有在途数据。版本 / 用户切换的旧请求不能更新新状态。

## 3. 任务

### Task 0: 修复基线中草稿保存与发送的竞争

执行基线时，既有 Chromium 对话历史测试出现单窗口“文章正在另一个窗口生成回答”的失败；独立重跑通过。原始 trace / 错误与分析保存在本计划 ledger，先用确定性回归验证自身草稿锁与发送请求竞争的假设，再修复。

**Files:** 修改 `apps/extension/src/assistant/controller.ts`，新增 `apps/extension/tests/unit/assistant-controller.test.ts` 中的对应行为测试，可复用 assistant-storage 单测的真实控制器 / 假 IndexedDB 设施；只有必要时调整既有 E2E 同步，不靠任意 sleep / retry 掩盖缺陷。

**Interfaces:** 保持 ReadingAssistant 的公开方法、跨窗口锁拒绝和取消行为；同窗口在先的 setDraft 持久化不得被 send 当成另一个窗口持锁，发送仍绑定调用时文章 / 问题。

- [x] **Step 1:** 用可控存储 / 锁 gate 复现 setDraft 尚未完成就 send，当前实现无模型请求且提示跨窗口冲突的失败。
- [x] **Step 2:** 验证确定性 RED，并追踪锁与 promise 的实际释放顺序；如假设不成立，先报告证据，不试探性修改。
- [x] **Step 3:** 在 ReadingAssistant 做最小同步修复，保留真实另一窗口持锁时拒绝发送、取消和文章切换语义。
- [x] **Step 4:** 运行 controller 对应单测、扩展 typecheck 与原历史 Chromium 用例；控制方随后重跑全部基线。
- [x] **Step 5:** 提交 `fix: wait for pending assistant drafts before sending`，独立审查后继续 Task 1。

### Task 1: 正式 Reader、译文与来源合同

**Files:** 新建 `packages/document-contracts/src/{reader,reader-source,reader-translation,bundle,reader-api,progress}.ts`，`schemas/{reader-ir,reader-translation,document-bundle}.schema.json`，`tests/reader-contracts.test.ts`，`fixtures/reader-v1/`；修改 `src/{documents,index}.ts`、package.json 与内部版本引用。

**Interfaces:** 输出上述类型 / Zod schemas（`readerIrSchema`、`readerTranslationSchema`、`documentBundleManifestSchema`、`readingPositionSchema`）；`validateReaderGraph(ir: ReaderIR): void` 检查树 / 绑定 / 资源 / 来源闭包，`validateReaderTranslationReferences(ir:ReaderIR, translation:ReaderTranslation):void` 检查版本、source / parse、文本块引用和完成状态的一致性，SDK marker 重放留给 Task 2。`DocumentSummary.processingStatus` 扩展为 `awaiting-local-processing|reader-ready`，另加 nullable `reader {versionId, translationStatus, parseCoverage, warnings}`，保留 S1 字段。Task 1 同步迁移 S1 repository 的无 Reader producer 和类型 fixture，返回 reader:null；实际 Reader 查询 / 状态在 Task 7 接通。API DTO 沿用 strictObject 和原错误 envelope。

- [x] **Step 1:** 写失败测试 `rejects_graph_aliases_and_binding_mismatches`、`retains_distinct_ids_for_repeated_text`、`requires_explicit_untranslated_results`，断言重复 ID / 环 / 未引用资产 / 假完成 / 不同 source 拒绝，中文 not-required 接受。为四旋转 fixture 写独立 golden：0°红框 `[40/360,260/420,120/360,360/420]`，90° `[60/420,40/360,160/420,120/360]`，180° `[240/360,60/420,320/360,160/420]`，270° `[260/420,240/360,360/420,320/360]`；页级引用不含 bbox。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-contracts -- --run tests/reader-contracts.test.ts`，确认新合同缺失导致失败。
- [x] **Step 3:** 实现 §2.1 的 strict schemas、图校验及可分发 JSON Schema；导出 fixture，包括重复段落、嵌套列表、提示框、跨页与无 bbox 来源。用 Ajv 2020 + formats 验证 Zod / JSON Schema 的 shape fixtures 结论一致；跨字段 / 图语义由公开 validateReaderGraph 补齐并单独测试，不声称 JSON Schema 能单独验证 hash / 外部资源 / 图闭包。
- [x] **Step 4:** 运行 contracts 全部测试与 typecheck；S1 DTO fixtures 按新增 nullable reader 迁移，保持原件入口行为。
- [x] **Step 5:** 提交 `feat: define versioned PDF reader contracts`。

### Task 2: SDK 投影、可信 renderer 与有界分片

**Files:** 新建 `packages/document-renderer/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts}`、`src/{index,translation,chunking,html,math,styles,static,static-catalog}.ts`、`static/offline-runtime.js`、`tests/{translation,renderer,chunking,static}.test.ts`；更新根构建脚本和锁文件。offline runtime 是单独的浏览器资产，纯数据入口不访问 DOM。

**Interfaces:** `toTranslationDocument(ir: ReaderIR, selectionBlockIds: string[], sourceLanguage?: string): TranslationDocument`；`validateReaderTranslation(ir, translation): ValidatedTranslation`（完成 hash 校验后调用，生成仅由 SDK decode 恢复的 inline）；`buildReader(ir, translation): ReaderBuild {index:ReaderIndex,chunks:ReaderChunk[]}`；`renderChunk(chunk:ReaderChunk, options:{mode:'source'|'translation',resolveAsset:(id:string)=>string}): RenderedChunk {html:TrustedReaderHtml,blockIds:string[],warnings:string[]}`；`createStaticFilePlan` 沿用 §2.3，返回 generated 文件内容与 trustedAssets 摘要，不读磁盘。不接收外来 HTML / style 字符串。

- [x] **Step 1:** 写失败测试：protected math / code、嵌套 link / emphasis 和术语经真实 SDK 输入 / 输出恢复后保持绑定；丢 marker、调包资产、未知 unit / 伪造 completed、错误 prompt/protection 版本拒绝。断言 `renderChunk` 对 `<script>` 文本 escape，危险链接 / `\\href` / `\\includegraphics` 不产生主动资源或脚本。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-renderer`，确认因缺少实现失败。
- [x] **Step 3:** 实现上述入口，buildReader 先完成 shape 与 validateReaderGraph 校验（含链接语义），使用 SDK `planUnits/validateStructure/decodeTranslation`；不调用内部 terminology 模块。分片按 §2.3 重开容器，列表续片保持编号，跨页块不重复；CSS 只由受限 presentation / bindings 生成，保留提示角色、强调、代码、图注和区域图标识。静态模板、注册分片脚本与摘要目录在本任务冻结并测确定性，为 Task 3 提供完整资源闭包，不等到 CLI 任务才定义。
- [x] **Step 4:** 增加 20,000-block fixture：`expect(build.chunks.every(c => c.blockIds.length <= 128)).toBe(true)`，阅读顺序展平后恰等于 IR leaf 顺序；单超大块独占片，丢资源和过深结构拒绝。用高放大 TeX 验证渲染预算与可读回退，用只消费前几项的 iterator 证明静态生成没有预构建全书 HTML。运行 workspace 测试、typecheck 与一次无 DOM Node import smoke。
- [x] **Step 5:** 提交 `feat: render trusted paged reader content`。

### Task 3: 安全 ZIP 与完整包验证

**Files:** 新建 `packages/document-bundle/` workspace，`src/{index,paths,limits,zip-reader,zip-writer,manifest,validate,resource-closure,static-assets}.ts`、`tests/{archive,bundle-validation}.test.ts`；修改根构建链。

**Interfaces:** `readArchive(path:string, limits:BundleLimits, signal?:AbortSignal): AsyncIterable<ArchiveEntry>`（内容只能消费一次）；`validateBundle(input:BundleFileSource, options:{limits,signal?}): Promise<ValidatedBundle>`；`writeBundle(input:BundleFileSource, destination:string, options:{limits,signal?}): Promise<BundleIdentity>`。`BundleFileSource` 提供 `list():Promise<FileInfo[]>` 和 `read(path):AsyncIterable<Uint8Array>`；ValidatedBundle 有 manifest、manifestSha256、ir、translation、readerBuild、已验证文件 metadata，无宿主目录 / owner。文件源适配不能绕过路径和实际字节上限。

- [x] **Step 1:** 构造失败 fixtures：`../`、反斜杠、绝对 / 盘符、NUL、大小写别名、重复项、文件 / 目录前缀冲突、symlink、加密、假 size、超量解压、坏 CRC / SHA、缺图、伪 PNG、错版本。断言拒绝且目标目录没有攻击者路径；超限流在越界时终止，不先缓冲完整内容。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/document-bundle`，确认失败。
- [x] **Step 3:** 实现 §2.2 的逐项消费、manifest / IR / 译文交叉验证、资源闭包及类型 / 图片尺寸检查；CRC 用 Node 24 的 node:zlib.crc32 增量核对，不能假设 ZIP 库会验证。根 PDF 复用 S1 header 识别并核对完整 hash / bytes，不在服务端运行 Python。验证已知 renderer 的模板 / runtime / 字体摘要和安全数据分片；文件 hash 不能替代类型校验。JSON 解析前限制文件字节与嵌套深度，语义验证使用有界遍历。
- [x] **Step 4:** 添加合法完整、中文、外语原文、部分译文往返测试；重压缩相同 manifest 身份不变，改变任何文件必须身份校验失败。运行 workspace 全部测试与 typecheck，确认内存使用随最大单文件 / IR 预算有界，不随整个 ZIP 体积累积。
- [x] **Step 5:** 提交 `feat: validate complete document bundles`。

### Task 4: P0 兼容适配与本地解析编排

**Files:** 新建 `apps/pdf-cli/` workspace，`src/{index,cli,local-run,process,python-runner,legacy-preview,legacy-tree,legacy-inline,legacy-assets,verified-input,source-map,language,provenance}.ts`、`tests/{process,legacy-preview,language,source-map}.test.ts`、`tests/fixtures/legacy-preview/`；需要 Python glue 时新增 `apps/pdf-cli/python/reader_inspection.py` 和 `tests/python/test_reader_inspection.py`，不改已发布产物。

**Interfaces:** `processPdf(options:{sourcePath,runDir,pythonPath?,p0RunDir?,previewDir?,katexDir?,modelDir?,pages?}, deps?:ProcessDependencies): Promise<LocalRun>`；`adaptLegacyPreview(input:{run:VerifiedP0Run,preview:VerifiedPreview,inspection:PdfInspection}): Promise<ReaderIR>`；`detectLanguage(text:string): LanguageDecision`。local-run.ts 定义本地类型，VerifiedP0Run / VerifiedPreview 对应现有通过 manifest 校验的版本，PdfInspection 对应 Python inspect 输出。LocalRun 的 config.json 保存工作流 UUID、输入 hash / 配置摘要与阶段路径；正式 IR 一次生成后只读。

- [x] **Step 1:** 从自有小 fixture 生成 legacy 结构，写失败测试：caption 与 image 分离、提示框 / 嵌套列表 / 原强调保留；KaTeX 的原始 `data-docvortex-latex` 只转一次 protected math，不把渲染后的双份 MathML / HTML 再当正文；重复文字稳定但不同 ID。原文 sample / partial 保持原状态，旧 preview 的 `translated:false` 不能变成完成译文。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/pdf-cli -- --run tests/legacy-preview.test.ts tests/process.test.ts`，确认失败。
- [x] **Step 3:** 实现输入 manifest / source hash 复验；通过 parse5 消费已投影的语义节点与原始绑定，绝不翻译 normalized.text 或复制旧 CSS。rawRef / layout repair 与来源证据可逐个追踪；未校准 / 冲突来源降为 page。剔除页眉页脚但保留真实标题、图注 / 脚注、列表编号、角色标签；不支持的可见结构明确 warning 并保留 source-only 或区域图。
- [x] **Step 4:** 实现 Python 调用：新解析运行 `<python> -m pagelingo_parser parse <source> --parser mineru --output <new-run>/parser --model-dir <models> --pages <selection>`；原 P0 run 可只读复用。没有 preview 时调用现有 `export-mineru-preview.py`，输出到全新目录；katexDir 必须是现有 prepare-preview-renderer.py 产生且含父目录 integrity.json 的 KaTeX 0.19.0 package，默认查找本仓库 data/pdf-p0/render-deps 下的已准备目录，缺失时输出显式准备命令，不自动下载。需要安装的 Python 环境 / 权重按现有 setup 单独准备，不在 npm install / 普通测试下载。子进程只收到必要的非敏感环境，Key 不随继承环境进入 parser；SIGINT 终止自有进程并保存失败 / 部分状态。CLI 返回非零时仍检验 run.json，合法 partial 不直接丢弃。
- [x] **Step 5:** 测试中文 / 英文 / mixed / 短文本与代码规则；测试原 run / preview 输入 hash 前后一致。provenance 仅复制实际产生的 raw / source-layout / 必要资产；运行元数据的路径字段改为包内相对路径，非规范文件名映射为规范名称，记录原 hash、字段 pointer、文件名映射和投影 hash。原字节不变的记录标 original，有路径投影的标 sanitized-copy，原输入始终只读。不修改正文中的 `/usr/bin/...` 示例，不收集 worker.log / env / credentials。未知运行路径字段拒绝完整导出并指出字段，不做全字符串替换。
- [x] **Step 6:** 运行 CLI 全部模拟子进程测试与 typecheck；额外通过已安装 Python 只读 inspect 四旋转 fixture，按独立 PDFium 红色像素范围验证变换。
- [x] **Step 7:** 提交 `feat: project local PDF runs into reader IR`。

### Task 5: 本地 SDK 翻译、检查点与恢复

**Files:** 新建 `apps/pdf-cli/src/{translate,file-checkpoints,file-cache,run-lock,safe-config,translation-types,translation-snapshot}.ts`、`tests/{translate,recovery,secrets}.test.ts`；扩展 CLI 子命令。

**Interfaces:** `translateRun(options:{runDir,selection:'auto'|'all'|'none',sourceLanguage?,provider:LocalProviderConfig,resume:boolean,newJob:boolean}, deps?:TranslationDependencies): Promise<LocalTranslationResult>`；文件适配实现 SDK `TranslationStateStore` / `TranslationCache`。默认目标 zh-CN、profile academic，预算 input=8192 / output=8192 / context=32768 / maxBatchBlocks=4 / reserve=512，SDK maxRetries=2，可显式配置。

- [x] **Step 1:** 写失败测试：中文 auto 的 mock `requests === 0`；mixed / und auto 保留原文并提示手工选择；英文包含短标题、中文引语、公式 / 术语 / 超长段落，短标题继承文档语言、中文引语不请求，其余经 SDK 分片后完成。模拟第二个请求中断，恢复只请求没有已验证结果的单元；429 cooldown 和已完成 block 来自 SDK，适配器不另做重试循环。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/pdf-cli -- --run tests/translate.test.ts tests/recovery.test.ts tests/secrets.test.ts`，确认失败。
- [x] **Step 3:** 使用 `TranslationEngine` + reliability 保存原始 checkpoint；SDK 每次状态迁移仍持久化，完整快照按首次成功 / 25% / 50% / 75% 与终态保存：首次完整执行最多 6 份，与批次数无关；resume 不重复旧进度里程碑，每次显式取消 / 恢复可另留一份不可变终态；本地互斥依赖 Linux `/usr/bin/flock`（util-linux），父进程持有 FileHandle、经共享 FD3 短命加锁后继续持锁，释放前等待受保护写入完成，不自动安装；同一 job 用 exclusive lock / epoch 防止双进程写入，失去 epoch 以 CheckpointConflictError 停止。本地 state 适配的持久化写失败也必须转换为可停止 SDK 的 CheckpointConflictError，保留最后成功检查点并给出稳定磁盘错误，不能降级为仅内存成功后导出完成。文件通过同目录临时文件 + fsync + rename 原子替换，0600；完整结果 / 原件不覆盖。配置 hash 变化要求显式 new-job；取消后的迟到 Provider 结果不能进入新快照。
- [x] **Step 4:** 安全配置仅允许显式键名，从 `--api-key-env`（默认 `PAGELINGO_LLM_API_KEY`）读取 Key，不能用 CLI 明文参数；沿用公共 SDK Provider 传输策略：远端 HTTPS，本机 localhost / 127.0.0.1 / [::1] 可 HTTP，拒绝 URL userinfo / query / fragment。导出只使用 allowlist 的 model、endpointFingerprint、预算、术语和用量；异常 / 日志使用稳定错误码，不输出请求 header、原始异常对象和 Key。CLI 保留已知静态 process 用法 / KaTeX 准备提示，未知异常使用稳定 fallback，translate 不回显任意异常消息。
- [x] **Step 5:** 用唯一假 Key 标记验证日志、checkpoint、cache metadata、source IR / translation snapshot 与子进程 env 不泄露；模拟完成缓存命中、坏缓存、磁盘写失败、重试耗尽 / 部分成功、取消和恢复，源文与已有成功块始终可读。运行 CLI 全部测试。
- [x] **Step 6:** 提交 `feat: translate PDF runs with durable checkpoints`。

### Task 6: 离线阅读包、CLI 入口与完整性自检

**Files:** 新建 `apps/pdf-cli/src/{bundle,offline-export,snapshot}.ts`、`tests/{bundle,offline}.test.ts`；使用 Task 2 的 static 模板 / runtime / CSS / font catalog；根脚本新增 `pdf:{process,translate,bundle,verify}`；新增 `docs/pdf-reader-workflow.md`、`.env.pdf.example`（只列非真实值）。

**Interfaces:** `exportBundle(options:{runDir,outputDir,archivePath}, deps?:ExportDependencies): Promise<BundleIdentity>`；输出目录和 ZIP 必须不存在，不能位于原 P0 run / preview 或本 run 中；对目录与归档同时解析真实祖先（含 symlink 与不存在的尾路径），按 P0 / preview 标记拒绝嵌套，并拒绝输出目录与归档相互重叠。每次导出新 packageId / translation 快照 ID，引用只读 source IR 和当前已验证检查点；`createStaticFilePlan(build:ReaderBuild, metadata:OfflineMetadata): StaticFilePlan` 是离线生成与导入复验的同一纯函数。

- [x] **Step 1:** 写失败测试：生成 Spec §10.3 的全部目录 / 必需文件；所有文件被 manifest 覆盖，source.pdf 与输入逐字节相同；部分包列出缺页 / 未译单元，中文包 not-required。现有目录 / 归档绝不覆盖；缺图、配置中的假 Key、运行绝对路径、外部字体依赖阻止完整导出。
- [x] **Step 2:** 运行 `npm run test --workspace @pagelingo/pdf-cli -- --run tests/bundle.test.ts tests/offline.test.ts`，确认失败。
- [x] **Step 3:** 实现 §2.2–2.3 的离线入口、注册式数据分片、可信资源目录、许可文件、源 / parse / translation / renderer 版本和 hash。归档内容只来自完整性验证后的文件源；完成前先运行 validateBundle 自检，再原子发布目标 ZIP，失败只留失败记录 / 调试目录。发布前复验选中不可变译文快照及输入 hash；已知运行路径的 provenance ledger 只保留原值 hash / 字段 pointer / 映射，不保留原绝对值。旧不合格 ledger 拒绝导出，正文路径示例保持原样。
- [x] **Step 4:** 文档给出四条可复制流程：`npm run pdf:process -- --source <pdf> --run-dir <new-run> --p0-run <existing-run> [--preview <existing-preview>]`；`npm run pdf:translate -- --run <run> --base-url <url> --model <model> --selection auto --resume`；`npm run pdf:bundle -- --run <run> --output <new-dir> --archive <new.zip>`；`npm run pdf:verify -- <zip>`。另外说明新解析所需 python / models / katex-dir 参数、现有 prepare-preview-renderer.py 的显式准备步骤、手工覆盖 mixed / und、断点恢复和无翻译导出，不自动读取站点 Key。
- [x] **Step 5:** 用 Playwright 从 `file://` 打开已解压包并阻断全部 HTTP(S)，跳转首 / 中 / 末片，确认正文、图、公式、字体和原 PDF 链接存在，网络依赖为 0；修改 runtime / 任意 data 片后重新伪造 manifest hash 仍因可信模板 / IR 不匹配被拒绝。
- [x] **Step 6:** 提交 `feat: export self-contained PDF reader bundles`。

### Task 7: 不可变 Reader 数据与导入发布服务

**Files:** 新增 `apps/document-service/migrations/005-reader-bundles.sql`、`src/bundle-imports/{repository,service,staging,publication,limits,lease,worker-client,validation-worker}.ts`、`tests/integration/bundle-imports.test.ts`；修改 documents repository、cleanup-staging 和 RuntimeConfig。

**Interfaces:** `createBundleImportsService({db,store,config})` 提供 `create(actor,input:{targetDocumentId?:string},idempotencyKey)`、`receive(actor,importId,body:AsyncIterable<Uint8Array>,signal?)`、`get(actor,id)`、`list(actor)`、`cancel(actor,id)`。输出 `BundleImport {id,status,epoch,documentId?,readerVersionId?,errorCode?,createdAt,updatedAt}`；status 为 `created|receiving|validating|completed|failed|cancelled`。owner / objectKey 不来自客户端；epoch 由服务内部领取，不交给客户端决定。

迁移的持久引用约定：parse_runs 的 id 是 ReaderIR.parse.id（text），保存 source_version_id / ir_asset_id / ir_sha256；translation_runs 的 id 是译文快照 UUID，保存 parse_id / translation_asset_id / sha256 / status；reader_versions 的 id 是服务生成 UUID，保存 source_version_id / parse_id / translation_id / package_id / manifest_sha256 / archive_asset_id / index_asset_id。reader_chunks 以 reader_version_id + chunk id 保存 data_asset_id，bundle_files 以 reader_version_id + path 映射原始文件 asset_id。每张表另含 owner_id / document_id 及必要时间；不得通过仅有 id 的 FK 绕过 owner。reading_state 保存文档级 revision 与最新位置，reading_positions 以 reader_version_id 保留历史。bundle_imports 保存请求摘要、target_document_id、状态 / epoch / heartbeat、成功 refs 或稳定 errorCode。

- [x] **Step 1:** 写失败 PG 测试：原件先上传后导入同条目、直接包创建条目；显式 target 必须属于当前 owner 且 source hash / bytes 相同；无 target 时只在本人范围复用同源 PDF。相同包幂等、相同 packageId 不同内容冲突、导入旧包不回退新 current，已有原件 / 成功版本在任何失败后保持可读。
- [x] **Step 2:** 运行 `npm run test:service:db -- tests/integration/bundle-imports.test.ts`，确认失败。
- [x] **Step 3:** migration 按上述持久引用约定建表，资产仍登记在 assets；documents.current_reader_version_id 的延迟 FK 同时包含 owner、document 和 current_source_version_id，确保两侧源身份一致。包身份唯一键为 owner + packageId，逻辑 parse / translation 身份相同但内容不同拒绝；active import 使用 owner 的部分唯一索引。不同 owner 的同源包不去重对象、不返回已有用户的信息。不改 001–004 已应用迁移。
- [x] **Step 4:** 导入状态短事务领取后，在事务外接收、逐项校验与写不可变对象；发布事务按用户 / 会话 → import → 文档 → object-publication lock 顺序，重查 actor、epoch / status、源身份、对象 stat 后插入 refs 和切换 current。并行首次同源导入 / 原件上传在同 owner 锁下去重。验证 / hash / 长上传不能占业务事务。纯验证与 SDK / renderer 的同步 CPU 工作在可终止的隔离 Node worker 中执行，父进程负责 auth / heartbeat / cancel / DB；worker 不接收用户 Key 或主密钥。超时 / 取消能终止 worker，不以事件循环恢复后才检查的 timer 代替硬截止。
- [x] **Step 5:** 加入 cancel / disable / password reset / stale lease / 重启测试：旧 epoch 不能提交；completed 后取消返回明确冲突；进程失去上传后仍可 GET 状态并重试新 ingestion。active claim 15 秒更新心跳，失活 15 分钟后标失败；对象清理沿用 (204716,2) 锁、查询 assets 全部引用，临时输入 UUID 文件按相同年龄 / 心跳规则清理，不触碰被引用对象。
- [x] **Step 6:** 故障注入对象写入后 DB 回滚、发布与清理器竞争、最后时刻对象消失、源冲突和断流，证明未发布任何半版本。运行全部服务 PG 测试与 typecheck。
- [x] **Step 7:** 提交 `feat: publish PDF bundles atomically per user`。

### Task 8: 认证的导入、分片、下载与进度 API

**Files:** 新建 `apps/document-service/src/bundle-imports/routes.ts`、`src/readers/{repository,service,routes,asset-response,progress,data,image-metadata-cache}.ts`、`tests/integration/{reader-routes,reader-progress}.test.ts`；修改 app.ts、documents DTO 与 source-response 中可共享的响应辅助函数。

**Interfaces:** 所有路径位于 `/api/v1`，读请求 requireSession，写请求同时 requireWriteRequest；资源与错误响应 no-store：

| 方法 / 路径 | 输入 → 输出 |
| --- | --- |
| GET `/bundle-imports/limits` | → BundleLimits |
| POST `/bundle-imports` | Idempotency-Key + `{targetDocumentId?}` → BundleImport |
| GET `/bundle-imports`、`/bundle-imports/:id` | 最近 20 条本人状态 / 单条 |
| PUT `/bundle-imports/:id/content` | application/zip 原始流 → 完成的 BundleImport；不缓冲整个请求 |
| POST `/bundle-imports/:id/cancel` | `{}` → BundleImport |
| GET `/documents/:id/reader` | 可选 versionId → ReaderDescriptor（含 index、源身份、译文 / coverage、最近进度和恢复提示） |
| GET `/documents/:id/reader-versions` | 分页 page / pageSize 默认 1 / 20、上限 100 → ReaderVersionList |
| GET `/documents/:id/readers/:versionId/chunks/:chunkId` | → 经 schema 校验的 ReaderChunk，非上传 HTML |
| GET / HEAD `/documents/:id/readers/:versionId/assets/:assetId` | 仅该版本引用的本人 PNG / JPEG / WebP，可 Range |
| GET / HEAD `/documents/:id/readers/:versionId/bundle` | 验证过的原始完整 ZIP，attachment，可 Range |
| GET `/documents/:id/progress` | → ReadingProgress 或 null |
| PUT `/documents/:id/progress` | `{expectedRevision,position}` → ReadingProgress |

- [x] **Step 1:** 写失败测试：两用户 / 管理员猜 id、Range / HEAD / ETag、伪 owner、跨文档 asset / chunk 引用、无 CSRF / Origin 拒绝；body 读前先认证。HTML / JS / provenance 不可通过显示资产 API 访问，bundle 下载不触发解析 / 翻译。
- [x] **Step 2:** 运行 `npm run test:service:db -- tests/integration/reader-routes.test.ts tests/integration/reader-progress.test.ts`，确认失败。
- [x] **Step 3:** 注册流式 ZIP content parser，按 Task 7 服务交互；完成行不接收覆盖性 PUT。输入无效 /超限 / 缺资源 / 错源 / 身份冲突分别稳定映射 `INVALID_BUNDLE|BUNDLE_TOO_LARGE|BUNDLE_MISSING_RESOURCE|SOURCE_MISMATCH|BUNDLE_IDENTITY_CONFLICT`，不泄露路径 / 内容。timeout / request abort 进入可查询状态；失败不清除旧 reader。
- [x] **Step 4:** 实现分页 Reader API、白名单资产 Content-Type / nosniff / Range 响应和 ZIP attachment；URL 不能选择包内路径 / objectKey。使用服务端生成的 id。进度验证 source / parse / reader 的同文档 FK、block 存在、pageIndex / offset 有界；同事务 CAS 增 revision 并保留版本历史。409 不修改任何已有行。
- [x] **Step 5:** 验证新版本缺 block → 页级恢复 / 保留旧位置、两个设备相同 revision 只有一个成功、旧版本迟到写不能覆盖最新记录、账号撤销前后 API 均正确。运行服务全部测试，空库和 S1 升级库均迁移成功。
- [x] **Step 6:** 提交 `feat: serve private PDF reader versions and progress`。

### Task 9: 阅读包导入 UI 与真实状态

**Files:** 新增 `apps/web/src/features/library/{bundle-import-dialog,import-status}.tsx`；修改 library-page、document-row、document-page、upload-dialog、shared/api-client；新增 `apps/web/tests/e2e/bundle-import.test.ts`。

**Interfaces:** `BundleImportDialog({targetDocument?:DocumentSummary,onImported:(result:BundleImport)=>void})` 用认证 limits 约束文件，稳定 Idempotency-Key 创建 ingestion，PUT ZIP、轮询 get、显式 cancel；API client 增加受现有 session generation 管理的二进制上传 helper，不开放任意 origin / header。

- [ ] **Step 1:** 写 Playwright 失败测试：资料库直接导入，原件详情导入后 id / 原件保持，重复包只一条；已完成状态只有服务器确认后显示；中文 / 原文包显示无需翻译 / 原文可读；partial 显示未完成文本与缺页 / 区域图限制，不显示假进度百分比。
- [ ] **Step 2:** 运行 `npm run test:site:e2e -- --grep 'bundle import'`（现有 runner 已转发 Playwright 参数），确认缺功能失败。
- [ ] **Step 3:** 实现实际入口、文件大小 / 生效限额、上传 / 校验 / 完成 / 取消 / 失败状态及重试；重复点击不能产生两个 active import，网络回应丢失先 GET 状态。取消显式调用服务再取消本地流；关闭弹窗后 active 状态仍能从最近导入恢复。错误给出可操作中文信息，不暴露对象路径和模型细节。
- [ ] **Step 4:** 测试错 hash、错目标 PDF、超限、断网、停用 / 切用户、取消期间迟到完成和重复文件名；已成功 reader 保持可读。认证失效沿用 session.clear，所有 queryKey 以 user.id 开头。运行该套浏览器测试、web typecheck。
- [ ] **Step 5:** 提交 `feat: import local reading bundles from the library`。

### Task 10: PDF / HTML 双屏与可信原页定位

**Files:** 新建 `apps/web/src/features/reader/{reader-page,reader-layout,reader-content,reader-toc,source-locator,source-highlight}.tsx`、`window-state.ts`；重构现有 `features/library/pdf-source.tsx` 的受控页码 / overlay 接口；修改 router / document-page、共享样式；新增 `apps/web/tests/e2e/pdf-reader.test.ts`。

**Interfaces:** `PdfSource({sourceUrl,title,pageIndex?,onPageChange?,highlight?:PdfSourceRef,pageMetadata?:PdfPageMetadata})`，兼容 S1 原件单看；`ReaderPage({documentId,versionId?})`；`ReaderContent({descriptor,mode,onLocate,onPositionChange})`。点击 block 的定位按钮展示多个来源选择；overlay 仅在 PDF.js 实际 page.view / rotate / viewport 与已验证元数据相容时绘制，失配明确降为页级。

- [ ] **Step 1:** 写失败浏览器测试：默认左右布局、独立滚动、拖拽 / 键盘调整分栏、折叠目录、单看 / 原文正文 / 译文切换；点击跨页段落可分别打开来源。四旋转 fixture 按 Task 1 golden 与真实 PDF.js canvas 红区比对，缩放后 overlay 偏差 ≤2 CSS px；页级和错误 metadata 没有 bbox 高亮。
- [ ] **Step 2:** 运行该套真实 API Playwright，确认失败。
- [ ] **Step 3:** 实现 §2.3 布局和窗口，正文只消费 renderer 的品牌 HTML；委托事件只识别本地 block ID，不能从 HTML 决定 API URL。PDF.js 保留真实 worker、认证 Range、本地 cmap / fonts / WASM 和资源清理；重渲染期间不展示上一页高亮。窗口与章节切换取消旧请求，销毁过期 DOM 和 query cache。
- [ ] **Step 4:** 用 20,000-block fixture 从首跳末再回中间，断言同时最多 3 个 chunk 元素 / 缓存响应、旧 block 已从 DOM 移除，顺序和列表编号正确。390px 手机默认正文、可切 PDF / 翻页 / 缩放，只有表格 / 代码局部横向滚动；light / dark 各保存 desktop / mobile 截图。
- [ ] **Step 5:** 运行 PDF 原件现有浏览器回归和新 Reader 测试、web typecheck。
- [ ] **Step 6:** 提交 `feat: read PDFs beside translated HTML`。

### Task 11: 阅读位置、版本恢复与并发反馈

**Files:** 新建 `apps/web/src/features/reader/{use-reading-progress,resolve-position}.ts`、`version-select.tsx`、`apps/web/tests/e2e/reader-progress.test.ts`；修改 ReaderPage / ReaderContent / library continuation UI。

**Interfaces:** `resolvePosition(index:ReaderIndex,saved:ReadingProgress|null): ResolvedPosition {chunkId,blockId,blockOffset,pdfPageIndex,fallbackReason?}`；`useReadingProgress({documentId,descriptor,onConflict})` 在用户产生实际交互后保存，按 §2.3 debounce / CAS。只消费 Task 8 DTO，不从 localStorage 决定跨账号 / 跨版本身份。

- [ ] **Step 1:** 写失败测试：在设备 A 定位段落内并退出，设备 B 相同账号恢复相同 reader / block / 偏移 / PDF 页；新 parse 无 block 时降级对应页、提示且旧记录可回看。仅读取和自动恢复零 PUT，中文 / 英文旧译文重开零模型请求。
- [ ] **Step 2:** 运行该套真实 API Playwright，确认失败。
- [ ] **Step 3:** 实现 version 选择、restore 与进度保存、source-only 模式保存 PDF 页；版本改变重建窗口。CAS 冲突保留服务器成功位置，用户可显式“从当前位置继续”取最新 revision 后发起新写入，不在后台自动重试；短时间快速滚动只保存最后一份有效位置。
- [ ] **Step 4:** 测试两 tab 逆序响应、旧页面关闭时迟到保存、退出 / 重置密码 / 切用户中断请求、缺片错误后的重试，均不复活旧状态或丢失已确认位置。运行 Reader 及 account-isolation 浏览器测试。
- [ ] **Step 5:** 提交 `feat: restore PDF reading progress across devices`。

### Task 12: 真实样本、离线、升级 / 重启与交付文档

**Files:** 新建 `scripts/check-pdf-reader.mjs`、`docs/learning-site-s2-validation.md`、`docs/superpowers/specs/assets/2026-10-27-s2-validation/`；修改 `scripts/{test-site,check-site-restart}.mjs`、`docs/{learning-site-install,pdf-reader-workflow}.md`、包 READMEs、Docker 构建清单和根 scripts；需要时新增专用 `.env.example` 参数。真实 PDF / 运行结果 / ZIP 写入新的 ignored 目录。

**Interfaces:** `npm run check:pdf-reader -- --corpus <corpus.json> --runs-root <runs> --output <new-output> [--mock-translation]` 使用明确输入并输出范围 / hash / 断言结果；无输入时清楚报缺失，不自动下载模型或读取真实 Key。`test-site.mjs` 保留现有 `--grep` 转发，继续拥有并清理自建 PG schema / 服务，不能停止用户原有进程。

- [ ] **Step 1:** 验收 BERT 和 Attention 全页包：原 PDF hash、IR / 译文 / 资源绑定、图注 / 公式 / 列表、跨页定位、部分失败恢复、同条目导入、完整下载再验证；模拟译文必须在产物和报告标注，不能计入语义质量结论。所有真实 API 调用使用单独命令和显式本地配置，此次默认不调用。
- [ ] **Step 2:** 对 LLM Foundations 317 页 / RL 154 页复用已有 P0 run 与最终预览做兼容投影；检查全部页覆盖、原图数量 / hash、提示框 / 角色 / 列表 / 符号图 / 原件保留区，首 / 中 / 末页和包含复杂结构的页保存截图。验证已知 upstream 缺陷仍明确 warning，不能因为适配成功删除局限。大文件 / 分片预算实测写入报告，超限时调整公开配置并补回归，不能静默删证据。
- [ ] **Step 3:** 从 file:// 断网打开论文及长书导出包；遍历全部分片验证图片 / 字体 / 公式资源，无 HTTP(S) 请求，PDF 原件完整可打开 / 下载。检查包中无假 Key、已知运行路径字段或外部 CDN 依赖。原 P0 run / 已发布 ZIP 的前后 manifest hash 一致。
- [ ] **Step 4:** 在 S1 数据库上应用 005，完成导入 / 进度保存后重建 API 容器；验证登录、原件、分片、译文、下载和进度仍在，未登录 / 另一账号均无法读。更新 Dockerfile 复制 / 构建新共享包，但服务镜像不安装 Python、解析模型或本地 CLI 环境。
- [ ] **Step 5:** 运行 `npm ci`、`npm run check`、`npm run check:site`、`npm run check:pdf-reader -- <明确的本地样本参数>` 和 `npm audit`；Python / P0 工具改动则追加 `npm run pdf:lint`、`npm run pdf:test` 及原布局验证。所有命令记录退出码、样本范围和未验项。视觉改动保存截图；默认测试没有真实付费请求。
- [ ] **Step 6:** 整分支审查覆盖 Review Focus 及 A07–A10 / A14，修正实质问题并针对修改复验。
- [ ] **Step 7:** 提交 `docs: document S2 reader workflow and validation`。合入 / 推送按照用户的后续集成选择执行，不自动删除宿主管理的 worktree。

## 4. 自检与执行交接

2026-10-27 已完成计划自检：A07 → 任务 4–10，A08 → 1 / 2 / 4 / 10 / 12，A09 → 1 / 4 / 10 / 12，A10 → 3 / 7–9，A14 → 3 / 6 / 12；进度 → 8 / 11，多用户与撤销 → 7–11，断点与 Key → 4–6，升级 / 重启及既有回归 → 12。S3–S5 的来源 / 管理 / 部署工作未混入本阶段。

自检修正了静态模板必须先于包校验、旧 exporter 依赖独立 integrity 文件、JSON Schema 只能覆盖 shape、短英文标题语言继承和进度 CAS 的接口边界。实现遇到协议不足，先修正本计划和合同 fixtures，再改调用方。

完成定义：论文和长书在已声明的解析能力内可导入 / 对照阅读 / 定位 / 恢复进度 / 离线阅读；失败与未译内容如实可见，两账号、撤销、围栏、资源与重启验证通过，原 SDK / 扩展回归保持通过。语义译文质量另附真实 API 验证范围；没有做的验证明确保留，不标记完成。

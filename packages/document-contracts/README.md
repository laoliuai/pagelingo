# 文档协议

`@pagelingo/document-contracts@0.3.0` 是可独立构建的 ESM workspace，提供学习网站 API 的 strict Zod schema 和 TypeScript DTO；未知字段会被拒绝。现有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。正式 PDF Reader 合同见下文；原 P0 产物与 Schema 保持原版本。

2026-10-12 增加 [PDF 来源布局补充 Schema](schemas/pdf-source-layout.schema.json)。P0 离线包中的 `source-layout.json` 实际通过该 Schema 校验，保存源运行、PDFium 字符索引区间、视觉行、阅读顺序、歧义、段落缩进和容器引用。字符区间使用半开区间，叶节点互斥拥有字符，容器只引用成员；PDFium 索引不是 PDF 内容流 glyph ID。它仍是 `experimental-supplement`，供检查和后续协议设计参考，不代替正式 Reader IR。

使用一份规范生成 / 校验 TypeScript 与 Python 数据模型；共同 fixtures 验证往返。翻译输入直接引用 `translation-core` 的公开语义模型，不在这里复制另一份。应用的存储路径、数据库句柄与密钥不进入公开协议。

来源布局补充当前为 `pagelingo-pdf-source-layout/2`。增加经原生文字和绘制路径确认的提示框、角色、占位变量与答题线，以及 prose 被误归为公式时的原生文字修复记录。每个提示框保留原解析类别 / 文字和字符来源；局部阅读顺序修复单独记录 before / after，原始 raw 的 block 索引不变。旧离线包保留其随包版本 1 Schema，版本 2 仍不是正式 Reader IR。

版本 2 的可选 `figureGroups` 保存共同图注下的行列图组、原成员和组合区域。合并模板的
逻辑片段仍引用原 parser block，并记录互斥字符范围；字体、下划线、彩色答题位与数学
字形回退也保留原生证据。它们用于可审阅的 P0 投影，不改变原始解析或正式 Reader 边界。

`prompts[].nativeCoverageRepair` 可记录单列标签框的 `blockRepairs`：原成员索引、原 /
导出 bbox、原文字与恢复字符区间。补充标签仍归属于原成员叶节点，不创建新的 parser
索引；局部顺序修复继续通过 `readingOrderRepair` 保存 before / after。

列表项的 `nativeMarkerRepair` 保存漏符号的原解析文字、原生圆点字符索引及位置。
`figureGroups` 的可选 `rowLengths` 表示不等长末行，`nativeSubcaptions` 保存纵向子图说明
的原生范围。密集公式脚注的合并原成员和分割线证据保存在预览包的原件保护记录，
渲染仍引用同一原 PDF，不将原件图中的正文误称为已完成文本识别或翻译。

具体边界见 [monorepo.md](../../docs/monorepo.md)。

## 学习网站 API

```ts
import {
  publicUserSchema,
  providerProfileUpdateSchema,
  documentSummarySchema,
  type ProviderProfile,
} from '@pagelingo/document-contracts';
```

- `auth`：公开用户、匿名 / 登录会话、登录、注销、修改密码与管理员账号写请求。用户名转小写；密码保留原文，以 Unicode 码点校验 12–128 的长度。会话 token 仅通过 Cookie 返回，不进入 DTO。
- `provider`：脱敏 profile、初始 `defaultProviderProfile`、显式 `keep` / `replace` / `delete` Key 更新和连接测试结果。`replace` 才能携带非空 Key；profile 读取不接受任何 Key 字段。枚举与预算类型复用 translation-core 公开入口。空地址 / 模型用于初始未配置状态；地址校验只负责 HTTPS 和 URL 结构，公有单播 DNS 与连接绑定由服务实现。
- `documents`：以 UUID、SHA-256、资产 ID 和字节数绑定原件的 `SourceIdentity`、包含 nullable reader 及原件 / Reader 状态的 PDF 摘要、分页列表与查询。分页从 1 开始，默认每页 20、最多 100，搜索最多 200 字符；服务按 createdAt / id 降序返回。
- `errors`：`{ error: { code, message, requestId } }`。API 前缀 `/api/v1`，版本响应头为 `X-PageLingo-API-Version: pagelingo-site-api/1`，成功响应直接返回相应 DTO。

运行 `npm run build:contracts` 会先构建所依赖的 SDK，再构建协议包，无需手动准备 SDK 产物；`npm run test --workspace @pagelingo/document-contracts` 运行协议测试。根 `typecheck` / `test` 会先构建 SDK 与 contracts。包内保留现有 P0 JSON Schema，不改变其内容或版本；这些文件与网站 DTO 不互相替代。

Actor、数据库对象、文件系统适配器及 Keyring 仅属于服务，不能从本包导出。公开输出 schema 拒绝 `ownerId` 等额外字段，实际授权必须由服务从会话 / 设备身份取得 owner。

## 正式 PDF Reader v1

- `readerIrSchema` / `ReaderIR`：`reader-ir/1`，树、SDK 原文 block、受限绑定、逻辑资产与 PDF 来源。text.value 直接复用 translation-core 的 TranslationBlock，不新增 inline 模型。
- `readerTranslationSchema` / `ReaderTranslation`：`reader-translation/1`，不可变快照 UUID、运行与 SDK 版本、语言覆盖、预算、术语、Provider 指纹、用量及逐块 / 逐单元结果。保存的是 SDK checkpoint 中的原始 protected text，不是恢复术语后的输出树。generationKind 区分 model、mock 和 none。
- `documentBundleManifestSchema` / `DocumentBundleManifest`：`pagelingo-document-bundle/1`，包身份、源 / parse / translation / renderer 身份与文件清单。
- `reader-api`：ReaderIndex、ReaderChunk、ReaderDescriptor、包导入 DTO；逻辑 assetId 到服务器 UUID 的映射由服务生成。阅读分片中的 translation 只能来自 SDK 校验 / 恢复后的 TranslationBlock。
- `readingPositionSchema`、`readingProgressSchema` 和 `readingProgressUpdateSchema`：版本、块内偏移、物理页与 CAS revision。写入必须显式带 expectedRevision。
- `defaultBundleLimits` / `bundleLimitsSchema` 定义协议默认容量。`bundleLimitsOverrideSchema` 是 strict 部分对象，拒绝 maxPdfBytes；该值只由已有 PAGELINGO_MAX_PDF_BYTES 设置。环境读取与实际字节预算由适配层负责。

调用顺序：先用 Zod 校验结构，再调用 `validateReaderGraph(ir)` 校验无环、无共享树、块的阅读顺序与唯一引用、inline / binding 一一对应、资产闭包、来源区域、页覆盖和版本化结构 / 文本上限；有译文时再调用 `validateReaderTranslationReferences(ir, translation)`。后者检查源 / parse 身份、文本选择顺序、显式结果、单元引用、分片连续性及完成状态；它不会重放 SDK 的 marker 校验，也不会计算实际文件 / IR / 术语 hash。SDK planUnits 的完整单元集合和 validateStructure / decodeTranslation 必须由 renderer 复验，bundle 层校验实际字节、规范 manifest、包文件闭包与可信离线模板。

正式 parse.coverage 为 full | partial；只有 parsedPageIndices 覆盖每个物理页且 parse.status 为 complete 时才是 full。已请求子集、缺页或 parser partial 结果都显示 partial。可供阅读的 parse.status 仅 complete | partial；全失败运行保留为本地错误 / provenance，不作为 Reader 发布。P0 的 full | sample 与原始 status 不改写。

PDF pageIndex 从 0 开始。bbox 已是旋转后有效 CropBox、左上原点的 0–1 坐标，渲染高亮时不能再旋转。`pdfToDisplay` 的六元仿射矩阵将原始 PDF 用户空间点变为旋转后有效 CropBox 的**显示点坐标**（scale=1，与 PDF.js viewport.transform 约定相同）；将点坐标分别除以 displayWidth / displayHeight 后才得到归一化坐标。CropBox 修复会要求 warning，并将来源降级为 page，避免虚构精确高亮。

[reader-ir](schemas/reader-ir.schema.json)、[reader-translation](schemas/reader-translation.schema.json) 与 [document-bundle](schemas/document-bundle.schema.json) 使用 JSON Schema 2020-12。它们只验证 shape，不能单独证明图闭包、跨字段语义、SDK marker、hash 或外部资源可信。`npm run schemas:generate:reader --workspace @pagelingo/document-contracts` 从 Zod shape 重新生成这些文件；只生成正式 Reader schema，不改 P0 文件。测试使用 Ajv 2020 + formats 与同一批正反 shape fixtures 对照。

[reader-v1 fixtures](fixtures/reader-v1/) 包含重复段落、嵌套有序 / 无序列表、prompt 提示框、protected math、跨页 / 页级来源、四种旋转与非零裁剪起点。fixture hash / 字节数是显式的 shape 占位值，不可作为真实完整包导入；实际字节校验属于 bundle 工作区。固定英文常用词表只为后续可重放语言判定提供版本化输入，本包不调用模型做语言检测。

`readerContractCeilings` 是单一、不可变的 v1 结构上限表（节点、块、树 / inline / JSON 深度、路径、文本 / code / LaTeX、图片及文件数）。运行配置只能收紧这些上限；bundleLimitsSchema / bundleLimitsOverrideSchema 拒绝更大的值。archive、expanded、manifest / IR / translation / provenance / other 文件字节预算可独立调大；maxPdfBytes 仍沿用 S1 配置来源。适配层需执行实际生效的更小预算，不能仅验证配置后忽略它。

包导入创建请求是 `{targetDocumentId?: string}`：`{}` 新建资料，提供 UUID 时向已有 PDF 导入。响应 `BundleImport` 包含必需的 `id,status,epoch,createdAt,updatedAt`，以及可选的 `documentId,readerVersionId,errorCode`；状态依次使用 `created | receiving | validating | completed | failed | cancelled`，创建与接收保持独立。`epoch` 是非负 safe integer 围栏值，不接受客户端 owner。`readerVersionSummarySchema` / `ReaderVersionSummary`、`readerVersionListSchema` / `ReaderVersionList` 和 `readerVersionListQuerySchema` / `ReaderVersionListQuery` 提供版本摘要与分页合同，查询默认第 1 页、每页 20，最多 100。

外部链接分两步验证：Zod 与分发 JSON Schema 使用同一个 portable pattern，仅允许小写 `http://` / `https://` 加非空 authority，或非空 `mailto:`，并拒绝空白、ASCII 控制字符和 DEL。这个 shape 不声称完整解析 IPv6 authority、主机编码或端口；例如 `https://[bad` 在两种 shape 校验中都属于待进一步检查的候选。`validateReaderGraph` 必须继续用 WHATWG URL parser 检查实际 URL 合法性，拒绝这些非法 authority / 端口，且不访问网络。合法 HTTP、HTTPS、mailto、IPv6 和国际化链接保留。只有通过 shape + graph 的 IR 可供 renderer / 导入器消费，不能将 shape 成功当作合法链接或可阅读 IR 的证明。


## Web Reader / capture v1

`webCaptureManifestSchema` / `WebCaptureManifest`（`web-capture/1`）描述限定范围的原件、资源与预览；`files` 的每项有 `id/path/bytes/sha256/mediaType/role`。`source.url` 保留 query / hash，`source.canonicalUrl` 只是候选身份。`scope` 的完整性、`WebSaveStatus` 与 `ReaderTranslationStatus` 分开。可用资源通过 `fileId` 引用文件，不可用资源必须记录 `reason`。Zod 除 shape 外校验 ID / 路径唯一性、文件闭包、预览资源预算与 scope 说明；真实字节摘要、DOM ID、图像解码与服务器投影仍由适配层校验。

`webReaderIrSchema` / `WebReaderIR`（`web-reader-ir/1`）复用 SDK `TranslationBlock`、已有 protected 语义和 Reader 容器，新增 `table/table-row/table-cell`；来源引用为 `{nodeId,quote,prefix,suffix}`，没有 PDF pages、Python provenance 或伪造 bbox。`SafeMathAst` 是有界的平面 SVG / MathML 节点树，限定标签、属性与本 fragment 引用。text block 的 `safeMath` 用 `bindingId` 对接已有 protected asset/literal binding 与 SDK literal inline；没有新增 SDK protected kind。独立 math block 使用互斥的 `latex` / `ast`。

`webTranslationSchema` / `WebTranslation`（`web-reader-translation/1`）沿用 PDF 的逐单元 / block 重放模型，并绑定实际 Web IR 字节 SHA。`WebReaderIndex/Chunk/Descriptor` 提供 chunk、TOC、`blockLocations`、快照预览与 assetMap；`WebReadingPosition` 的 view 为 content/snapshot，contentMode 支持 source/translation/bilingual，没有 pdfPageIndex。普通读取、授权与实际图闭包由后续适配器实现，本包仅导出纯数据与确定性校验。

`DocumentSummary` 是 `PdfDocumentSummary | WebDocumentSummary`。PDF v1 JSON shape 不变；Web source 可为 null，repository/paper 在 S3 只保存链接。消费 PDF 原件和 PDF Reader 的代码必须先按 kind 缩窄。

`devices`、`web-api`、`web-jobs`、`save-preferences` 与 `glossary` 定义配对 / 交换、捕获状态 / 上传文件状态、任务状态与修订写请求。设备范围只含 captures:write/captures:read/links:write/preferences:read。偏好 GET 允许 session 或 preferences:read device；PUT 仅 session。实际身份与 CSRF 检查属于服务，client owner 字段被 strict schema 拒绝。

`defaultCaptureLimits` 提供冻结的默认结构 / 文件 / 图片 / GIF / 公式 / chunk / preview / HTTP / outbox 预算，适配层必须执行有效预算并保留超限证据。`detectLanguage/blockLanguage/naturalText` 从 CLI 移到浏览器可用的纯模块；原 PDF 输出不变。`detectWebLanguage` 在原规则之外仅信任满足脚本阈值的明确页面语言提示，不调用模型。词典通过 `node packages/document-contracts/scripts/generate-language-words.mjs` 从冻结 fixture 生成，等价测试保护顺序和词内容。

Web JSON Schema 与 PDF schema 使用同一 `schemas:generate:reader` 命令生成。它们提供 portable shape；跨字段关系、真实 URL 解析、引用闭包、UTF-8 字节限制及 protected 语义仍需运行对应 Zod 校验和后续 Web graph validator。生成命令不修改原 P0、PDF v1 或已发布的 S2 文件。

手动翻译入口 `CreateWebJobRequest` 可显式携带 `sourceLanguage?: string` 和 `selectionBlockIds?: string[]`。语言采用 2–63 字符的保守 BCP47-like 结构，排除 und/mul/zxx；foreign 也排除 zh/en primary subtags。自动检测的语言范围保持不变。非空 selection 最多 20,000 个唯一 block ID，省略表示全篇；实际成员校验和按固定 IR 阅读顺序规范化由 job 服务执行。`WebJob` 必需的 nullable `sourceLanguage` / `selectionBlockIds` 保存已解析的不可变任务输入，服务必须将它们持久化并纳入输入 hash、重试、缓存和发布身份。und/mixed/短文本的显式人工选择检查也必须由持有 IR 的服务执行。

`WebCaptureTranslationCandidate` / `webCaptureTranslationCandidateSchema` 是插件导出与服务器导入共用的候选译文 JSON 文件（`web-capture-translation-candidate/1`）。`CaptureDraft.existingTranslation` 使用该 DTO；manifest 的 `existingTranslation` 继续描述最终文件 ID 与源绑定。payload 包含 `sourceSnapshotSha256/sourceContentFingerprint/sourceLanguage/targetLanguage/sdkVersion/promptVersion/protectionVersion` 和 `blocks[{nodeId,sourceTextSha256,source,rawText}]`。source 是原始 SDK TranslationBlock；sourceTextSha256 对 UTF-8 naturalText(source.content) 原样计算。rawText 是完整 block 的 SDK result.text，即术语已恢复且仍保留源 protected marker 的文本；必须能针对公共 encodeBlock(source) 运行 validateStructure/decodeTranslation。服务器比较原文投影与 protected 输入并校验摘要后才接受；未知 SDK/protection 格式或不匹配只跳过候选并给出警告，原件仍然保存。它不包含服务端 parse/IR SHA、译后 DOM HTML 或模型提供的格式树。

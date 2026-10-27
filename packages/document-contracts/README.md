# 文档协议

`@pagelingo/document-contracts@0.2.0` 是可独立构建的 ESM workspace，提供学习网站 API 的 strict Zod schema 和 TypeScript DTO；未知字段会被拒绝。现有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。正式 PDF Reader 合同见下文；原 P0 产物与 Schema 保持原版本。

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

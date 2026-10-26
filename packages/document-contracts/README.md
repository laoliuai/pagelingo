# 文档协议

`@pagelingo/document-contracts@0.1.0` 是可独立构建的 ESM workspace，提供学习网站 API 的 strict Zod schema 和 TypeScript DTO；未知字段会被拒绝。现有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。正式 Reader IR、PDF / LaTeX 来源联合类型和处理任务协议仍待后续阶段根据真实样本冻结。

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
- `documents`：以 UUID、SHA-256、资产 ID 和字节数绑定原件的 `SourceIdentity`、固定初始状态的 PDF 摘要、分页列表与查询。分页从 1 开始，默认每页 20、最多 100，搜索最多 200 字符；服务按 createdAt / id 降序返回。
- `errors`：`{ error: { code, message, requestId } }`。API 前缀 `/api/v1`，版本响应头为 `X-PageLingo-API-Version: pagelingo-site-api/1`，成功响应直接返回相应 DTO。

运行 `npm run build:sdk` 后可执行 `npm run build:contracts`；`npm run test --workspace @pagelingo/document-contracts` 运行协议测试。根 `typecheck` / `test` 会先构建 SDK 与 contracts。包内保留现有 P0 JSON Schema，不改变其内容或版本；这些文件与网站 DTO 不互相替代。

Actor、数据库对象、文件系统适配器及 Keyring 仅属于服务，不能从本包导出。公开输出 schema 拒绝 `ownerId` 等额外字段，实际授权必须由服务从会话 / 设备身份取得 owner。

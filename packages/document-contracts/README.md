# 文档协议

尚未注册为 npm workspace。已有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。P1 再根据真实样本冻结 Reader IR、PDF / LaTeX 来源联合类型、任务 / API schema，并接入 TypeScript。

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

# 文档协议

尚未注册为 npm workspace。已有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。P1 再根据真实样本冻结 Reader IR、PDF / LaTeX 来源联合类型、任务 / API schema，并接入 TypeScript。

2026-10-12 增加 [PDF 来源布局补充 Schema](schemas/pdf-source-layout.schema.json)。P0 离线包中的 `source-layout.json` 实际通过该 Schema 校验，保存源运行、PDFium 字符索引区间、视觉行、阅读顺序、歧义、段落缩进和容器引用。字符区间使用半开区间，叶节点互斥拥有字符，容器只引用成员；PDFium 索引不是 PDF 内容流 glyph ID。它仍是 `experimental-supplement`，供检查和后续协议设计参考，不代替正式 Reader IR。

使用一份规范生成 / 校验 TypeScript 与 Python 数据模型；共同 fixtures 验证往返。翻译输入直接引用 `translation-core` 的公开语义模型，不在这里复制另一份。应用的存储路径、数据库句柄与密钥不进入公开协议。

来源布局补充当前为 `pagelingo-pdf-source-layout/2`。增加经原生文字和绘制路径确认的提示框、角色、占位变量与答题线，以及 prose 被误归为公式时的原生文字修复记录。每个提示框保留原解析类别 / 文字和字符来源；局部阅读顺序修复单独记录 before / after，原始 raw 的 block 索引不变。旧离线包保留其随包版本 1 Schema，版本 2 仍不是正式 Reader IR。

具体边界见 [monorepo.md](../../docs/monorepo.md)。

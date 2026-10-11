# 文档协议

尚未注册为 npm workspace。已有 [P0 解析评测 JSON Schema](schemas/parser-evaluation.schema.json)，Python 评测入口实际校验此规范；它保留上游 payload、来源和资产用于比较候选，不等于正式 Reader IR。P1 再根据真实样本冻结 Reader IR、PDF / LaTeX 来源联合类型、任务 / API schema，并接入 TypeScript。

使用一份规范生成 / 校验 TypeScript 与 Python 数据模型；共同 fixtures 验证往返。翻译输入直接引用 `translation-core` 的公开语义模型，不在这里复制另一份。应用的存储路径、数据库句柄与密钥不进入公开协议。

具体边界见 [monorepo.md](../../docs/monorepo.md)。

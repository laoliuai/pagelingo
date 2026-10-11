# 文档阅读网站（规划）

尚未实现，也未注册为 npm workspace。按 [PDF 规格](../../docs/pdf-spec.md) 建立 React / TypeScript 网站，首版为单用户、可在本机或服务器部署的应用。

负责文档库、上传、任务进度、Reader 与右侧阅读助手；PDF 和未来 [LaTeX](../../docs/latex-spec.md) 共用网站。只消费版本化文档 / API 协议，不直接依赖 Python parser 或扩展内部代码。目录与依赖边界见 [monorepo.md](../../docs/monorepo.md)。

文档、译文、对话、术语与阅读位置以 document-service 的 PostgreSQL / ObjectStore 为持久化依据，浏览器缓存可丢弃。UI 通过稳定文档与资产 ID 访问 API，不保存服务器磁盘路径或 LLM Key；服务器部署与本机使用同一数据协议，原件 / 资产与聊天采用相同认证边界。

正式 Reader 与静态导出使用同一渲染策略，支持本机预生成、服务器展示和完整资源离线包；原文 / 译文 IR 继续保留。长书按章节组织，公式 / 图片 / 字体随包提供，阅读时不重新跑 parser 或翻译。当前已有独立原文预览实验，正式网站 / 快照尚未实现，见 [处理设计](../../docs/pdf-processing.md)。

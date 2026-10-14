# PageLingo

面向科技阅读的 monorepo，使用用户自己的 LLM API。当前提供浏览器翻译插件和文章阅读助手，后续 PDF / LaTeX 阅读网站复用翻译与助手 SDK。

当前插件 **0.4.4**，包含 M2（A / B / C）、M3 个人术语部分及阅读助手第一版。翻译 SDK 为 0.4.0，助手 SDK 为 0.2.0。支持真实网页翻译、预算与长段拆分、跨标签页并发、有限重试、IndexedDB 缓存和后台恢复，并保留译文局部颜色、背景高亮、下划线及 PDF 导出 HTML 的提示框变量和答题线。个人术语表支持文件导入、后写覆盖、搜索编辑与导出，见 [词表维护](docs/glossary.md)。

阅读助手支持原生侧栏、右键添加引用、连续对话、按文章保存历史、停止 / 重试及长对话摘要，底层使用 Pi Agent runtime。添加引用不请求模型，补充问题并发送后才开始对话。完整选区与问题合并为最后一条用户消息，文章背景另行提供；Enter 发送、Shift + Enter 换行。侧栏绑定打开它的标签页，切换到未打开助手的标签页会隐藏。默认复用已有 API 配置，无搜索或工具调用；使用方法见 [阅读助手指南](docs/assistant.md)。

助手实现和翻译回归的验证结果见 [阅读助手验收记录](docs/assistant-validation.md)。

可编辑的 [常见科技个人术语表](docs/glossaries/common-tech.en-zh.md) 包含 367 条编程、软件工程、机器学习、大模型和强化学习词条，同目录提供符合 SDK 词条格式的 JSON 与带语境说明的 CSV。

0.3.0 的导入、覆盖、术语保护和缓存验证见 [个人术语验收记录](docs/glossary-validation.md)。

扩展已迁入 `apps/extension`；`apps/web`、`apps/document-service` 目前只有规划说明，尚无网站或后端服务实现。

PDF P0 已完成两本书及三篇论文的首轮真实评测；Python 候选适配、来源映射与离线布局检查已实现，见 [实测报告](benchmarks/pdf/first-run-report.md)。正式质量 corpus / 选型仍待完成。首版按单用户、可部署服务器的应用设计：本机与服务器共用 PostgreSQL，原件 / 解析 IR / 图表采用独立对象存储接口，首版使用持久化磁盘目录。数据库迁移、任务恢复、后端对话、Compose 部署与备份恢复纳入交付计划，详见 [存储与部署设计](docs/pdf-spec.md#84-storage)；这些后端与部署能力仍未实现。

后续解析优先阅读效果，继续评测 standard / advanced；允许当前机器处理、服务器校验导入后阅读，保存 IR / 译文与完整静态 HTML 资源。现有 raw 已可导出[离线原文预览](benchmarks/pdf/tools/README.md)：每次加载一个 PDF 页，公式预排版，图 / 表主体保留原 PDF 高清区域图，避免长书整页负担及重建表格失真。正式 Reader / 翻译包 / 导入服务仍待实现，见 [处理与产物设计](docs/pdf-processing.md)。

## 本地运行

需要 Node.js 24 或以上。

```bash
npm ci
npm run build
# 构建并生成可解压安装的 ZIP
npm run package:extension
```

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
2. 开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择本项目的 `apps/extension/dist/` 目录（monorepo 迁移后根目录不再生成 `dist/`）。
4. 在扩展设置页填写 Base URL、API Key、Model，点击“授权并测试连接”。Base URL 是 API 根地址，例如 `https://api.deepseek.com/v1`，不包含 `/chat/completions`。
5. 打开普通 HTTP/HTTPS 文章，点击 PageLingo 图标，再点击“翻译当前页面”。切换原文、仅译文、中英对照；“恢复页面”移除译文并恢复原节点。

也可解压 `releases/pagelingo-0.4.4.zip`，选择含 `manifest.json` 的目录。浏览器不会读取 `.env.local`；完整安装步骤见 [安装指南](docs/install-m2.md)。

选中文字后，可使用右键菜单中的“PageLingo：翻译选中内容”。“预览页面布局”在当前网页正文下插入【布局预览】文本，不调用 API；选择中英对照并关闭面板即可查看。PDF、浏览器内部页面和 iframe 内容暂不支持。修改源码并重新构建后，需要在扩展管理页重新加载扩展，并刷新已注入脚本的网页。

X 帖子与长文按当前状态链接选择正文，忽略回复与互动计数，译文显示在原文下方。0.2.2 修复自动样式、追踪属性、通知标题和相同正文节点重建导致的误停止；节点重建后复用已完成译文并继续当前任务。正文文字、链接、代码、公式或段落顺序真的变化时自动停止，面板显示原因和“重新翻译”，无需先恢复页面；有效缓存继续复用。

X 页面保留原文节点，切换“仅译文”也会保留原文，以保护页面交互。加载完成前找不到正文时会提示重试；自动翻译滚动后加载的新帖子尚未实现。

开发构建可使用 `npm run dev`。最终验收使用生产构建 `npm run build`，开发热更新不替代重新加载扩展后的测试。

## 独立 SDK

`packages/translation-core` 是 npm workspace 包 `@pagelingo/translation-core`，提供 ESM JavaScript 和 TypeScript 声明。统一文档模型、保护标记、还原、Provider 请求、批处理与校验由 SDK 管理；网页只负责 DOM 解析、映射和渲染。

```bash
npm run example:sdk
npm run test:package
```

第一个命令用 Node.js 处理带公式、引用和强调结构的文档 JSON，第二个验证 SDK 能作为 tarball 独立安装、类型检查和运行。两者都不依赖浏览器或真实 API。PDF P0 独立入口见 [parser README](services/document-parser/README.md)，LaTeX 解析器尚未实现。

使用方法、Provider 契约及其他项目安装方式见 [SDK README](packages/translation-core/README.md)。开发 SDK 时可在另一个终端运行 `npm run dev:sdk` 持续编译；仅修改库源码不会自动更新已安装扩展，仍需重建和重新加载。

`packages/assistant-core` 是独立的 `@pagelingo/assistant-core`：纯数据文档、引用、上下文预算、历史摘要和 Pi 对话运行。网页内容适配和本地存储留在扩展，PDF / LaTeX 可提供自己的稳定文档 ID 与内容块。支持仓库外打包、类型检查和无 DOM 的 Node 运行，见 [助手 SDK README](packages/assistant-core/README.md)。

## 已实现

- TypeScript + Vite / CRXJS，Manifest V3，按需注入 content script。
- React popup 和 options；本地 API 配置、默认显示方式及领域化个人术语表。
- JSON / CSV / TSV 导入、批量粘贴、搜索编辑、JSON 导出；按原词＋领域后写覆盖。SDK 保护保留英文和固定译名，匹配词条更新只使相关缓存失效。
- 用户点击授权配置的 API 主机，后台连接测试；JSON Object / JSON Schema / 仅提示词 JSON 的显式兼容配置。
- 本地设置仅可信扩展上下文可读，Key 默认遮罩，不使用云同步。
- 正文识别、嵌套块去重、代码/公式保护、可翻译的强调和链接文本、成对格式校验。
- 后台真实 LLM 分批翻译、结构校验、进度、停止、三种模式及完整原文恢复；可单独进行 Mock 布局预览。
- 网页和 Node 共用 SDK；段落、章节路径、行内格式与不可变对象的统一模型，独立打包验证。
- 选中文字浮层，复制、关闭和 Escape 操作。
- 重复注入保护，SPA 路由切换和宿主内容变化后丢弃旧任务。
- 输入 / 输出 / 上下文预算、保护槽位完整的长段拆分、首段优先；每 endpoint 跨标签页最多两个请求。
- 首次加最多两次重试，网络和校验共用预算；部分成功单独保留，429 等待 Retry-After，批量截断缩小批次。
- 块级 / 文档缓存、持久化检查点、worker 重连和幂等回填；Key 不进入缓存或检查点。
- 可选 SSE；首响应 / 空闲读取 25 秒、总时限 120 秒；请求、用量、缓存和失败状态展示。
- 默认 64 MiB 译文缓存预算、30 天 TTL 与 LRU；配额失败临时降级，独立清理译文 / 文档 / 全部缓存。
- 原生侧栏阅读助手、文字 / 代码引用、Markdown 对话、原文定位；按 URL 保存历史、草稿和摘要，默认 50 篇 / 64 MiB，可导出和清理。
- 助手全文 / 片段 / 仅引用上下文、独立对话参数、流式与兼容响应、停止 / 重试、中断恢复和多窗口并发保护。

公式、内嵌控件及其他复杂段落保留原文；译文中的公式位置显示“〔公式见原文〕”。原公式不移动、不复制。译文链接保证普通导航，原链接事件保留在原节点上。

空链接、零宽标题锚点及只含图标的格式节点不送入模型，保留在原 DOM；相关段落采用保留原文的显示方式。后台会话按标签页发放一次性授权，正文通过 Port 传输，Key 不进入页面脚本；关闭 popup 后翻译继续，停止 / 页面变化会断开会话并取消请求。

## 验证

```bash
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

也可使用 `npm run check` 执行 SDK / DOM 单元测试、独立包消费验证、类型检查、构建与浏览器测试。SDK 单元测试运行在无 DOM 的 Node 环境，网页结构测试使用 jsdom。

`apps/extension/tests/fixtures/` 是人工编写的 arXiv 风格、GitHub README 风格、文档页和 X 帖子/长文样本，包含列表、表格、代码、MathML、链接事件、编辑区域及 SPA 变化测试。它们验证确定性的结构行为，不代表已经覆盖真实站点所有页面。

默认检查使用本地模拟 API，不读取 `.env.local`，不调用付费模型。真实联调需要主动运行：

```bash
# 从 .env.example 复制本地配置到 .env.local；这些变量不注入 Vite 构建。
npm run test:llm
npm run test:llm:assistant
npm run test:llm:extension
# 可指定另一篇技术文章
npm run test:llm:extension -- https://your-technical-article.example/
```

`test:llm` 翻译三段固定文本并检查代码、公式和链接；`test:llm:assistant` 测试 `kubernetes` 和 `Reinforcement learning` 两个选区，后者使用含用户反馈引言的 100 段合成文章及先前整段解释历史，检查真实模型回答所选概念而非翻译整段；`test:llm:extension` 默认翻译 DeepSeek 的 JSON Output 文档，检查真实页面提取、API 回填、显示切换及原文恢复。它们读取本地连接信息，会发送真实请求。扩展安装包不读取 `.env.local`；日常浏览器使用仍需在扩展设置页配置。真实浏览器测试使用临时配置，不修改已有浏览器。

本次验收记录与限制见 [M2 验证记录](docs/m2-validation.md)；历史记录保留在 [M2-A](docs/m2a-validation.md)。

浏览器测试将生产 `apps/extension/dist/` 复制到临时目录，仅给测试副本增加 `http://127.0.0.1/*` 权限，用于访问本地样本；生产 manifest 不变。真实 Chrome / Edge 的用户点击与 `activeTab` 授权仍需要本地安装后手动验收。截图及失败追踪位于 `apps/extension/test-results/`。

Popup 的 React 操作通过同一个生产入口在非激活的扩展标签页中测试；无头浏览器不将原生工具栏气泡暴露为可操作的 Page。Linux 环境做中文截图检查时需安装可用的 CJK 字体，扩展自身不请求远程字体。

## 工程边界

```text
apps/extension/              扩展源码、配置及 DOM / Chromium 测试
packages/translation-core/   独立 SDK 及无 DOM 的 Node 测试
packages/assistant-core/     通用阅读助手 SDK、上下文与 Pi runtime
tests/package/              SDK 独立打包、类型检查与消费验证
examples/                   Node 文档 JSON 示例
apps/web/                   规划：PDF / LaTeX 阅读网站
apps/document-service/      规划：TypeScript 文档 API / worker，直接调用 SDK
services/document-parser/   P0 已实现：解析适配、来源映射、离线检查；语义重建待实现
packages/document-contracts/ P0 评测 schema；正式 Reader IR、来源与任务协议待冻结
benchmarks/pdf/             P0 输入 / 模型锁、真实运行与质量评测
evals/                      规划：共享翻译质量评测
```

只有页面侧保存 HTMLElement / Node；SDK 接口只传纯文档数据。UI 不控制宿主网页的 React 树，模型文本不作为 HTML 执行。SDK 不依赖 React、chrome 或文件系统；API 配置、密钥及权限由可信扩展上下文持有，翻译在后台执行，助手在可信侧栏执行。关闭侧栏会中断助手生成，关闭 popup 不影响后台翻译。

根目录负责 npm workspaces 和命令调度，各应用声明自己的依赖。`npm run dev` / `npm run build` 默认仍处理插件；`npm run test:sdk`、`npm run test:extension` 可分别验证单个包。`pdf:setup`、`pdf:cli`、`pdf:lint`、`pdf:test` 显式管理 Python 评测；默认 npm 安装 / 检查不安装 Python、模型或 TeX，不下载论文。

## 后续里程碑

- **M2-A 已交付：真实 API 闭环。** 服务授权、连接测试、显式兼容配置、后台 SDK、25 秒请求超时与取消、真实文档页联调。
- **M2-B 已交付：预算、并发、重试和缓存。**
- **M2-C 已交付：持久化任务、后台恢复、自动化验收和安装包。** Chrome / Edge 原生界面待用户安装后人工测试。
- **M3 个人术语部分已交付。** 批量维护、领域选择、最长词组匹配、术语保护与相关缓存依赖。内置词表自动加载、文档分析、动态术语及人工质量评测继续推进。

M2 / M3 的通用翻译策略在 SDK 内实现；权限、后台任务和存储适配留在扩展。其他应用升级相同 SDK 版本后共享改进。

当前推进 PDF P0，正式质量 corpus / 选型完成后建设可部署服务器的网站；共享的文档分析 / 动态术语随 PDF 接入补充，SDK 变化继续回归插件。LaTeX 后续复用同一网站、翻译 / 助手与后端存储。

- [网页插件规格](docs/web-spec.md)（原 `docs/spec.md`，已重命名）
- [PDF 网站规格](docs/pdf-spec.md)
- [LaTeX 草案](docs/latex-spec.md)
- [Monorepo 架构与命令](docs/monorepo.md)
- [规格审阅与修订记录](docs/spec-review.md)

浏览器插件 V1 完成需要 M1–M3 均达到验收要求。M2 已完成，M3 的自动上下文分析、内置 / 动态术语与人工翻译质量评测仍需推进；文档网站尚未实现。

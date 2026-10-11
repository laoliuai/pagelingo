# PageLingo 浏览器插件（网页翻译）V1 实现规格

本文是当前实现依据。最初的需求草案保存在 [spec-initial.md](archive/spec-initial.md)，其中与本文冲突的实现建议以本文为准。已完成内容及运行方法见 [README](../README.md)。

文件由 `spec.md` 重命名为 `web-spec.md`；这里的 web 指插件处理的网页，不是后续 PDF / LaTeX 网站。当前优先开发本规格的 M2 / M3；[PDF](pdf-spec.md) 与 [LaTeX](latex-spec.md) 排在后续阶段，仓库边界见 [monorepo.md](monorepo.md)。

浏览器代码、配置与自身测试位于 `apps/extension`；共享引擎位于 `packages/translation-core`。从根目录运行 `npm run build`，加载 `apps/extension/dist/`。

当前实现到 M2（A / B / C）及 M3 个人术语部分，插件 / SDK 版本 0.3.0：真实翻译、预算 / 并发 / 有限重试 / IndexedDB 缓存 / 后台恢复均已接入。自动化验收与限制见 [M2 记录](m2-validation.md)。Chrome / Edge 原生安装人工验收由用户补充；个人词条维护、实际术语保护及缓存依赖已接入；自动上下文分析、内置 / 动态词表及人工质量评测继续推进。

## 1. 产品目标与范围

为工程师和研究人员提供基于用户自有 LLM API 的科技网页翻译层。优先保证技术含义、术语一致性、原文可恢复，以及再次阅读时的缓存复用。

V1 支持 Chrome / Edge Manifest V3，优先验收 arXiv HTML、GitHub README，以及常见文档文章页。自用，本地加载，不要求商店发布。

V1 最终功能：

- 翻译当前已加载的正文，以及用户选中的文本。
- 原文、中文、中英对照三种显示方式；双语默认原文在上、译文在下。
- 保护代码、公式、链接地址和技术标识符。
- 基础科技术语表、个人术语表、文档上下文及动态术语表。
- 块级缓存、文档 metadata 缓存、校验、有限重试、渐进显示和停止。
- OpenAI-compatible Chat Completions API；设置、密钥及缓存仅存于本地浏览器。

不在 V1 内：PDF、OCR、LaTeX 下载与重编译、登录与云同步、阅读库、计费、多 Provider 原生 SDK、无限滚动自动翻译、跨源 iframe、封闭 Shadow DOM、完整复刻动态控件。

“尽量保持布局”表示页面层级、表格列、列表、锚点及原有交互仍可使用；译文增加高度造成的重排是允许的。复杂内容可以明确降级为双语或保留原文。

## 2. 技术栈决定

| 部分 | 选择 |
| --- | --- |
| 语言与扩展规范 | TypeScript strict、Manifest V3 |
| 共享翻译核心 | npm workspaces；独立 @pagelingo/translation-core ESM 包和类型声明，浏览器 / Node 共用 |
| 构建 | Vite + CRXJS；扩展入口使用不同文件名，真实浏览器测试检查构建产物 |
| Popup / Options | React；不让 React 管理宿主网页正文 |
| 内容提取与渲染 | 原生 DOM、MutationObserver |
| 本地设置 | chrome.storage.local，限制为 TRUSTED_CONTEXTS |
| 临时任务状态 | chrome.storage.session；需要跨浏览器重启恢复的部分进入 IndexedDB |
| 翻译与文档缓存 | 扩展 origin 下的 IndexedDB，使用 idb 包装（M2） |
| API 传输 | 后台 fetch + SDK Provider.generate 接口（M2）；翻译提示词和校验归 SDK |
| 运行时数据校验 | Zod |
| 测试 | Vitest + jsdom；Playwright Chromium 持久化上下文 |

Node.js 24 或以上。实际依赖版本固定在 package.json / package-lock.json。idb 随 M2 缓存实现安装，不预先添加无实现的依赖。

## 3. 执行边界

```text
Popup / Options（React，可信扩展页面）
          ↕ 经过校验的命令
Service Worker（权限、配置、API、调度、扩展缓存）
          ↕ 仅可序列化 DTO
Content Script（正文快照、DOM 映射、渲染、页面会话）
          ↕
宿主网页 DOM
```

翻译核心仅依赖纯数据，包括 sourceText、protectedText、结构槽位、领域及章节上下文。不能依赖 HTMLElement、Node、window 或 chrome。

M1.5 起，通用实现位于 `packages/translation-core`。扩展通过包的公开入口消费构建产物；不从扩展源码复制翻译逻辑到其他应用。SDK 的统一文档模型包含文档标题、源语言、有序内容块、章节路径、可翻译文本、格式结构与不可变对象。格式适配器保留位置和节点映射，SDK 输出可重新映射的结构化译文。

DOM 引用独立保存在 content script 的 ProtectedBlock 中。跨进程消息、缓存及 Provider 输入不携带 DOM、事件处理器或 API Key。

MockProvider 在页面侧执行纯文本预览；M2-A 的真实 SDK 引擎与 Provider 位于后台。用户命令发放一次性标签页会话，内容脚本通过 Port 传入纯文档并接收校验结果；消费一个批次后才继续下一批。页面侧不获取 Key，也不指定网络请求地址。

Provider 仅负责将 SDK 的 instructions、data、responseSchema 转换为模型 API 请求并返回已解析 JSON，不独立维护提示词或校验逻辑。文档内容与指令分离；MockProvider 使用同一请求和结果契约，放在 SDK 的 testing 子入口。

Popup 关闭不应取消页面任务。页面重新加载、正文版本变化、SPA 路由切换会使旧任务失效。每个文档会话包含 pageSessionId；每次执行另有任务版本或 jobId。结果写回前检查会话、任务版本和原块内容。

## 4. 提取与块所有权

优先定位正文根：站点适配器、article / main / role=main，最后回退到 body。当前适配起点包含 .ltx_document 和 .markdown-body。

基本块元素：p、li、blockquote、figcaption、td、th、h1–h6、dt、dd。每个文本片段只归属一个块。

嵌套块不重复提取。例如 li 包含 p 或嵌套 ul 时，内层段落独立成块；父 li 在嵌套列表之前和之后的直接文本仍要保留。允许同一个 DOM 元素对应多个连续文本 run。

跳过脚本、样式、模板、表单、按钮、可编辑区域、导航、侧栏、页脚、媒体、iframe、隐藏元素、translate=no、.notranslate、纯数字、纯 URL 和独立代码/公式。位于屏幕之外的正文仍属于全文，不按 viewport 可见性过滤。

提取分片让出主线程。超大页面给出可理解的提示，不让同步遍历阻塞 UI。

站点适配器只决定正文根、排除区域和必要的渲染策略，不散落在翻译核心。

## 5. 保护、格式及序列化

保护分为两种：

1. 不可变槽位：代码、公式、URL、标识符及原文本身碰巧包含的保留标记。
2. 成对格式标记：strong、em、b、i、sub、sup、small、mark、链接等；标记内部的自然语言仍参与翻译。

当前编码：⟦A0⟧ 为不可变槽位，⟦S1⟧ / ⟦E1⟧ 为格式开始/结束。槽位在块内编号；将来用于缓存的编码必须确定性生成，不含会话 ID。术语保护不得抹掉模型理解语境所需的信息。

SDK 负责跨格式编码与结构还原。行内对象 ID 在块内唯一；块 ID 在文档内唯一。公式、代码和引用的原始值作为数据保留，用于上下文与本地还原；DOM、PDF 坐标和 LaTeX AST 引用不能进入 SDK。格式内自然语言保持可翻译，输出适配器负责 HTML 文本构造或 LaTeX 特殊字符转义。

Provider 输出只允许 JSON 包含文本和原槽位标记。禁止让模型生成可执行 HTML。恢复使用 textContent、createTextNode 及允许的本地 DOM 构造；不使用模型输出设置 innerHTML。

验证至少包括：

- 输出 schema、块 ID 唯一性、完整性、无未知 ID、译文非空。
- 每个槽位恰好出现一次；无缺失、重复及未知槽位。
- 格式标记正确配对及嵌套；允许完整格式子树的合理重排。
- 根据生效领域术语检查保留词和固定译法。

结构错误必须阻止渲染及成功缓存写入。术语错误与软警告分开。

## 6. 渲染与恢复契约

不删除或替换原节点，不通过 innerHTML 重建正文。允许在已验收的普通文本 run 外添加可逆 span 容器，并保留原节点身份及事件监听器。

译文插在同一有效父容器内；不得在 tr 下插入普通 div，也不得在 ul / ol 下直接插入译文容器。标题保留原 heading 和锚点，不额外创建 heading。原文及译文继承页面颜色和字体，适配 dark mode。

普通 run：原文容器 + 译文容器。原文容器默认 display:contents，在中文模式才隐藏。

复杂 run：不移动原节点；追加译文并保留原文。当前对公式、图片、内嵌控件、自定义元素及已识别的复杂链接使用该降级。公式由原页面继续管理，译文的公式槽位显示“〔公式见原文〕”。不要克隆 MathJax/KaTeX 的交互 DOM、重复 ID 或触发二次排版。

译文链接仅复制经过验证的普通 http / https / mailto 导航属性。原链接及原事件始终保留，但不承诺复制任意 JS 监听器到译文链接。危险 URL 不复制到译文。

三种显示方式不重新生成内容。中文模式仅隐藏已成功渲染且允许隐藏的原文；失败或复杂块保留原文。模式切换尽量保持当前阅读块的位置。

“恢复页面”移除译文和扩展容器，将原节点放回；恢复过程中保留宿主网页新增/修改的内容，不能用旧 HTML 快照覆盖网页。未被宿主修改的固定样本必须恢复到完全相同的 DOM 序列化内容。

## 7. 动态页面与任务失效

MutationObserver 忽略扩展自身渲染，检查原块是否被替换或修改。M1 发现源内容变化时撤销旧预览并提示重新操作。新添加正文在用户再次触发时提取；不自动产生 API 请求。

不得假设 content script 覆写 history.pushState 就能监听网页的主世界。M1 使用文档生命周期内每 500ms 检查 URL 的方式；普通 #heading 锚点变化不重置文章，#/path 与 #!/path 视作路由。

响应写回时再检查导航 key 和内容快照，不只依赖定时器。每个文档只注入一个控制器；重复打开 popup 不应添加多个监听器或重复渲染。

## 8. 文档上下文和术语（M3）

文档缓存未命中时分析 title、h1、章节标题、可识别摘要及有限正文样本。分析设输入预算及超时，失败可以用基础术语表继续翻译，UI 显示降级状态。

一次翻译固定上下文及 glossary 快照。动态术语上限建议 50–100 条，不把模型自报 confidence 当作校准后的正确率。采样分析不能宣称理解全文。

合并优先级：用户适用领域词条 > 文档动态词条 > 内置适用领域词条 > 模型自行判断。

词条包含 source、target、policy、domain。匹配处理大小写、词边界和最长词优先。领域至少区分 machine-learning、software-engineering、physics、general-technical；可显式选择 all。

0.3.0 个人词表导入 / 编辑规则：键为原词去首尾空格、转小写后的值＋领域。同键按最后写入覆盖，文件内部重复也取最后一条；未在导入中出现的已有词条保留。设置页提供 JSON / CSV / TSV 导入、批量粘贴、预览确认、搜索编辑和 JSON 导出。确认合并并保存后用于下一次翻译；当前手动选择生效领域，所选领域＋all 生效，同词优先选择所选领域。细节见 [词表维护](glossary.md)。

策略：keep、translate、prefer-source、first-bilingual。V1 的 first-bilingual 统一显示“中文（英文/缩写）”，不依赖并发完成顺序判断首次出现。

基础词表先维护约 100–300 个经过审核的高频词，根据实际阅读内容扩充。Transformer 在 ML 中保留英文；物理语境中的 transformer 不采用 ML 黑名单。token、agent 等也不得全局硬编码单一译法。

## 9. Provider、批处理和错误（M2）

V1 使用 OpenAI-compatible /chat/completions；约定 Base URL 是 API 根（例如 https://api.example.com/v1），拼接时不得重复添加 /v1。

能力配置区分 structured JSON schema、JSON mode、普通文本 JSON、temperature 参数支持、stream 支持及输出 token 参数。支持时使用结构化输出；所有模式都执行本地 schema 和结构校验。

连接测试由用户主动触发，发送最小必要请求并验证所选模型实际可用；只列出模型不算测试翻译能力。

按 input + output token 预算组 batch，块数作为次级上限；长块按句子或段落拆分，尽量使用 Intl.Segmenter，保护槽位完整。首段优先，默认每 Provider 全局最多两个并发，跨标签页共享限制。

分别处理 401/403、429、网络失败、超时、取消、无效 JSON、schema 错误、输出截断及翻译结构错误。429 尊重 Retry-After 并带随机抖动；截断尝试缩小 batch；可独立确认成功的块不随坏块重试。

“最多 2 次重试”明确为首次请求 + 最多 2 次额外尝试；网络与校验重试共享总预算，防止多层重试放大费用。鉴权错误直接提示配置；失败块保留原文。

每批校验完成后立即显示并缓存。Stop 取消后续调度及可中断的请求，已完成结果保留；不能承诺客户端取消一定停止 Provider 侧计费。

## 10. MV3 任务可靠性（M2）

Service Worker 不是常驻进程。持久化 job / batch 状态，不只使用全局变量。批次至少包含 pending、inflight、completed、failed、cancelled，以及 attempt、内容版本和缓存 key。

恢复时确认页面会话仍有效；未确认完成的批次先查缓存再按有限预算调度。缓存写入和批次完成状态尽可能使用同一事务。重复结果应用必须幂等。

正常运行通过进度消息和必要的有界保活维持活跃任务；不能仅因打开 Port 就假设永久存活。针对目标 endpoint 的慢首响应及流式响应做真实测试，设置首响应、空闲流和总时限。任务结束停止保活。

服务端已接收而客户端未获得结果时，重试仍可能产生额外费用；缓存不提供跨网络故障的“恰好一次付费”保证。

## 11. 缓存语义（M2）

IndexedDB 由可信扩展上下文管理，不能从 content script 直接打开网页 origin 的同名数据库。Stores 至少包含 translations、documents、jobs。

块级 key 对规范化的稳定 JSON 对象求 SHA-256，包含：

- 原文内容和确定性的保护结构；代码、数字、标点和有意义空白不随意归一化。
- sourceLanguage / targetLanguage。
- Provider 身份、规范化 API endpoint、model。
- 实际生效的生成配置及翻译模式。
- promptVersion / protectionVersion。
- 相关领域和上下文签名。
- 当前块实际依赖的术语、目标译法、领域及策略的内容 hash。

API Key 不进入 cache key。缓存保存可重新绑定当前 DOM 的译文表示，不能保存 DOM 对象、旧 blockId 或随机 placeholder ID。读取后再次校验结构与当前槽位兼容。

文档 key 使用保留正文语义参数的规范化 URL；移除已知追踪参数，区分 hash 路由和普通标题锚点。内容 fingerprint 用于检测正文变化，不仅依赖开头少量段落。

上下文或 glossary 改变时允许相关块失效。只有语义依赖未变化时，才能期待“100 块只改 3 块，另外 97 块命中”。避免任意无关词条变化使所有文章缓存失效。

记录 createdAt、lastAccessedAt、估算字节数及 schema 版本，处理 quota / migration 错误；缓存写入失败不阻止已验证译文显示。提供分别清理译文、文档和全部缓存的设置。缓存容量上限由实际配额和应用预算共同决定，不能承诺默认一定可用 500MB。

## 12. 权限与隐私

M1 仅 storage、activeTab、scripting、contextMenus，不默认获得所有站点访问权限。页面脚本由用户操作按需注入；不自动翻译浏览记录中的页面。

M2 根据配置声明 optional_host_permissions，在用户保存/测试连接的操作中只请求目标服务 origin。生产服务优先 HTTPS；本机 loopback HTTP 单独支持。不得把 content script 的任意 URL / Authorization 透传为后台 fetch。

密钥仅保存在本地可信扩展存储，不放 storage.sync，不写日志、不传给页面脚本；错误信息脱敏。设置页默认 mask。正文会发送到用户配置且授权的 Provider，这一点在首次真实翻译时明确。

扩展自己的内容脚本构建资源可被浏览器加载，不包含任何用户密钥。消息接收校验 sender 和 schema。网页内容、标题、术语候选和模型输出都是数据，不是可执行指令。

## 13. 设置及界面

React popup：当前页面、显示方式、块进度、停止、恢复、设置入口。关闭 popup 不影响预览/翻译。状态从实际页面/任务读取，不能依赖 popup 自身内存。

React options：Base URL、API Key、Model、Temperature、默认显示方式、目标语言、领域化个人 glossary。M2 添加连接测试和缓存管理。

M1 主操作命名为“预览页面布局”，输出带“【布局预览】”；不能把 Mock 文本当作真实中文翻译。API 配置和术语可保存，但明确尚未用于翻译。

M2-A 主操作为“翻译当前页面”，保留独立的“预览页面布局”入口。右键菜单用于真实选中翻译。设置页增加“授权并测试连接”和显式接口兼容选项；个人术语表明确将在 M3 应用。

选中内容使用独立浮层，不修改被选中的 DOM；提供关闭、复制及 Escape 关闭。浮层用 Shadow DOM 隔离界面样式。跨 frame 选中翻译暂不支持。

## 14. 验收与质量

自动化：

- 嵌套列表、blockquote、表格只提取一次文本，保留父块自身文本。
- strong / em / link 内自然语言可翻译；代码、公式及保留标记不损坏。
- 防止未知、缺失、重复、错误嵌套占位符和不完整块集合进入渲染。
- 三种显示方式、取消、重复触发、原文恢复；检查原节点身份和监听器。
- 表格行列结构、列表结构、标题锚点与固定样本的恢复一致性。
- 页面更新、pushState / replaceState / hash 路由后不写回旧结果。
- 设置持久化及内容脚本无法读取 Key。
- M2 补充 API 错误、分批缓存、后台回收与恢复、响应超时和并发预算测试。
- M1.5 验证 SDK 在无 DOM 的 Node 环境执行、统一文档的结构往返、跨批次快照、取消与迟到响应处理；tarball 在仓库之外的项目独立安装、类型检查和运行。

固定 fixtures 是人工编写的代表性结构，不等于已经验证真实站点。每个里程碑还需人工安装 Chrome / Edge，检查真实目标页面、深色模式及实际 activeTab 授权。

LLM 质量另设人工评测集：术语、否定、限定条件、比较关系、数字、单位、引用及跨句指代。Mock 和结构校验不能替代这项验收。

记录：提取耗时、首段延迟、整页耗时、输入/输出 tokens、请求数、翻译块数、重试率、缓存命中率和降级块数。API 请求数与块数分开统计。

## 15. 交付里程碑

### M1：扩展及 DOM 闭环

- 扩展骨架、React popup/options、可信本地设置。
- semantic block 提取、格式与不可变槽位、结构验证。
- MockProvider 渐进预览、三种模式、停止、恢复、选中浮层。
- SPA / 原文变化的基本失效处理。
- 三类固定页面样本、单元测试、真实 Chromium 扩展测试。

这一阶段不发送真实 LLM 请求，不实现翻译缓存；不是完整 V1。Protection 和 Validation 属于该阶段的必需内容。

### M1.5：共享翻译 SDK

- 建立 npm workspace 包，输出独立 ESM 及 TypeScript 声明。
- 统一文档 / 块 / 行内模型；章节路径、公式、代码、引用和格式结构。
- 将保护编码与还原、结果校验、通用请求构造、Provider 接口、分批执行和取消放入 SDK。
- 网页全文和选中内容通过 SDK 运行；原节点、快照及安全渲染仍由 DOM 适配器管理。
- Node 示例与独立包消费验证；保留 M1 的 DOM 和真实 Chromium 回归。

本阶段仍使用 Mock，不实现 PDF / LaTeX 解析器。真实翻译和质量策略在 M2 / M3 集中进入 SDK；不能将结构测试通过视为翻译质量达标。

### M2：真实 API 与可靠缓存

- 动态 API host permission、连接测试、能力配置和 fetch Provider。
- token 预算、全局并发、有限重试、进度、取消。
- 扩展 IndexedDB / idb、完整缓存 key、文档 metadata、任务恢复。
- 使用真实 API 完成一个指定站点的端到端翻译；后台回收及慢响应测试。

请求构造、校验、预算、重试与缓存语义归 SDK；API origin 授权、密钥、全局后台任务、IndexedDB 实现与 MV3 恢复归扩展。存储适配契约随可验证的缓存实现引入。

M2 分为 A / B / C，均已实现：A 为真实 API；B 为预算、并发、重试和缓存；C 为持久化恢复、浏览器验收与安装产物。默认输入估算 6000、输出 4096、上下文 32768、余量 512 Tokens，每批最多 4 单元、首个未命中单元优先，每 endpoint 跨标签页最多两个请求。首响应/空闲读取 25 秒，总时限 120 秒；可选 SSE。译文缓存默认 64 MiB / 30 天，实际配额最多占 20%；文档记录最多 1000，结束/暂停任务最多 50 / 7 天。活跃任务 15 秒心跳；暂停确认唤醒限于两分钟，之后保留检查点但不持续唤醒。整个浏览器或页面重载后由用户再次触发翻译，才能恢复匹配任务。

### M3：上下文、术语与质量收敛

- 内置领域术语表、用户术语应用、上下文分析、动态 glossary。
- 补全缓存依赖和分析失败降级。
- 人工翻译质量评测及真实三类站点回归；修复必要适配。
- 达到全部 V1 功能与质量验收后才标记 V1 完成。

## 16. 后续复用边界

共享 SDK 是网页、PDF 和 LaTeX 应用的翻译核心。输入适配器负责语义提取：DOM 可见正文、PDF 阅读顺序 / 跨页段落 / OCR、LaTeX 命令及宏解析；这些会影响翻译语义，不能仅视为布局问题。各适配器将原文转换为统一文档模型，维护源码位置映射，再负责输出排版、转义与导出。SDK 不承担 PDF 版面复刻或 TeX 重编译。

先在当前仓库使用 npm workspaces，让扩展和 Node 示例消费同一包；需要时通过版本化 tarball 或包仓库供其他项目安装，不提前引入共享后端。Python 应用可通过 Node CLI 或本地服务调用同一实现。

改进 SDK 后，各应用升级并重新构建才会受益；已安装应用不会自动获取库源码变化。翻译策略更新必须配套人工质量回归，并让受影响缓存失效。promptVersion / protectionVersion 与 SDK 包版本分开维护；M2 / M3 补齐模型、生成配置、上下文和实际生效术语依赖。

未来可独立增加阅读库、更多 Provider、可视区域优先、首次术语显示状态和 PDF 阅读界面。M1–M3 不提前引入这些功能的后端或框架。

## 17. 设计依据

- [Chrome MV3 后台生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [扩展存储与 origin](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [消息序列化](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [跨域 API 请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)
- [cloneNode 与事件监听器](https://developer.mozilla.org/en-US/docs/Web/API/Node/cloneNode)
- [Playwright 扩展测试](https://playwright.dev/docs/chrome-extensions)

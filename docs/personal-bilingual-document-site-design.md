# 个人双语技术文档站：技术设计方案

版本：设计草案 v1.0  
日期：2026-10-10  
目标：浏览器插件一键归档技术文章、上传 PDF 后自动翻译，并以统一的双语 HTML 阅读器阅读和回溯原文。

> 2026-10-26：本轮讨论已经明确多用户私有资料、管理员手工开通账号、个人 API、本地 PDF 处理与左右对照阅读。最新范围收敛到 [个人学习站 V1 设计稿](superpowers/specs/2026-10-26-personal-learning-site-design.md)，已于 2026-10-27 获批；本文件保留早期方案背景。其中默认单用户、服务器集中 PDF 推理、S3 前提及未旋转 PDF 坐标示例不作为新站点的实现决定。

> 本文是待实施的架构设计，不是对现有代码的审计。用户已实现网页翻译插件和聊天能力；统一 Document IR、通用翻译引擎及服务端实现的完成程度尚未核实。框架、资源与阈值是建议，不代表经过用户服务器实测。

## 1. 结论与范围

推荐建设一个以 Document IR 为中心的“个人文档归档与双语阅读系统”，而不是把浏览器插件生成的 HTML 直接上传到博客。

核心技术路线：

```text
浏览器采集 / PDF 上传 / 后续 arXiv 导入
                   ↓
             不可变原文版本
                   ↓
             Parser / Normalizer
                   ↓
            不可变 Source IR
                   ↓
           统一 Translation Engine
                   ↓
        Translation Revision（译文覆盖层）
                   ↓
      Source IR + Translation Revision → 双语 Document IR
                   ↓
           HTML Renderer + 阅读器
```

原文、译文和渲染结果分别持久化。HTML 是可再生的产物，不是唯一数据源。网页、PDF 和 LaTeX 的差异主要停留在采集、解析和原文定位层。

默认假设：单人使用，服务器可从公网访问，全文资料默认私有；先使用用户已有的 LLM 调用方式，不假定服务器具备本地大模型推理能力。技术栈参考采用 TypeScript 为主、Python 负责 PDF 解析；现有翻译核心若是其他语言，优先保留并通过适配接口接入。

首版范围：网页收藏、PDF 上传、双语 HTML 阅读、原文链接/原 PDF 对照、列表与标签、基本搜索、翻译任务状态和失败重试。

暂不进入首版：像素级网页复刻、保持原排版的译文 PDF、任意 LaTeX 项目的完整编译、跨站全自动爬取、复杂多租户、知识图谱和全库自主 Agent。扫描 PDF 可先识别并标记为需要 OCR，不应静默产出空白译文。

### 1.1 三种路线的取舍

| 路线 | 收益 | 局限 | 结论 |
|---|---|---|---|
| 插件导出双语 HTML，直接放静态站 | 最快做出可浏览的归档 | 重译、PDF 溯源、质量管理和版本维护困难 | 仅适合过渡兼容入口 |
| 在已有文章 CMS/稍后读系统上扩展 | 复用列表、标签、账户 | 核心数据模型未必能承载结构化译文与 PDF 定位 | 可复用界面，不建议绑定核心模型 |
| 模块化单体 + 异步 Worker + IR 内核 | 与长期产品方向一致，可逐步扩展 | 需要先定义少量核心契约 | 推荐 |

这里的模块划分不等于微服务拆分。第一版部署在一台服务器，不上 Kubernetes、Kafka、Elasticsearch 或独立向量数据库。

## 2. 总体架构与技术栈

```text
[已有浏览器插件]                  [站点：上传 PDF]
  原始 DOM/正文采集                 文件上传
  资源清单、可选已有译文             元数据
          └──────────────┬──────────────┘
                         ↓ HTTPS
                 [API：模块化单体]
             认证 / 文档库 / 上传 / 任务 / 阅读
                    ↙             ↘
          [PostgreSQL]             [私有 S3]
          元数据、版本、任务          原文、图片、IR
          段落译文、阅读状态          译文快照、HTML
                    ↑             ↑
                    └────[Worker]─┘
                          │
          网页归一化 → PDF 解析适配 → 翻译 → 校验 → 渲染 → 索引
                          │
                [隔离的 Python PDF Parser]
                接收文档字节，不接收任意 URL
                无 LLM / S3 / 数据库密钥

[统一 Web Reader]
   双语正文 / 目录 / 原文开关 / PDF 原文定位 / 后续文档问答
```

| 层 | 参考技术选择 | 设计理由 |
|---|---|---|
| 浏览器插件 | 复用现有代码；新增 capture / archive adapter | 不另造一套采集客户端 |
| Web 前端 | React + TypeScript + Vite | 私有阅读站不必为 SEO 引入复杂 SSR；可复用 TS 阅读组件 |
| API | Node.js + TypeScript + Fastify | 与插件、翻译内核和 HTML 渲染器共享类型及纯逻辑 [R14] |
| 后台处理 | 独立 Node.js Worker 进程 | 不让 HTTP 请求承载长任务 |
| PDF 解析 | Python + Docling 适配器 | 获取结构、阅读顺序、表格和可用的来源信息 [R4] |
| 元数据与任务 | PostgreSQL | 首版同时承担业务数据与持久化任务表 [R8] |
| 对象数据 | 用户已有的 S3 / 兼容对象存储 | 保存原始文件、大对象和不可变派生产物 |
| HTML 阅读 | 自有 IR Renderer | 不直接执行原网页 HTML 和脚本 |
| PDF 原文查看 | PDF.js | 作为原文展示层；坐标映射由适配层和阅读器负责 [R6] |
| 网页抽取与清洗 | 自有规则 + Readability + DOMPurify | 正文抽取和安全清洗是不同职责 [R1] |
| 部署 | Caddy + Docker Compose | 单机部署；域名与有效 HTTPS 作为入口 [R15][R16] |

若已有 API/翻译核心不是这套语言，不建议为了采用表中的框架整体重写。优先统一协议、类型和测试，再决定是否迁移实现。

## 3. 两个用户流程

### 3.1 网页：一键收藏，不依赖服务器重新抓取同一个 URL

1. 用户点击“收藏并翻译”。插件获取当前实际看到的原始正文、标题、作者、来源、时间、原文 URL、资源清单及采集范围。
2. 对原始 DOM 的副本做正文提取；保留公式、表格、代码、图注和链接结构。不要直接对已经注入译文的页面做二次提取。
3. 插件先把待上传包写入持久化 outbox，再调用 API 建立入库会话。上传可恢复，同一次点击使用稳定的幂等键。
4. 正文及必需资源上传成功后，服务端固定原文版本，并在数据库同一事务中创建处理任务。
5. 插件显示“原文已保存，等待翻译”。只有服务端确认源材料持久化后，才承诺关闭浏览器不影响后续处理。
6. Worker 生成 Source IR，导入可匹配的已有译文，补齐剩余翻译，校验并生成双语 HTML。
7. 用户从站点列表进入阅读器，查看“站内原文快照”“原网站链接”和译文状态。

浏览器当前的 DOM 是默认输入，URL 是来源标识和辅助入口。服务端 URL 抓取只用于公开页面的补充导入，不能代替用户当前页面的快照。

#### 采集实现要点

- Readability 可能修改传入 DOM，必须使用克隆对象；它负责正文抽取，不负责安全清洗 [R1]。
- 先提取数学源表达式、特殊节点与源定位信息，再做可能删除节点的正文清理；避免公式的可视层和可访问性层被重复提取。
- 保存 `capture_scope=article|selection` 与完整性警告。选区收藏、分页内容、懒加载内容、跨域 iframe 和封闭 Shadow DOM 不应被宣称为完整文章。
- 删除插件自己注入的翻译节点、聊天窗口和工具栏。更可靠的办法是让现有翻译逻辑持有原文节点快照和稳定映射。
- 不默认采集表单、密码输入、隐藏 token、Cookie、Authorization 或整个页面的应用状态。
- 原文 URL 和 canonical URL 分别存储；canonical 仅作为候选。清理已知追踪参数，不机械删除所有 query 或 hash，防止破坏带参数/路由的正文身份。

#### 图片、公式与资源

资源清单至少包括：来源 URL、类型、所属块、原始尺寸、获取状态、内容摘要、站内 asset_id。

图片应归档到 S3，不能只留下外链。解析相对路径，并优先记录当前实际选中的图片资源。对于需要登录或跨域授权的资源，只在浏览器已经获得所需权限的范围内获取；不把站点 Cookie 转交个人服务器。

`activeTab` 只提供用户触发后的临时页面权限，并不是访问任意图片 CDN 的通行证。Content Script 和扩展后台的跨域规则也不同。上传在扩展后台/扩展页面完成，权限只授予个人站点及明确需要的资源域名 [R2][R3]。

无法获取的资源保留占位和原始来源，标记 `missing_asset`。后续补齐资源产生新的归档/渲染版本，不静默改写既有可复现版本。

扩展 service worker 可能被终止，不能只把上传状态保存在内存中；outbox、重试计数和已上传对象清单必须持久化 [R7]。

### 3.2 PDF：上传后异步处理，原 PDF 始终保留

```text
申请上传会话 → 上传 PDF → 服务端验证并固定源文件
                                     ↓
                       保存原 PDF，可先在线查看
                                     ↓
                 解析正文 / 阅读顺序 / 图片 / 表格 / 公式
                                     ↓
                       Source IR + 页面来源坐标
                                     ↓
                           统一翻译与 HTML 渲染
                                     ↓
                  双语 HTML 阅读 + 点击块定位原 PDF
```

上传时先把资料加入文档列表，分别显示“上传中”“原文可读”“处理中”“部分译文”“译文完成”“需要处理”。

不要让一次 PDF 失败影响已有网页阅读；不要让一次重译失败覆盖先前的可读版本。

## 4. 数据模型：分开原文、解析版本、译文和阅读状态

### 4.1 建议的实体

| 实体 | 核心字段与职责 |
|---|---|
| `documents` | 文档逻辑 ID、owner_id、类型、标题、作者、source identity、visibility、当前可读版本指针 |
| `source_versions` | 原始文件/快照 manifest、捕获时间、来源 URL、源内容摘要、许可元数据；不可变 |
| `parse_versions` | source_version_id、parser 名称/版本/配置、schema_version、Source IR key、质量报告；不可变 |
| `translation_versions` | parse_version_id、目标语言、profile_hash、模型/提示词/术语表版本、状态、译文快照 key |
| `translation_segments` | 翻译版本、block/segment ID、原文摘要、target_inlines、状态、校验结果、人工锁定标记 |
| `assets` + 引用关系 | 对象 key、摘要、MIME、字节数、所有者与引用；权限不由“知道 key”推导 |
| `render_artifacts` | parse_id、translation_id、renderer_version、展示模式、HTML/manifest key、发布状态 |
| `jobs` / `job_events` | 任务类型、阶段、输入摘要、租约、尝试次数、下一次执行时间、错误、费用与进度 |
| `document_user_state` | 标签、稍后读/读完、置顶、最后阅读块与版本、用户笔记；独立于原文 |
| `block_index` | 原文及译文的派生搜索索引；可从 IR 与已发布译文重建 |

关联关系：

```text
document
  └─ source_version
       └─ parse_version（Source IR）
            ├─ translation_version A
            ├─ translation_version B
            └─ render_artifact(parse_version, translation_version, renderer_version)
```

同一原文可以被不同解析器版本处理。译文必须绑定具体 parse_version，不能仅绑定 URL 或 document_id。

HTML、原文/译文搜索索引是派生数据；不可变 Source IR 与发布后的译文快照是内容依据。段落级表用于任务续跑和编辑，发布时导出版本快照，避免多个存储位置无规则地互相覆盖。

### 4.2 去重与版本

- 同一用户、同一次请求：由 `Idempotency-Key` 防止重复建任务。
- 同一 URL：是同一来源的候选，不是内容相同的证据。
- 原文正文、结构、资源清单相同：复用源版本；更新收藏时间或标签即可。
- 同一 URL 内容变化：新增 source_version。
- PDF 字节摘要相同：优先复用该用户已有文档，允许明确选择另存为独立条目。
- arXiv 必须保留具体论文版本号；HTML、PDF 和源文件只能在版本对应时关联。
- 选区收藏与全文收藏保留采集范围区别，不误判为完全等价。

`block_id` 不是文本 hash。重复段落必须有不同 ID。只保证一个 parse_version 内 ID 稳定；解析器升级或重新分块后通过显式迁移匹配处理批注，不伪造“永久不变”的块 ID。

## 5. Document IR 设计

### 5.1 最小够用的结构

顶层包含：schema_version、document/source/parse 标识、语言、元数据、结构树、块列表、资源清单、解析质量报告、来源定位。

至少支持：section、heading、paragraph、list/list_item、table、figure/image、math_inline/math_block、code_inline/code_block、caption、quote、footnote、reference。

文内样式通过富文本节点表达：text、emphasis、strong、link、code_ref、math_ref。不要把 Markdown 当作唯一 IR，也不要把任意 HTML 字符串直接作为 LLM 可修改的正文。

以下只是块结构示例，不是最终完整 schema：

```json
{
  "block_id": "b17",
  "type": "paragraph",
  "inlines": [
    {"kind": "text", "text": "The complexity is "},
    {"kind": "math_ref", "asset_id": "m1"},
    {"kind": "text", "text": "."}
  ],
  "source_locations": [
    {
      "kind": "pdf",
      "source_asset_id": "pdf_original",
      "page_index": 2,
      "coordinate_space": "cropbox_top_left_normalized_unrotated",
      "bbox": [0.12, 0.21, 0.88, 0.29]
    }
  ]
}
```

内部 `page_index` 从 0 开始，示例对应显示给用户的第 3 页。矩形是未旋转 CropBox 中、左上角原点的归一化坐标。适配器必须将具体解析器输出转换到该约定，并保存原页面 CropBox、尺寸、旋转及所需变换信息；不能简单把任意解析器坐标直接交给 PDF.js。

同一块可对应多页多个矩形，必须使用数组。没有可靠位置就记为不可用；只知道页码时仅提供页级定位。

### 5.2 Source IR 与译文覆盖层

推荐原文 IR 不动，把译文作为覆盖层：

```text
translation_revision
  parse_version_id
  target_language
  profile_hash
  segments[
    block_id,
    segment_id,
    source_digest,
    target_inlines,
    qa_status,
    generation_metadata
  ]
```

渲染时组合成双语 Document IR；需要独立导出时可物化完整的双语 IR。

译文可以调整语言顺序，但不能自由更换图片、公式、代码和链接目的地。块级图片/表格/代码/公式可以在双语排版中共用；行内公式在双语段落中引用同一受保护资源。

### 5.3 按来源保留不同 locator

网页：snapshot 内稳定节点 ID + 文本 quote/prefix/suffix + 必要的 DOM 路径。站内快照定位应可靠；原网站可能更新，跳转原站只能尽力定位。

PDF：原 PDF asset、页索引、一个或多个矩形、坐标约定、位置精度/可用性。

LaTeX：文件路径、源码区间、章节/公式/引用标识。LaTeX 源位置不等于 PDF 页面坐标，需要独立对齐阶段才能提供 PDF 高亮。

### 5.4 与 Docling 的关系

DoclingDocument 已有正文、表格、图片、层级、阅读顺序及可用时的边界框与 provenance，可作为 PDF parser 输出和设计参考 [R4]。

推荐 `DoclingDocument → 自有 IR adapter`，而不是要求整个产品直接依赖解析器内部类。自有 IR 只增加稳定块关系、双语表示、浏览器来源锚点、质量标记和版本信息；不要重新实现通用 PDF 版面分析。

保留 parser 的原始输出作为调试产物，有助于区分“解析器遗漏”与“IR 转换遗漏”。

## 6. PDF 解析策略与降级

第一阶段以有文本层的技术 PDF 为主要支持范围。使用 Docling 做结构化解析候选；最终选择必须用用户经常阅读的资料验收，不能由通用宣传指标替代。

处理关注点：双栏阅读顺序、页眉页脚、跨页段落、断词连字符、脚注、图注、合并单元格、参考文献与公式。代码和公式区域不做普通段落的连字符/空白归一化。

Docling 支持公式理解等 enrichment，但这些步骤通常增加模型调用与处理时间；公式识别产出的 LaTeX 仍应视为识别结果而非原文件中天然存在的权威源码 [R5]。

| 内容情况 | 首版处理 |
|---|---|
| 正文阅读顺序可靠 | 进入统一翻译 |
| 公式有可信原始 LaTeX/MathML | 保留表达式，用受控 renderer 展示 |
| PDF 公式识别不可靠 | 使用原 PDF 区域裁图展示，保留识别文本仅供辅助 |
| 表格结构可靠 | 按原单元格及合并结构渲染，默认不翻译单元格 |
| 表格结构不可靠 | 展示原表格区域图和可用的原文链接，不编造表结构 |
| 某区域无法解析 | 区域截图/原页入口 + 明确警告，不假装“翻译完成” |
| 扫描 PDF | 标记需要 OCR；后续接入按页 OCR，不对所有 PDF 强制 OCR |
| 加密、损坏、过大文件 | 原因明确地拒绝或要求用户提供可处理版本 |

原始 PDF 永久作为这一源版本的依据。仅保存重排 HTML 无法满足可靠原文对照。

## 7. 统一翻译引擎

引擎输入为 TranslationPlan + Source IR，输出为有版本和校验信息的 TranslationRevision。引擎不关心 DOM、网页路由、PDF 排版或 S3 key。

```text
识别可翻译内容
   → 构建文档上下文和术语配置
   → 切分语义段落/小节
   → 保护结构与不可变内容
   → 批量调用 LLM
   → 校验返回结构及质量风险
   → 仅重试失败/可疑片段
   → 持久化片段、费用和版本
```

### 7.1 默认策略

标题、正文、列表项、图注和表注可翻译。图片、代码、数学表达式、标识符、链接目标及引用关系不交给 LLM 自由改写。为匹配当前插件需求，表格默认 `preserve`；以后再添加 `translate_cells` 选项，但不改变行列、合并单元格与数值结构。

不要逐个 DOM TextNode 翻译。一个语义段落中的链接、加粗、行内代码和公式应进入同一翻译单元。请求可以批量包含多个有 ID 的单元，并提供小节标题、文档主题和必要的相邻段落。

### 7.2 输出契约

LLM 返回结构化的 `segment_id + target_inlines`，不是可直接执行的 HTML。数学、代码、引用等使用受保护引用或占位符。

校验包括：返回 ID 集合、是否重复/遗漏、schema、受保护引用多重集合、嵌套合法性、目标语言、空译文、截断、数值/单位风险、关键术语一致性。

数字书写变化不一定是错译；数值检查作为风险检测。公式/代码/资源身份等不变量可以做硬校验。语义准确性则需要对抽样或可疑片段复核，不能将“JSON 合法”当成“翻译正确”。

不默认对每篇全文执行“翻译—评价—再改写”多轮链。优先一次翻译 + 确定性校验 + 针对性复核，避免不必要费用和改写漂移。

### 7.3 译文缓存与插件已有结果

缓存键建议至少覆盖：

```text
source_segment_digest
+ protected_structure_digest
+ context_digest
+ source_language + target_language
+ translation_policy_version
+ glossary_digest
+ prompt_version
+ provider/model identity + relevant generation settings
```

只用原文文本 hash 不够，同一段话在不同上下文或术语配置下可能需要不同译法。

插件可上报已有译文，但只有源段落、受保护结构、上下文和 profile 匹配且通过校验时才作为正式结果复用。无法证明匹配的旧结果仅作为候选或人工接受的导入版本，不混入同一个标准翻译版本。

不要从已插入中文的双语 DOM 倒推出英文原文。优先复用插件保存的源节点映射和翻译结果记录。

### 7.4 质量、费用与人工修改

每个片段记录输入/输出 token、provider request id（可用时）、实际模型标识、提示词/术语表版本、尝试次数、耗时和错误。

设置文档级及月级预算。外部 LLM 请求超时可能已经被服务商处理，系统不能承诺绝对不重复计费；支持服务商幂等机制时使用，并限制未知状态请求的自动重试。

人工修改生成新译文版本并保留审计记录。人工锁定片段不被自动重译覆盖。重译和 parser 升级默认不替换当前发布版本，校验通过后再切换。

## 8. 异步任务与可靠性

### 8.1 分开三种状态

入库状态：`receiving → accepted | rejected`。

任务状态：`queued → running → succeeded | succeeded_with_warnings | failed | cancelled`。

任务阶段：`normalize / parse / translate / validate / render / index`。

文档可用性：`source_available / bilingual_partial / bilingual_ready`，另挂质量警告。任务失败不意味着文档原文或历史译文不可读。

### 8.2 PostgreSQL 队列

首版用持久化任务表。PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 适用于多个消费者争抢队列式数据的场景 [R8]。

Worker 在短事务中领取任务并写入 lease token / lease expiry，随即提交；解析和 LLM 请求不在数据库事务中进行。执行中续租，完成时用 lease token 和 generation 做条件提交，拒绝过期 Worker 的迟到结果。

每一步以 `输入摘要 + 算法/配置版本` 建唯一执行身份。实现至少一次执行、幂等提交，不宣称端到端 exactly-once。

外部限流和暂时性错误使用有上限的指数退避与抖动。无效文件、结构不可恢复等确定性错误不要无限重试。重试仅处理失败片段，不重跑已通过校验的全文。

建议初始限制 PDF 解析并发为 1；翻译并发从 2 开始，根据模型限流、内存与费用实测调整。这里是起始设置，不是吞吐承诺。

### 8.3 跨数据库和 S3 的提交

对象先上传、校验，再在数据库事务中登记可见版本和后续任务。源文档记录与任务记录尽量同事务创建。

渲染产物写入新版本 key；检查引用资源后再切换数据库中的“当前可读版本”。保留旧版本作为回滚路径。

为上传失败、Worker 崩溃产生的未引用对象设置延迟垃圾回收。删除文档先设置 tombstone 并撤销读取/发布入口；Worker 提交前检查删除状态，防止迟到任务重新发布已删除文档。

## 9. S3 与对象访问

示例逻辑布局（所有 key 都在服务端生成）：

```text
users/{owner_id}/
  staging/{upload_id}/{random_name}
  blobs/sha256/{digest}
  documents/{document_id}/
    sources/{source_version_id}/manifest.json
    parses/{parse_version_id}/source-ir.json
    parses/{parse_version_id}/parser-output.json
    parses/{parse_version_id}/quality-report.json
    translations/{translation_version_id}/translation.json
    renders/{render_id}/bilingual.html
    renders/{render_id}/render-manifest.json
```

源 PDF、图片、公式裁图等可以存入 blobs 并由 manifest 引用。内容寻址不等于访问授权；下载时仍校验文档与用户关系。

上传 PDF 的推荐方式是短期预签名上传到 staging，而不是向浏览器发 S3 长期密钥。S3 预签名 URL 在有效期内可重复使用，同 key 上传可覆盖对象；不能把“已签名”误解为“一次性、不可覆盖” [R9]。

服务端对文件尺寸、类型和最终字节摘要做校验，固定对象版本或复制/流式落入仅服务端可写的不可变最终 key。只有对最终采用的字节完成校验后才登记 accepted。兼容 S3 的实现需验证实际支持的校验、版本和条件请求能力。

保存到 IR / HTML 的是 asset_id 或站内逻辑资源地址，不保存会过期的预签名 URL。读取时由权限校验过的 API 流式返回，或生成短期下载地址。

PDF 原文接口需要正确处理 Range 读取；采用短期直链时必须处理续读失效和刷新地址，不能让用户翻到后面的页面突然失败。

S3 原始 HTML、SVG 等不通过应用主域名无约束地执行。原始快照默认只作数据/下载材料；正常阅读通过白名单 IR renderer。需要预览原快照时使用受限隔离来源和 CSP。

## 10. 阅读器、文档列表与 Agent

### 10.1 统一阅读器

默认段落上下排列：原文段落在上，中文在下。提供仅中文、仅原文和双语模式。桌面可追加左右对照，不要求两种语言像素级等高。

图片、表格、代码和块级公式默认共用一次；图注/表注双语显示。行内公式随原文和译文分别引用同一表达式或资源。

顶部显示标题、作者、来源、收藏时间、原文版本、翻译版本和质量警告。侧边目录由 IR 章节树生成。长文按章节或块分批加载，PDF 原文页按需渲染，不一次加载整本高清页面。

点击 PDF 段落的“查看原文”，在 PDF.js 原文栏打开对应页并高亮可用来源区域。坐标必须结合 PDF 页面的裁切、旋转和当前缩放转换 [R6]。定位精度不足时显示页级定位，不显示虚构的精确高亮。

网页提供“站内原文快照”和“原网站链接”两个不同入口；快照不承诺复刻原网站全部 CSS 和交互。

阅读状态存储 `parse_version_id + block_id + block内偏移`。换解析版本后匹配失败就回退到章节/文档开头，并提示重新定位，不把进度绑定于不稳定的像素滚动位置。

### 10.2 文档库与搜索

列表支持来源类型、标签、作者、收藏时间、未读/读完、翻译状态和警告筛选。缩略图来自归档图片或 PDF 首页，缺少时使用类型图标。

首版搜索标题、作者、标签以及原文/译文文本。先用 PostgreSQL 子串查询并视需要添加 pg_trgm 索引；它支持 LIKE/ILIKE 等匹配，但没有可提取 trigram 的短查询可能退化，必须用真实中文词查询验证，不把它称作完整中文语义搜索 [R10]。

检索结果携带 parse/translation 版本与块 ID，可直接跳到段落。双语命中属于同一源块时合并展示。

### 10.3 复用现有聊天 Agent

首版可以只有文档选区问答，不必先建立全库向量检索。共享一个文档上下文协议：

```text
DocumentContext
  document_id
  parse_version_id
  translation_version_id
  selected_block_ids
  selection_text（可选）
```

只读工具：获取指定块及邻居、文内搜索、获取原文位置。返回原文和译文并附真实版本/块引用。输出引用由程序校验存在性，点击后能回到相应内容。

网页/PDF 中的命令只是待处理数据，不是 Agent 系统指令。翻译 Worker 不赋予浏览器控制、Shell、上传发布或任意网络工具；文档问答也默认只读 [R12]。

全库问答、向量检索、跨文档关系等留作后续增量，不进入核心翻译流水线。

## 11. API 草案

| 接口 | 职责 |
|---|---|
| `POST /api/v1/ingestions` | 创建网页/PDF 入库会话；返回 ingestion_id、待上传资源授权 |
| `POST /api/v1/ingestions/{id}/complete` | 验证上传、固定源版本、创建后台任务；幂等 |
| `GET /api/v1/ingestions/{id}` | 查询缺失上传、持久化确认及入库状态 |
| `GET /api/v1/documents` | 按状态、标签、类型、阅读状态查询列表 |
| `GET /api/v1/documents/{id}` | 元数据、版本、可用性、质量报告摘要 |
| `GET /api/v1/documents/{id}/content` | 获取指定发布版本的阅读 manifest / 双语块数据 |
| `GET /api/v1/documents/{id}/source` | 已授权原 PDF/原文材料；PDF 支持 Range |
| `GET /api/v1/assets/{id}` | 授权资源访问，不是开放代理 |
| `POST /api/v1/documents/{id}/translations` | 创建新翻译版本，明确 profile 与预算 |
| `POST /api/v1/documents/{id}/reparses` | 创建新解析版本，保留旧版本 |
| `GET /api/v1/jobs/{id}` | 状态、阶段、成功/失败片段数、下一次重试信息 |
| `POST /api/v1/jobs/{id}/retry` | 重试失败部分 |
| `POST /api/v1/jobs/{id}/cancel` | 请求取消，Worker 检查后停止 |
| `PATCH /api/v1/documents/{id}/state` | 标签、阅读状态、进度等个人状态 |
| `GET /api/v1/search` | 带权限和版本过滤的检索 |
| `POST /api/v1/documents/{id}/chat` | 后续：限定文档上下文的问答 |

创建耗时任务返回 202 和 ID，不等待翻译完成。首版前端轮询即可；SSE 是后续优化，不是系统可靠性的前提。

所有客户端上报的 owner_id、文档关系、对象 key、文件摘要、IR 和译文都要按不可信输入校验。用户身份来自认证会话/设备 token，而不是请求体中的 owner_id。

## 12. 安全与公开发布边界

### 12.1 身份与访问

单用户模式关闭公开注册。站点登录使用服务端会话，Cookie 配置 Secure、HttpOnly、适当的 SameSite，写操作做 CSRF 防护。

插件首版可用独立、可撤销、有作用域和有效期的设备 token，在已登录站点生成后配置到扩展设置页。服务端仅保存 token 摘要，支持设备级撤销。Token 不进入网页 DOM，不由网页脚本决定上传目的地。

LLM 和 S3 密钥只在需要的服务端组件中使用。PDF parser 不需要这些密钥。CORS 是浏览器访问策略，不是身份认证。

### 12.2 外部内容与网络

Readability 不是 sanitizer；抽取结果必须清洗，正常展示优先由结构化白名单节点生成。DOMPurify/CSP 可作为防线的一部分，依赖需持续跟进安全更新 [R1]。

资源下载与 URL 导入统一经过受控 fetcher：仅允许必要协议，禁止内网/环回/链路本地/云元数据地址；检查 IPv4 和 IPv6，校验重定向后的每一跳，防止 DNS 解析与实际连接目标脱节；限制字节数、时长与重定向数。仅检查 URL 字符串不足以防止 SSRF [R11]。

PDF/LaTeX 处理进程以低权限运行，设置 CPU、内存、磁盘、页数、像素数和时长限制。用户文件名不能变成任意路径。解包需防目录穿越、符号链接和压缩炸弹。文件扩展名和声明 MIME 不能代替内容检查 [R13]。

后续 LaTeX 转换不能只靠关闭 shell-escape；也要去网络、去密钥、限制文件访问与资源，并固定模型/工具链依赖。

### 12.3 私有收藏和公开站点分离

`visibility = private | public_metadata | public_full`。

默认所有全文、译文、原 PDF 和图片私有。个人站点可以公开标题、原链接和用户自己的笔记，但不自动公开全文缓存或译文。将全文公开前单独确认相应材料的授权范围。

arXiv 有多种许可证，且同一作品不同版本可能使用不同许可证；“可以访问下载”不能被系统当作统一的公开再分发授权。许可标识应与具体源版本一起记录 [R17]。

内部技术资料在发送至个人服务器或第三方 LLM 前应明确数据使用边界。私有 bucket 只解决访问控制，不意味着自动满足原资料的全部使用约束。

## 13. 部署、资源、备份与监控

参考单机 Compose：

```text
gateway      Caddy，HTTPS 与前端静态文件
api          Node API，不执行 PDF 重计算
worker       翻译、校验、渲染及任务编排
pdf-parser   Python 隔离解析接口，无公网端口，限制主动外连
postgres     元数据、任务、索引
S3           外部对象存储，不必在同机再部署一套
```

PDF parser 的模型预缓存到只读卷，工作目录按任务清理。它只接收 Worker 传入的文档和受支持配置，不开放任意 URL 转换。不要为了启动解析任务而把高权限 Docker socket 交给可接触不可信文档的应用代码。

数据库和 parser 只在内部网络开放。服务器公网入口是 HTTPS；SSH 另行限制来源和认证方式。备份密钥与业务运行密钥分开。

资源预算是待压测假设：仅 API/数据库/静态阅读可从较小实例评估；把 PDF 结构解析也放同机，可用 4 vCPU、8–16 GB RAM 作为测试起点，并从单 PDF 并发开始。这不是容量或吞吐保证。实际峰值取决于 PDF 页数、图片分辨率、模型与 OCR/enrichment 配置；不足时首先把 parser worker 移走，而不是扩大整个站点架构。

存储预算按以下项目测量，不假定固定 PDF 放大率：

```text
总存储 = 原始网页快照 + 原 PDF + 已归档资源
       + PDF 裁图/缩略图 + IR 与译文版本 + HTML 产物
       + 数据库 + 备份 + 解析模型缓存
```

LLM 费用按真实 token 计量：规划/术语处理 + 首次翻译 + 质量复核 + 重试。分别限制单篇预算和周期预算；重渲染不应再次调用 LLM。

备份至少覆盖 PostgreSQL、S3 原文/资产/IR/译文与服务配置。S3 版本控制和数据库 dump 不是同一件事；需要独立的恢复演练，并维护备份所引用对象的保留窗口，避免垃圾回收先删掉可恢复数据库所需对象。

监控最少记录：待处理任务数、最老任务等待时长、各阶段耗时、失败与重试、解析警告、未翻译片段、资源缺失、token/费用、磁盘余量、PDF parser 峰值内存。不要把全文或密钥打进常规日志。

## 14. 代码组织与模块接口

```text
apps/
  extension/                 现有插件
  web/                       文档库与统一阅读器
  api/                       认证、入库、版本、阅读 API
  worker/                    持久化任务执行
packages/
  document-ir/               schema、TS 类型、迁移与验证
  web-capture/               正文提取和来源映射
  translation-core/          分段、上下文、术语、保护、校验
  llm-provider-adapters/     实际模型调用；与核心翻译策略分离
  html-renderer/             同一个双语渲染实现
  document-client/           插件和站点使用的 API SDK
parsers/
  pdf-python/                Docling 及来源坐标适配
  latex/                     后续实现
fixtures/
  web/                       归档输入与期望 IR
  pdf/                       测试文档与期望区域/阅读顺序
  translation/               结构保护与质量案例
infra/
  compose/                   单机部署定义
```

建议稳定的接口：

```text
CaptureAdapter.capture() -> SourceBundle
Parser.parse(SourceBundle, ParserConfig) -> ParseResult
TranslationPlanner.plan(SourceIR, TranslationProfile) -> TranslationPlan
TranslationEngine.execute(TranslationPlan) -> TranslationRevision
Renderer.render(SourceIR, TranslationRevision, RenderOptions) -> RenderArtifact
SourceLocator.resolve(BlockSourceLocation, ViewerContext) -> ViewerTarget
```

TypeScript 与 Python 共享 JSON Schema 契约及固定样例，类型尽量由契约生成，避免人工维护两套含义略有差异的模型。

浏览器“原位插译”renderer 与站点“文章阅读”renderer 不必是同一个 DOM 操作实现；必须复用的是内容语义、译文关系、保护规则和版本协议。

## 15. 分阶段落地与验收

| 阶段 | 交付物 | 验收重点 |
|---|---|---|
| A：网页归档闭环 | 最小 IR、入库 API、S3、PG、插件收藏、列表、双语阅读、已有译文导入 | 原文与资源落盘后，关闭浏览器仍能阅读；重复点击不重复建任务；不采入插件注入内容 |
| B：服务端统一翻译 | 翻译 profile、结构保护、片段持久化、缓存、预算、重试、版本切换 | Worker 中断后续跑；缺失片段不伪装完成；失败重译不覆盖旧版 |
| C：PDF 阅读闭环 | PDF 上传、解析 adapter、图表降级、来源坐标、PDF.js 对照 | 用同一 HTML 阅读器打开 PDF；定位正确；不能解析的区域有原文退路 |
| D：易用性与可靠性 | 搜索、阅读进度、人工修订、备份恢复、任务管理、质量报告 | 删除/恢复/换版本行为一致；权限和恢复演练通过 |
| E：扩展 | arXiv 同版本 HTML/PDF 关联、LaTeX、OCR、文档问答、公开发布 | 新输入类型不改变翻译内核和阅读器核心 |

阶段 A 可以复用现有插件翻译结果做兼容入口，但仍通过段落映射和 Source IR 保存；不能把“只有双语 HTML 的临时快照”固化为长期数据模型。

### 15.1 建议回归集

建立约 20 个网页和 20 个 PDF 的固定样例库，覆盖普通博客、公式、代码、表格、懒加载、重复段落、双栏论文、跨页表格、图注、旋转页、无文本层、加密/损坏文件和恶意输入。这是建议构建的样本规模，不是已执行测试。

验收应分别检查：

- 结构保留：必需段落是否丢失、阅读顺序是否正确，表格结构或原图是否完整。
- 受保护内容：公式、代码、资源与链接目标在翻译前后满足明确不变量。
- 溯源：成功处理的块有真实定位依据；缺少定位时显式降级。
- 翻译：漏译、术语、指代、否定和数值等风险，不能只看流畅度。
- 可靠性：重复提交、限流、Worker 崩溃、租约过期、S3 上传中断、旧 Worker 迟到提交、删除与重译竞态。
- 安全：XSS、SSRF 重定向、私有资源越权、上传覆盖竞态、恶意文件/解压路径、文档提示词注入。
- 恢复：从备份重建数据库、重建索引，并能访问原文、译文和图片。

### 15.2 第一批应固定的契约

最优先确定 SourceBundle、Source IR、TranslationRevision 和 SourceLocation 四个契约，并以一篇网页和一篇有图表公式的 PDF 贯穿验证。

先验证“内容完整进入系统、稳定形成双语块、可以回到原文”，再扩展管理界面、Agent 和更多 parser。统一的关键是语义与来源关系，而不是强迫所有输入都保留原始排版。

## 参考资料

以下为设计核查使用的官方项目、标准组织或供应商资料；访问日期 2026-10-10。设计中的部署规模、初始并发、API 和数据表均为本方案建议，不是来源给出的性能保证。

- [R1] Mozilla Readability：DOM 克隆、正文提取及安全边界。`https://github.com/mozilla/readability`
- [R2] Chrome activeTab 权限。`https://developer.chrome.com/docs/extensions/develop/concepts/activeTab`
- [R3] Chrome 扩展跨域请求及消息处理安全。`https://developer.chrome.com/docs/extensions/develop/concepts/network-requests`
- [R4] DoclingDocument：层级、阅读顺序、可用位置与 provenance。`https://docling-project.github.io/docling/concepts/docling_document/`
- [R5] Docling enrichment：公式、代码与额外处理成本。`https://docling-project.github.io/docling/usage/enrichments/`
- [R6] PDF.js API 与页面 viewport。`https://mozilla.github.io/pdf.js/api/draft/api.js.html`
- [R7] Chrome 扩展 service worker 生命周期与持久化。`https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle`
- [R8] PostgreSQL SELECT / SKIP LOCKED。`https://www.postgresql.org/docs/current/sql-select.html`
- [R9] S3 预签名 URL 的期限、重复使用、覆盖与校验。`https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html`
- [R10] PostgreSQL pg_trgm 的索引能力和短查询限制。`https://www.postgresql.org/docs/current/pgtrgm.html`
- [R11] OWASP SSRF Prevention Cheat Sheet。`https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html`
- [R12] OWASP LLM Prompt Injection Prevention Cheat Sheet。`https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html`
- [R13] OWASP File Upload Cheat Sheet。`https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html`
- [R14] Fastify 官方文档。`https://fastify.dev/docs/latest/`
- [R15] Caddy Automatic HTTPS。`https://caddyserver.com/docs/automatic-https`
- [R16] Docker Compose 单机生产部署。`https://docs.docker.com/compose/how-tos/production/`
- [R17] arXiv 许可证与版本差异。`https://info.arxiv.org/help/license/index.html`
- [R18] arXiv HTML 转换与 LaTeX 标记建议。`https://info.arxiv.org/help/submit_latex_best_practices.html`

### arXiv / LaTeX 扩展说明

后续遇到 arXiv 论文时，优先探测与选定论文版本对应的官方 HTML；可用且结构满足要求时，复用网页 parser，并同时保存同版本 PDF。官方 HTML 转换涉及 LaTeXML 及包映射，并非所有 LaTeX 写法都能无损进入 HTML [R18]。

官方 HTML 不可用时，首选已落地的 PDF 路径；确有更高公式/引用质量需求时，再处理 LaTeX 源码包。原始 LaTeX 的提取、宏解析、包适配和安全运行是独立子项目，不应阻塞首版 PDF 上传与双语阅读。

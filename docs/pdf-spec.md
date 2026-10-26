# PDF Translation Reader V1 详细设计 SPEC

> 2026-10-26：网站账号、首版范围与阅读模式的最新设计见 [个人学习站 V1 设计稿](superpowers/specs/2026-10-26-personal-learning-site-design.md)，已于 2026-10-27 获批。已确认方向为各用户独立资料、个人 API、本机 PDF 处理后导入，以及左原 PDF / 右译文 HTML；本文件继续保留 PDF 内容、来源坐标和处理质量等模块要求。

> 2026-10-07 方案更新：进入 PDF P0 首轮真实评测，入口见 [benchmark](../benchmarks/pdf/README.md)。首版为单用户、可部署到服务器的应用，本机是初始部署环境；数据库、文件存储、任务与对话由后端管理。本机和服务器统一使用 PostgreSQL，首版文件存储采用持久化磁盘目录，预留对象存储适配。浏览器插件继续回归；文档分析与自动术语可在 PDF 阶段补进共享 SDK。初稿完整保存在 [archive/pdf-spec-initial.md](archive/pdf-spec-initial.md)，历史审阅见 [spec-review.md](spec-review.md)，仓库边界见 [monorepo.md](monorepo.md)。LaTeX 后续复用同一个 Reader，见 [latex-spec.md](latex-spec.md)。
>
> P0 解析评测入口、候选适配和定位图已实现；两本书及三篇论文的首轮结果见 [实测报告](../benchmarks/pdf/first-run-report.md)，正式质量 corpus / 主选型仍待完成。正式 Reader / 网站 / 文档服务尚未实现。下文结构示例是设计材料，跨语言协议须在 PDF P0 / P1 验证并版本化；翻译执行与保护协议直接复用现有 SDK。

## 0. 产品定义

### 0.1 产品目标

开发一个专门面向科技论文、技术报告和工程文档的 PDF 翻译阅读器。

核心用户并不是“完全看不懂英文”的用户，而是：

> 能阅读英文科技论文，但英文阅读速度明显慢于中文，希望通过高质量中文翻译提高阅读效率，并且在翻译不准确、术语不明确或内容复杂时，可以立即对照英文原文。

因此本产品的核心目标不是：

> 把英文 PDF 原封不动复制成一个中文版 PDF。

而是：

> 把 PDF 恢复成结构良好的语义文档，进行高质量科技翻译，并提供高效的原文/译文对照阅读体验。

---

# 1. V1 核心设计决策

V1 明确采用以下原则。

## 1.1 HTML 是主要阅读输出

核心 pipeline：

```text
PDF
 ↓
结构解析
 ↓
Document IR
 ↓
语义重建
 ↓
翻译
 ↓
Original HTML + Translated HTML
 ↓
Translation Reader
```

不要求重新制作与原 PDF 分页、双栏、文字坐标完全一致的 HTML。

---

## 1.2 不复制 PDF 的分页

原 PDF：

```text
Page 1
Page 2
Page 3
...
```

转换以后：

```text
Title

Abstract

1 Introduction

paragraph
paragraph

Figure 1

paragraph

2 Related Work
...
```

最终表现为正常连续网页。

PDF 中：

- 页码
- 双栏
- 跨页段落
- 页眉
- 页脚

均属于“物理排版信息”。

Reader 应尽可能恢复：

> 文章逻辑结构。

而不是保留：

> 打印页面结构。

---

## 1.3 翻译单位必须是 Semantic Block

绝对禁止：

```text
PDF line
→ translate

PDF text span
→ translate
```

必须：

```text
PDF physical blocks
 ↓
semantic reconstruction
 ↓
完整 paragraph
 ↓
translation
```

例如：

PDF：

```text
Page 4 / Column 2

Large language models have demonstrated
strong performance across a wide range of

Page 5 / Column 1

downstream tasks. However, their ability...
```

必须恢复成：

```text
Large language models have demonstrated strong performance
across a wide range of downstream tasks. However, their ability...
```

再进行翻译。

---

## 1.4 原文与译文采用 Block-level alignment

每一个语义 block 都必须拥有稳定 ID。

例如：

```text
block-001
English paragraph
Chinese translation

block-002
English paragraph
Chinese translation
```

原文和译文天然对应。

无需再做复杂页面位置同步。

---

# 2. V1 阅读体验

## 2.1 默认模式：中文阅读模式

用户打开已经翻译好的论文时，默认看到：

```text
Scaling Laws for Neural Language Models

神经语言模型的 Scaling Laws

作者……

摘要

随着模型规模……

[原文]

1 引言

近年来，大型语言模型……

[原文]
```

主要内容只显示中文。

每一个 paragraph 可以显示一个非常弱化的小按钮：

```text
原文
```

点击后：

```text
近年来，大型语言模型……

──────── English ────────

In recent years, large language models...

[收起原文]
```

这样：

> 正常阅读时完全按照中文速度阅读。

只有遇到问题：

> 展开对应英文。

这是 V1 最重要的阅读模式。

---

# 3. 阅读模式与 PDF 对照

Toolbar：

```text
译文 | 对照 | 原文 | PDF
```

## Translation

默认。

只显示：

```text
中文
```

原文按需展开。

---

## Bilingual

按照 semantic block：

```text
English paragraph

中文段落


English paragraph

中文段落
```

采用上下排列。

不要默认左右两栏。

原因：

- 阅读宽度更自然
- 长公式不会挤压
- 表格不会变形
- 小屏幕兼容
- 不需要同步滚动
- 中英文长度差异不影响布局

---

## Source

只显示重建后的英文 HTML：

```text
Title

Abstract

English paragraphs...

Figure

Table
```

注意：

这不是 PDF 原版式。

这是从 PDF 恢复出来的：

> Semantic Source HTML。

---

## PDF

作为兜底。

打开原始 PDF。

用途：

- 检查 Parser 是否解析错误
- 查看特殊公式
- 查看复杂表格
- 查看特殊排版
- 查看原始页码

PDF 不是主要阅读模式。

---

# 4. 产品流程

```text
Upload PDF
   ↓
SHA256
   ↓
Cache lookup
   ↓
PDF classification
   ↓
PDF Parser
   ↓
Raw Physical Blocks
   ↓
Normalizer
   ↓
Semantic Reconstruction
   ↓
Document IR
   ↓
Document Analyzer
   ↓
Glossary
   ↓
Translation Cache Lookup
   ↓
Translation Engine
   ↓
Translated Document IR
   ↓
Reader
```

---

# 5. V1 支持范围

重点支持：

- English → Simplified Chinese
- Born-digital PDF
- 科技论文
- CS / AI / ML
- 软件工程
- 物理/工程论文
- 技术报告
- 学术论文
- 单栏
- 双栏
- 复杂多栏作为挑战集，不作为首版普遍支持承诺
- 图片
- Figure caption
- Equation
- Inline math
- 普通 Table
- Footnote
- Reference
- List
- Algorithm / code

---

# 6. V1 暂不作为重点

以下放到后续阶段：

- 纯扫描 PDF
- 手写 PDF
- 复杂 OCR
- 老旧扫描论文
- 完美恢复 PDF 页面布局
- 中文覆盖原 PDF
- 原版式中文 PDF
- Word 导出
- PPT
- 用户系统
- 分享系统
- 多人协作

如果 Parser 恰好能处理 OCR，可以作为实验功能，但：

> V1 不以 OCR 质量作为验收指标。

---

# 7. 推荐技术架构

Frontend：React + TypeScript + Vite，位于 `apps/web`，根据 Reader IR 渲染连续 HTML。

文档 API / 任务编排：TypeScript，位于 `apps/document-service`，直接调用 `@pagelingo/translation-core`。同一包内区分 HTTP API 与 worker 入口，早期可同机部署。

网站、API、worker 和数据库具有独立的运行职责。首版用 Docker Compose 描述单机部署，API 与 worker 分进程运行；worker 调用独立 Python parser。开发阶段可直接启动 Node / Python、使用 Compose 提供 PostgreSQL；服务器使用同一数据库 schema 与存储接口，运行数据存入持久卷。解析器的 GPU / CPU 部署配置由 P0 实测决定。

解析：Python 独立进程，位于 `services/document-parser`。PDF 生态仍使用 Python，但不另写 Python 翻译引擎，也不默认再增加一层 FastAPI 转发服务。独立 Python 消费者未来可通过版本化 Node CLI / 本地 API 调用 SDK。

Parser 候选：MinerU、Docling，Marker 作为额外比较候选。**主解析器由 PDF P0 在目标硬件上实测确定**，当前已安装并锁定 P0 候选的本地 CPU 配置，正式主配置尚未冻结。每次记录代码版本、backend、模型权重 revision、OCR / VLM 配置、设备、资源消耗及代码 / 模型许可；不同版本的 CLI、页范围和结构化 schema 不可混用。

适配器必须证明能取到所需的全文、阅读顺序、块类型、来源和资产；缺失字段须显式降级，不能假定同一个产品名下所有 backend 都提供完全相同的结果。

PyMuPDF 可作为页面尺寸、裁剪图像与坐标转换的候选；浏览器原 PDF 展示使用独立 viewer，不把 Python 库当作浏览器渲染器。选择具体版本前同样记录依赖条件。原版式 PDF 重排不属于 V1。

能力核对依据：[MinerU](https://github.com/opendatalab/MinerU)、[Docling](https://github.com/docling-project/docling)、[Marker](https://github.com/datalab-to/marker)、[PyMuPDF 页面接口](https://pymupdf.readthedocs.io/en/latest/page.html)。候选排序是待实测的工程判断。

---

# 8. Parser 必须抽象

定义：

```python
class PDFParser(Protocol):

    def parse(
        self,
        pdf_path: str,
        options: ParseOptions
    ) -> RawParseResult:
        ...
```

实现：

```text
MinerUParser
DoclingParser
MarkerParser
```

整个系统其他部分：

> 不知道 MinerU 是否存在。

只认识：

```text
RawParseResult
```

---

# 9. 为什么必须建立自己的 Document IR

严禁：

```text
MinerU JSON
→ Frontend
```

也严禁：

```text
MinerU Markdown
→ Translation
```

应该：

```text
MinerU
 ↓
MinerUAdapter
 ↓
Raw Blocks
 ↓
Normalizer
 ↓
Document IR
```

原因：

未来：

```text
MinerU → Marker
```

Reader 和 Translation Engine 不直接依赖 parser 私有 schema。替换 adapter 后仍需重新验证结构质量；无法表达的新结构可能需要版本化扩展 Reader IR，不能承诺任意 parser 无损互换。

---

# 10. 两层文档模型

整个系统区分：

```text
Physical Layer
```

和：

```text
Semantic Layer
```

---

# 11. Physical Layer

Physical block 表示：

> PDF 页面上实际识别出来的东西。

```python
class PhysicalBlock:

    id: str

    page_index: int

    bbox: BoundingBox

    type: PhysicalBlockType

    text: str | None

    spans: list[PhysicalSpan]

    parser_confidence: float | None

    reading_order: int | None
```

---

# 12. BoundingBox

Reader IR 使用归一化 `[x0, y0, x1, y1]`，但必须同时规定：

- `pageIndex` 从 0 开始；UI 显示页码另行转换。
- 坐标基于**按页面旋转显示后的 CropBox**，原点左上，x 向右、y 向下，范围 0–1。
- PageMetadata 保存原始 MediaBox / CropBox、旋转、显示宽高及从 parser 坐标到本坐标的转换信息。
- 合并后的段落保留多个 SourceReference，不把跨栏 / 跨页块压成一个含义不明的大 bbox。
- 如果只有页级来源，bbox 可以缺失，但要标注精度；不能编造坐标。

Parser 的 bottom-left、未旋转坐标或不同单位在 adapter 内转换。对 0 / 90 / 180 / 270 度及非零裁剪起点建立 fixture，验证裁剪图、来源跳转与 overlay 一致。PyMuPDF 明确区分旋转和非旋转坐标，不能直接混用其返回矩形。[官方坐标说明](https://pymupdf.readthedocs.io/en/latest/page.html#Page.rotation_matrix)

结构重建应结合原生 PDF 的字符、视觉行、字体样式与绘制区域，以及模型给出的区域和类别。
模型 bbox 是候选来源区域，不直接等同于最终语义段落。坐标匹配的歧义、缺失原生文字和
局部回退必须显式记录，几何匹配比例不能伪装成模型置信度。

原生字符采用带索引空间声明的来源区间。叶节点互斥拥有字符；列表、强调框和图表容器
通过成员 ID 引用叶节点，不重复保存另一份“拥有”的正文。视觉行与逻辑段落分别保存，
阅读顺序和跨页续接使用 ID / SourceReference 表达，不能用全文字符串作为关联键。

2026-10-12 的 P0 包已保存实验性 `source-layout.json`，协议见
[来源布局补充 Schema](../packages/document-contracts/schemas/pdf-source-layout.schema.json)。
它使用 PDFium text-page 字符索引，仍不等于正式 Reader IR；正式协议冻结时需要迁移映射。

---

# 13. PhysicalBlockType

```text
text
title
heading
list
image
table
equation
code
caption
footnote
header
footer
page_number
reference
unknown
```

---

# 14. Semantic Layer

Semantic Block 表示一个逻辑阅读单元，包含：

- 在当前 parse run 内唯一、稳定的 `id`，块类型、顺序、所属章节。
- 不可变的 `sourceContent`，由文本、嵌套格式、保护对象或图表等结构组成。
- 一个或多个 `provenance` 引用、内容 fingerprint、诊断和适用的 parser 评分。

解析产物不原地覆写译文。每次 TranslationRun 独立保存配置快照和按块 / 子单元绑定的结果，Reader 在读取时合成展示状态。这样更换模型、重译单块或重解析时不会覆盖其他版本的内容。

Reader SemanticBlock 不等同于 SDK TranslationBlock。figure、equation、reference 等无需强行变成文本，详见 §54–55 的投影边界。

---

# 15. SemanticBlockType

```text
document_title
authors
abstract
heading
paragraph
list
figure
figure_caption
table
table_caption
equation
code
algorithm
footnote
reference
acknowledgement
appendix
```

---

# 16. Provenance

每个 Semantic Block 都必须知道：

> 自己来自 PDF 哪里。

例如：

```json
{
  "pageIndex": 4,
  "bbox": [
    0.08,
    0.21,
    0.47,
    0.49
  ],
  "physicalBlockId": "raw-492"
}
```

如果跨页：

```json
[
  {
    "pageIndex": 4
  },
  {
    "pageIndex": 5
  }
]
```

这样未来可以：

```text
中文段落
 ↓
查看 PDF 原位置
```

---

# 17. Inline Span

Paragraph 不能只是字符串。Reader 行内结构至少区分：

- 可翻译 text。
- 可嵌套的 emphasis / strong / link 等 format，包含 children。
- inline_math、citation、code、identifier 等 protected 对象。

链接地址、引用 targetId、资产 ID 和源码位置由 Reader 绑定数据保存；向 SDK 投影时只传格式类型、块内对象 ID 和必要的保护内容。SDK 当前模型与 schema 是翻译协议的依据，不在 Python 中另定义不兼容的扁平 InlineSpan。

需要保留颜色、下划线等具有解释作用的局部样式时，由应用保存受限的样式绑定，向翻译层
传对象 ID 和格式边界，译后按绑定恢复。补全题目的空白线是保护对象，不能作为可删除的
普通装饰。translation-core 0.4.0 已支持 `underline` / `style` 格式和 literal 保护，
插件 0.4.3 从 P0 HTML 恢复受限颜色、下划线、占位变量和答题线；具体 CSS 不发送给模型。
P0 包仍是未翻译原文，正式 Reader 与 SDK 的适配及 PDF 翻译任务管线仍待实现。
格式嵌套和保护对象次数要校验，但不能统一禁止译文调整行内对象顺序。

---

# 18. 示例

原文：

```text
We minimize L(θ) following Vaswani et al. [12].
```

IR：

```json
[
  {
    "type": "text",
    "text": "We minimize "
  },
  {
    "type": "inline_math",
    "latex": "L(\\theta)"
  },
  {
    "type": "text",
    "text": " following Vaswani et al. "
  },
  {
    "type": "citation",
    "text": "[12]",
    "targetId": "ref-12"
  }
]
```

Translation Engine：

```text
我们按照 Vaswani 等人的方法 ⟦A1⟧ 最小化 ⟦A0⟧。
```

恢复后：

```text
我们按照 Vaswani 等人的方法 [12] 最小化 L(θ)。
```

---

# 19. Document IR

后续在 `packages/document-contracts` 中定义版本化 ReaderDocument，概念结构如下；此处不是已经实现的 API：

```text
schemaVersion
sourceKind: pdf | latex
id / sourceHash / parseRunId
parserInfo / normalizerVersion
metadata / sections / blocks / assets
source metadata / warnings
```

PDF 增加 pages / coordinateSpace；LaTeX 增加项目文件 manifest 与源码位置映射。SourceReference 为有 discriminator 的联合类型，不要求 LaTeX 段落提供 PDF 坐标。

Reader IR 规范生成或约束 Python 与 TypeScript 模型，采用同一组 JSON fixtures 验证。真实 parser benchmark 后确定必需字段和缺失策略；当前 `translation-core` 已有的 TranslationDocument 保持纯翻译语义，不承载完整 Reader 或作业状态。

---

# 20. Schema Version

Reader 协议规划使用 `reader-ir/1`，原始 PDF adapter 协议单独版本化。字段变化必须有迁移、拒绝不支持版本或明确重解析的行为，不能静默解释成不同含义。

IR schema、parser、模型权重、normalizer、翻译 prompt / protection 与 SDK 包版本分别记录；一个 SDK semver 不能替代全部缓存依赖。

---

# 21. PDF Parse Pipeline

完整 Parser Pipeline：

```text
PDF
 ↓
PDF Classifier
 ↓
Primary Parser
 ↓
Parser Adapter
 ↓
Raw Blocks
 ↓
Page Furniture Removal
 ↓
Reading Order Normalization
 ↓
Text Normalization
 ↓
Paragraph Reconstruction
 ↓
Cross-page Merge
 ↓
Section Reconstruction
 ↓
Figure/Table Association
 ↓
Reference Detection
 ↓
Inline Span Construction
 ↓
Document IR
```

---

# 22. PDF Classifier

分类：

```text
born-digital
scanned
hybrid
unknown
```

V1：

```text
born-digital
```

属于正式支持。

---

# 23. Classification Heuristic

可以使用 PyMuPDF 统计：

```text
text characters per page
image coverage
number of text blocks
```

例如：

如果：

```text
连续多页
文字字符数量极少
+
整页大图
```

判断：

```text
likely scanned
```

提示：

```text
This PDF appears to be scanned.
OCR support is experimental in V1.
```

---

# 24. Header/Footer Removal

重复出现的会议名、作者、页码可能属于 page furniture。顶部 / 底部区域、重复频率、页面序列和版面类型可用作候选特征；原稿中的 10–12% 区域和 30% 重复率仅是待评测起点。

这些条件不能单独触发删除：短论文、重复章节标题、脚注和跨页表头可能满足同样规则。结合类型、位置与正文关系确认，保留原始 physical blocks 和变换记录；无法确认时保留并标注，不静默丢弃内容。

---

# 25. Page Number

识别：

```text
4
- 4 -
Page 4
IV
```

如果位于页顶部/底部，并满足 page sequence：

删除。

---

# 26. Text Normalization

普通正文可处理已确认的 ligature、软连字符、行折返和排版空白。保留原始 parser 输出与归一化版本 / 记录。

不能对全部内容统一使用破坏性 Unicode 兼容归一化或空白折叠。公式、代码、标识符、Greek letters 和 Unicode math 走保护路径；数字、符号与有意义空白保持。文本清理前先识别类型，不能用清理步骤掩盖 parser 遗漏或错误。

---

# 27. Hyphenation

PDF 常出现：

```text
trans-
former
```

应恢复：

```text
transformer
```

但：

```text
state-
of-the-art
```

不能粗暴处理。

原则：

> dehyphenation 必须保守。

推荐：

只有在：

```text
上一行以 alphabetic- 结束
+
下一行以 lowercase 开头
+
Parser 明确表明是 line wrap
```

才考虑自动合并。

如果不能确定：

保留原文。

---

# 28. Reading Order

这是 Parser 质量最重要的指标之一。

对于：

```text
Column A
Column B
```

必须得到：

```text
A1
A2
A3
B1
B2
B3
```

不能：

```text
A1
B1
A2
B2
```

优先信任 Parser reading order。

P0 检查所选 parser / backend 是否实际提供阅读顺序与 debug 信息，并生成统一的定位图供人工确认。缺少该能力时明确记录，不依赖某一版本的默认输出假设。

---

# 29. Reading Order Normalizer

如果 Parser 没有可靠 reading order：

使用：

```text
column detection
+
bbox
+
section geometry
```

但 V1 不要求自己重新实现完整 layout model。

优先：

> 选择 reading order 足够好的 Parser。

---

# 30. Paragraph Reconstruction

Parser 原始 block ≠ semantic paragraph。

必须增加：

```text
ParagraphAssembler
```

---

# 31. Merge Conditions

两个连续 raw text blocks 可以合并，如果：

```text
type compatible
same section
same column / compatible geometry
font style compatible
first block does not terminate paragraph
second block is not heading/list/caption
```

---

# 32. Cross-page Merge

跨页段落在有足够证据时合并，保留每个原始块及对应页面 / bbox。候选应在正文阅读顺序中相邻、章节兼容、排版连续，且不存在标题、列表、图注、脚注或引用区域切换。

无句号、下一段以小写开头只是线索，不能单独推出“必须合并”。多栏页面按逻辑阅读流判断，不简单拼接每页最下面和下一页最上面的块。无法确认时保持分块并给出诊断；通过 golden 标注分别记录漏合并和错误合并。

---

# 33. 不应合并

例如：

```text
... as shown below.

2. Related Work
```

不合并。

---

# 34. Section Reconstruction

建立：

```text
Section Tree
```

例如：

```text
1 Introduction

2 Related Work
  2.1 Retrieval
  2.2 Generation

3 Method
  3.1 Architecture
```

IR：

```text
Section
 ├ heading
 ├ paragraph
 ├ paragraph
 └ subsection
```

---

# 35. Section ID

例如：

```text
sec-1
sec-2
sec-2-1
```

或者 UUID。

所有 paragraph：

```text
section_id
```

指向对应 section。

Translation Engine 可以获得 section context。

---

# 36. Figure

Figure Block：

```python
class FigureContent:

    asset_id: str

    caption_block_id: str | None

    alt_text: str | None
```

图片：

> 不翻译。

caption：

> 翻译。

---

# 37. Figure Asset

默认保留原 PDF 的 figure / chart 主体外观，以原件区域高清图展示，点击可放大。
caption / footnote 保持独立文本，可以翻译。Parser 提供定位，不能将图中文字、
箭头、颜色或曲线重新生成后当作原图；被误分类为 table 的示意图也按原件展示。

当前 P0 使用 PDFium 在已经旋转和裁剪的页面视口渲染，再根据对应坐标裁剪，
默认 216 dpi / PNG；保留原页、bbox、渲染比例、边缘留白和资产 checksum。
Parser 的 sidecar 仅在确认是原件裁剪且足够清晰时复用。定位不可靠时提供原页
降级入口并显示诊断，不能猜测区域或保证没有裁掉未识别的标注。

---

# 38. Table

Table 必须单独处理。

```python
class TableContent:

    structured: TableStructure | None

    image_asset_id: str | None

    caption_block_id: str | None

    confidence: float | None
```

---

# 39. Table 双轨制

V1 默认使用 `Original Table Image`，与 figure / chart 一样直接保留原 PDF 区域。
单元格、公式、合并结构、线条和颜色不依赖 OCR / HTML 重建。表题和表下注释
保持独立文本；图中的 cell / label 默认不翻译，也无法在图内直接选取文字。

`Structured HTML Table` 是后续显式选择的视图，只有经过结构校验后才展示和翻译。
即使 Parser 输出了结构化表格，默认阅读图仍为原件；结构数据保留在 IR 中供检索、
助手和未来视图使用，失败不影响原表可读。

原则：宁愿保留英文原表格，也不要生成结构错误的中文表格。

---

# 40. Structured Table Translation

本节用于后续显式启用的结构化表格视图；V1 默认保留原表区域图，不调用此流程。

只翻译自然语言 cell。

不翻：

```text
numbers
formula
model name
dataset name
metric abbreviation
identifier
```

例如：

```text
Model | Accuracy | Parameters
```

可以：

```text
模型 | Accuracy | 参数量
```

具体术语仍由 glossary 决定。

---

# 41. Table Caption

始终正常翻译。

---

# 42. Equation

Display Equation：

```python
class EquationContent:

    latex: str | None

    image_asset_id: str | None

    source_text: str | None
```

---

# 43. Equation Render

排版成功不代表识别成功。公式可能被误分类到普通 text；渲染前同时检查文本
中的异常控制字符、未映射字体字形和不确定的数学标记，不只统计 LaTeX 排版失败。
有疑问时保留原 PDF 区域并提示，不能通过删除未知符号假装修复条件、括号或上下标。
P0 对不确定的问号下标采用原件回退；这不是“所有问号下标都是错误”的规则。

优先：

```text
LaTeX
↓
KaTeX / MathJax
```

如果公式识别失败：

```text
PDF crop image
```

不要让 LLM 修公式。

---

# 44. Inline Math

同样：

```text
placeholder
```

绝不翻译。

---

# 45. Code / Algorithm

普通 code 保留换行、缩进与背景。无法可靠重建的 algorithm 在 V1 默认使用原 PDF
区域图，包含外框、浮动标题、行号、缩进与公式，点击可放大；原件、结构文本和
诊断仍保存在 IR，不能用图片替换或覆盖 canonical source。区域内暂不提供直接
选字 / 翻译，与图表相同；未来可靠的结构化算法视图单独开启。

Code：

```text
passthrough
```

Algorithm 中：

- code
- pseudocode symbol

保持。

自然语言说明：

可以翻译。

第一版如果拆分困难：

> algorithm 整体保留原文。

稳定优先。

强调框 / 定义框 / 示例框 / sidebar 也是语义容器，应保留容器边界、标题、背景
和有序成员；普通段落仍作为 HTML 文本展示和翻译。Parser 未保留背景时可从原
PDF 的绘制区域补充，必须记录坐标与方法并验证，不能把图表内的色块包成正文。
跨页容器与未知装饰保留来源及诊断，不依据背景颜色单独改变正文身份或删除内容。

缩进要分别表达首行缩进、整段缩进、列表层级和框内相对缩进，并以当前栏或容器的
正文边界为基准。列表项可以包含段落、公式、例子和子列表，不能因为中间出现一个普通
文本块就结束列表。章节目录层级、术语的一项一行，以及标签 / 值示例应保存各自的
结构；原 PDF 的硬换行不能一概当作逻辑段落分隔。重组前验证文本完整覆盖，校验失败时
保留原节点并记录原因，避免部分重组造成丢文。译文行数和断行可以随语言、字体和视口变化。

---

# 46. Footnote

Footnote：

正常翻译。

显示在正文下或 section 尾部。

必须保留与正文 anchor 的关联。

---

# 47. References

V1：

> 完全不翻译 bibliography。

例如：

```text
Vaswani et al. Attention Is All You Need.
```

保持英文。

原因：

- 搜索论文方便
- 标题原文有价值
- DOI/URL 安全
- 翻译收益很低

---

# 48. Citation

正文：

```text
[12]
[12, 14]
Vaswani et al. (2017)
```

保持。

---

# 49. Reference Section Detection

优先：

```text
heading = References
Bibliography
```

并结合：

```text
citation density
DOI
year pattern
author-like text
```

识别 bibliography blocks。

---

# 50. Assets

资产记录 ID、类型、MIME、内容 hash、尺寸、所属 parse run 与来源引用。服务器内部存储相对路径，Reader API 只暴露受控 assetId / 访问路由，不信任 parser 输出的任意绝对路径或 URL。

figure、table_image、equation_image 都可以作为可靠降级资源。保留裁剪参数与来源，避免重新解析后同名文件被覆盖。SVG / HTML 等主动内容须经过受限转换或清洗，不能直接注入 Reader。

---

# 51. Block ID

Semantic Block ID 在一个不可变 parse run 内稳定且唯一，用于 Reader、重译请求和来源映射。解析器版本或阅读顺序变化时可以产生新 ID；不能把 `hash(document + text + order)` 当作跨版本稳定身份。

相同文本重复出现时仍需不同块 ID；因此 ID 与内容 fingerprint 分开。Translation Cache 不依赖 parseRunId、pageIndex、顺序或旧 blockId；读取后根据当前映射重新绑定，并检查保护结构和语义依赖兼容。

---

# 52. Block Fingerprint

对确定性序列化的语义内容和保护结构求 SHA-256，保留数字、标点、代码、公式及有意义空白。排除会话 ID、随机对象 ID和展示坐标；用块内规范化对象顺序与内容表示保护关系。

Fingerprint 只是完整翻译 key 的一个输入，不单独决定可复用性。章节 / 邻段上下文或术语改变时，文本相同也可能需要重新翻译，见 §81。

---

# 53. 翻译 Engine

沿用浏览器插件项目的原则：

```text
Document Analyzer
Glossary
Protection Layer
Batch Translation
Validation
Retry
Cache
```

---

# 54. Translation Core 复用策略

**直接运行现有 TypeScript SDK，不在 Python 中重写翻译管线。**

```text
Python parser / normalizer
          ↓ Reader IR + assets
TypeScript document-service
          ↓ 投影
@pagelingo/translation-core
          ↓ 校验后的结构化译文
按映射回填 TranslationRun → Reader
```

SDK 统一维护提示词、Provider 契约、格式 / 原子保护、校验、预算 / 重试以及后续上下文、术语和缓存语义。宿主应用实现存储适配、持久化任务、密钥与运行生命周期。

仅共享 prompt / JSON 资源而各写一套 Python / TypeScript pipeline，不满足“升级一个 SDK，各应用共同改进”的目标。SDK 内的资源可以随包版本发布；现阶段不另建平行 `shared/prompts` 或 `translation/*.py`。

当前翻译 SDK 为 0.3.0，M2 的真实 API、预算、重试、缓存和检查点契约以及 M3 个人术语已实现；助手 SDK 为 0.2.0，已有选区问答、上下文预算和对话摘要。自动文档分析、动态术语和论文级上下文属于后续共享能力；接入时需分别验证实际解析质量与模型效果。

---

# 55. Translation Request Contract

适配层将 Reader 内容投影为 SDK 的 `TranslationDocument`：

```json
{
  "id": "document-run",
  "title": "Example paper",
  "sourceLanguage": "en",
  "blocks": [{
    "id": "paragraph-39",
    "kind": "paragraph",
    "sectionPath": ["Methods", "Optimization"],
    "content": [
      {"type": "text", "text": "We minimize "},
      {"type": "protected", "id": "loss", "kind": "math", "source": "L(θ)"},
      {"type": "text", "text": "."}
    ]
  }]
}
```

目标语言与 profile 通过 SDK options 设置。Provider 收到的 instructions / data / responseSchema 由 SDK 生成，而非 Reader 自行拼接。具体类型以 SDK 的公开导出为准。

标题 / 摘要 / 脚注等投影为适用的 SDK 块，保留 Reader 反向映射；默认表格主体保留原图，只翻译独立表题 / 注释。未来显式启用且通过结构校验的表格视图可拆为 table-cell 单元。图像、独立公式、参考文献、作者信息和不可靠结构原样保留，不发给翻译。长段落的内部切分与重组由翻译层处理，不改变 Reader 对语义段落的身份。

PDF 坐标、服务器路径、API Key、作业状态不进入 SDK 文档。未来 glossary / analyzer 的扩展必须通过 SDK 的统一 API，不能在 PDF 服务另造并行协议。

---

# 56. Translation Unit

默认：

```text
semantic paragraph
```

Heading：

单独。

Caption：

单独。

Footnote：

单独。

Table：

单独 pipeline。

---

# 57. Translation Batch

批处理由 SDK 按输入、预期输出与上下文总 token 预算决定，块数仅作为次级上限。以下是 P0 / 接入时待测的起点，不是所有模型的通用容量：

```text
约 5~20 blocks
```

或者：

```text
2000~5000 input tokens
```

根据实际 token estimator。

---

# 58. Translation Context

每一 batch 提供：

```text
paper title
abstract summary
domain
section heading
document glossary
previous nearby context
```

不要把整篇论文重复放入 prompt。

---

# 59. Document Analyzer

解析结束后先读取：

```text
title
abstract
section headings
前若干正文
```

生成：

```text
domain
summary
glossary
special entities
```

---

# 60. Glossary

沿用浏览器产品：

```text
keep
translate
prefer-source
first-bilingual
```

例如：

```text
Transformer → keep（仅 machine-learning 领域）
PyTorch → keep
token → prefer-source
prompt → prefer-source
gradient descent → 梯度下降
```

---

# 61. Placeholder

统一使用现有 SDK 的编码：原子槽位 `⟦A0⟧`，成对格式 `⟦S1⟧` / `⟦E1⟧`。math / citation / code 的类别放在保护对象数据中，不另定义 `MATH_0001` 等第二种协议。

Reader / parser 提供语义行内结构，SDK 完成确定性编码、源文本保留标记转义、输出校验和本地还原。格式内部自然语言可翻译；不可变对象从原输入恢复。缓存记录 protectionVersion，协议改变时按依赖失效。

---

# 62. Translation Validation

必须检查：

```text
block ID
placeholder completeness
placeholder duplicates
unknown placeholder
protected terminology
empty translation
```

---

# 63. Translation Quality 原则

优先级：

```text
技术准确
>
术语一致
>
完整表达
>
中文可读性
>
文学润色
```

---

# 64. Reader 数据模型

Frontend 不直接加载 HTML 文件。

推荐：

```text
GET /documents/{id}
```

获得：

```json
{
  "metadata": {},
  "sections": [],
  "blocks": []
}
```

React 生成 HTML。

这样：

- 原文模式
- 中文模式
- 对照模式

全部共享同一套数据。

---

# 65. Reader Component

推荐：

```text
DocumentReader
 ├── ReaderToolbar
 ├── DocumentHeader
 ├── Outline
 └── Section
      ├── HeadingBlock
      ├── ParagraphBlock
      ├── FigureBlock
      ├── TableBlock
      ├── EquationBlock
      ├── CodeBlock
      └── FootnoteBlock
```

---

# 66. Paragraph UI

默认：

```text
中文译文                                  原文
```

其中：

```text
原文
```

是低视觉权重按钮。

点击：

```text
中文译文

Original
English paragraph...
```

---

# 67. Source Reveal

状态：

```ts
expandedOriginalBlocks: Set<BlockId>
```

用户只展开自己关心的几个段落。

无需整篇切换。

---

# 68. Bilingual Mode

设置：

```text
displayMode = bilingual
```

所有 blocks：

```text
source
translation
```

同时显示。

---

# 69. Source Style

原文可稍微降低视觉权重：

```css
opacity: 0.78;
font-size: 0.96em;
```

但：

不要过度弱化。

因为原文是真正的技术参考。

---

# 70. 原文与译文必须保持近距离

禁止：

```text
左边一整篇英文
右边一整篇中文
```

如果位置不同步，会增加阅读成本。

优先：

```text
paragraph pair
```

---

# 71. Desktop Optional Split

V1 可以暂缓。

V1.1 可以增加：

```text
English | Chinese
```

左右两栏。

但仍然：

> 使用 block alignment，而不是 page alignment。

---

# 72. Outline

左侧：

```text
Abstract
1 Introduction
2 Related Work
3 Method
4 Experiments
5 Conclusion
References
```

点击滚动。

---

# 73. Search

V1 推荐支持浏览器自带页面搜索即可。

后续增加：

```text
search English
search Chinese
```

---

# 74. PDF Fallback

Toolbar：

```text
查看 PDF
```

打开：

```text
PDF viewer modal
```

或者新 tab。

---

# 75. Block → PDF

建议 V1 后半段实现。

Paragraph hover：

```text
查看原页
```

利用 provenance：

```text
page index
```

打开对应页。

不要求 bbox overlay。

V1.1 可以增加 block highlight。

---

# 76. 翻译错误快速处理

Paragraph hover：

```text
原文
重译
```

`重译`：

```text
cache bypass
+
same document context
+
current glossary
```

重新生成该 paragraph。

这是非常有价值的小功能。

---

# 77. 后续可加“修改术语”

例如用户看到：

```text
token → 词元
```

希望：

```text
token
```

可以：

```text
Add to document glossary
```

然后：

```text
retranslate affected blocks
```

放 V1.1。

---

# 78. Cache Architecture

四层数据分别管理：原始输入、解析结果、文档分析、翻译结果。

Source Cache 对 PDF 原始 bytes 求 SHA-256，保存不可变源文件，不代表存在可复用的解析或翻译结果。

Parse Cache key 包含 sourceHash、所选页范围、parser / adapter 版本、backend、实际模型权重 revision、生效解析选项（含 OCR / VLM）、normalizerVersion 和 IR schemaVersion。保存不含译文的 Reader IR 与资产 manifest。页范围不完整时不能作为全文解析命中。

失败 / 未完成的产物不冒充成功缓存，旧 parse run 保留以便审阅和回滚。模型下载、网络解析与纯本地解析需明确区分，不能静默上传整份 PDF。

---

# 79. Parse Cache 极其重要

用户切换：

```text
GPT model
translation prompt
target language
```

不应该重新跑 PDF parser。

PDF parsing 与 translation：

> 必须完全解耦。

---

# 80. Document Analysis Cache

Key 包含实际分析输入 / 采样策略 hash、输入语言、Provider 身份与规范化 endpoint、model、生效生成配置、analysisPromptVersion、分析结果 schema 和实际依赖的术语策略。

Value 包含经过校验的领域、有限摘要、候选术语与诊断，标注分析版本。输入有界，不宣称采样分析理解全文。失败可降级为基础领域词表；分析模型或输入变化不会错误复用旧结论。

---

# 81. Translation Cache

沿用 SDK / 网页规格的完整缓存语义：

- 确定性语义内容及保护结构。
- sourceLanguage / targetLanguage、翻译 profile。
- Provider 身份、规范化 endpoint、model、实际生成配置。
- promptVersion / protectionVersion、结果 schema。
- 生效领域与实际提供的文档 / 章节 / 邻段上下文签名。
- 当前单元实际依赖的术语内容、目标译法、领域与策略 hash。

不把 API Key、pageIndex、parseRunId、旧 blockId 或随机占位符 ID 放入内容身份。保存可绑定到当前输入的结构化结果；命中后重新绑定 ID / 保护对象并校验，不能把旧映射直接渲染。

缓存写失败不阻止已校验译文展示。只有依赖不变时，才能期待修改三个块仅重译三个块；上下文变化也可能合理使相邻块失效。重译显式绕过读取，保留运行来源和替换规则，迟到任务不得覆盖新结果。

---

# 82. 静态阅读快照与离线包

持久化原文 IR、结构化译文与资产，同时允许预生成完整 HTML 阅读快照。用户可在当前有资源的机器完成解析、翻译、渲染，将产物导入服务器；重复阅读不重新解析或翻译。具体边界见 [本机处理与产物设计](pdf-processing.md)。

快照包括 HTML、阅读数据与全部必需 CSS / 脚本 / 字体 / 图片，使用可重绑的本地资源引用；导出 ZIP 可离线阅读。公式可以预排版，不能仅保存依赖外部 CDN 的页面。普通论文是否单页取决于渲染后 DOM / 公式负载；长书按章节组织，实际展示按页或有限的段落窗口加载，关闭旧窗口释放 DOM。不能把整本或很长的章节隐藏在折叠容器里当作按需加载。导出包含全部阅读分片，共享 CSS / 字体只存一份。

HTML 是可重建产物，不替代原文 / 译文 IR。快照身份绑定 parse run / IR hash、translation run / 译文 hash、renderer / 资源版本及渲染选项。仅改样式或渲染器时重新生成快照，不调用 parser 或 LLM；改变实际翻译依赖按 §81 缓存语义处理。

服务器维护 PostgreSQL / ObjectStore 的业务依据；本机离线处理使用阶段文件和 manifest，导入时校验并登记，不维护需要双向同步的另一套业务数据库。助手、对话历史、重译与恢复通过后端提供，凭据不进入静态包。

---

# 83. Document Dedupe

同一 PDF bytes 命中只表示原文件已存在。服务分别检查有效 parse run、分析配置与翻译缓存，才能选择打开已有结果、补齐失败块、重新翻译或重新解析。

只有文件、页范围、解析依赖和翻译依赖全部兼容且结果完整时，才能实现 `0 parse / 0 translation`。切换模型通常保留解析结果；更换 parser / normalizer 时新建 parse run，不能静默覆盖已验证旧结果。

---

# 84. Storage

V1 是单用户、可在本机或服务器部署的应用。状态由后端持久化，浏览器提供 UI 与临时展示状态；清空浏览器数据或换浏览器不会删除服务器上的论文、译文和对话。

```text
PostgreSQL
+
ObjectStore interface
  └─ 首版 LocalObjectStore：可配置的持久化磁盘目录
  └─ 后续 S3-compatible adapter：对象存储
```

SQLite 可用于一些单服务器应用；此项目采用 PostgreSQL，是为了统一开发 / 部署数据库、迁移、事务及任务领取行为，减少后续两种数据库的维护成本。[SQLite 适用场景](https://sqlite.org/whentouse.html)

数据库负责可查询、需事务更新的状态：文档与运行版本、任务 / 检查点、按块译文 / 缓存、术语、对话和阅读进度。原 PDF、raw parser 输出、完整 source IR、图片及资产 manifest 作为不可变对象保存，数据库记录其 ID、对象 key、大小、媒体类型和 SHA-256。

ObjectStore 在文档服务中实现。业务层通过对象 ID / key 读写，不直接调用散落的 fs 操作；接口至少覆盖不可变写入、metadata / checksum 查询、流式读取 / 范围读取和删除。LocalObjectStore 把 key 映射到受控根目录；未来 S3 adapter 用相同 key，但需要独立验证其条件写入、校验和范围读取行为。不能只改配置就假定旧文件已迁移。

数据库 repository 与对象存储 adapter 属于 `apps/document-service`；现有 SDK 继续只消费缓存、检查点与 ConversationStore 接口，不引入 PostgreSQL 或文件系统依赖。Reader / API 协议只暴露文档和资产 ID，不包含绝对路径、bucket 凭据或数据库连接信息。

---

# 85. 文件结构

运行数据与源码 / 容器镜像分开。配置 `PAGELINGO_DATA_DIR` 为运行根目录，首版本机可使用 gitignored 的 `data/`，服务器映射到持久化磁盘卷。以下是本地 adapter 的布局示例，不是数据库或公共协议中写死的路径：

```text
PAGELINGO_DATA_DIR/
  objects/
    sources/{hashPrefix}/{sourceHash}.pdf
    parses/{parseRunId}/
      raw.json
      reader-ir.json
      assets/{assetId}.{extension}
      manifest.json
    snapshots/{snapshotId}/
      index.html
      reader-data.json
      chapters/
      assets/
      manifest.json
  work/{jobId}/{leaseEpoch}/
  models/
```

`objects/` 是需要备份的原件与解析产物；`work/` 是任务私有的可清理临时目录；`models/` 是可重新获取、按模型 revision 管理的缓存。PostgreSQL 使用独立持久卷，数据库连接由 `DATABASE_URL` 提供，不把其数据目录塞进 ObjectStore。

原文件 key 基于源 bytes 的 hash，原始文件名作为数据库展示字段。parse run 与 translation run 使用独立 ID，覆盖不了其他成功版本。译文和运行配置保存于数据库，提供导出时再生成文件；不能同时将 blocks.json 与数据库都当作可变译文的主存储。

阶段产物先在任务目录生成并校验，再写入不可变对象；确认对象存在且 checksum 匹配后，在数据库事务中提交 blob / manifest 引用、运行状态及事件。文件 / 对象与 PostgreSQL 不组成跨存储事务：对象写成功、数据库提交失败可能留下孤立文件，由带宽限期的清理任务回收；数据库不能先声称解析完成再写必需文件。

ObjectStore 的不可变对象在数据库引用释放后才进入清理候选；删除文档先取消任务并记录删除状态，禁止迟到结果重新挂回资产。共享原件 / 缓存检查剩余引用，不因删除一篇文档而误删仍在使用的对象。

---

# 86. PostgreSQL 数据模型

以下是拟定的持久化边界，字段与索引在 P1 落实，不代表数据库已创建：

| 表 / 数据组 | 职责 |
| --- | --- |
| documents | 稳定文档 ID、来源类型 / hash、标题、当前解析与译文运行 |
| blobs / parse_assets | 存储 backend、对象 key、checksum、大小、媒体类型及资产引用 |
| parse_runs | parser / 模型 / normalizer / IR 版本、配置、状态、IR / manifest 引用与诊断 |
| render_snapshots | 输入 parse / translation run、内容 hash、renderer / 资源版本、快照 manifest 与状态 |
| translation_runs / translation_blocks | 配置快照、输入 parse run、按块状态与已校验结构化译文、用量及 SDK 检查点 |
| translation_cache | SDK 的实际依赖 key、可重绑的校验结果和缓存访问记录 |
| jobs / job_events | 持久化调度、取消、lease / heartbeat、恢复进度与有界事件日志 |
| conversations / conversation_messages | 按 documentId 保存消息、完整选区、摘要、草稿及并发版本 |
| reading_states / glossary_entries / settings | 阅读位置 / 模式、个人术语、非密钥设置 |

领域字段、关系和需检索 / 索引的状态使用普通列；Reader 内联树、译文树、配置快照及 SDK 检查点使用版本化 JSONB。完整 source IR 作为不可变对象，不要求把全部来源块拆成关系表。

外键、唯一约束和版本条件保证结果对应正确的 document / parse / translation run；任务幂等键、对象 key 和翻译结果绑定建立相应唯一约束。数据访问集中在 repository，使用有版本的数据库迁移；API 与 worker 必须使用兼容 schema，迁移由单独受控入口执行，不由各 worker 并发修改。

论文身份不使用 localhost URL、浏览器 tabId 或容器绝对路径。助手使用稳定文档 key 与独立 revision，旧引用保留其正文快照及 parse run。ConversationStore 以 expectedVersion 条件提交；不同页面 / 进程不能覆盖更新的消息。客户端的 IndexedDB / localStorage 仅用于可丢弃缓存，不成为网站历史的唯一存储。

---

# 87. Documents Table

字段：

```text
id
source_hash
original_filename
title
page_count
status
created_at
updated_at
```

---

# 88. Jobs

区分作业状态与处理阶段：

```text
status: queued | running | cancelling | cancelled | completed | partial | failed
stage: classifying | parsing | normalizing | analyzing | translating | finalizing
```

任务至少保存 jobId、documentId、parseRunId / translationRunId、输入版本、配置快照、worker lease / heartbeat、attempt / 最大尝试数、取消意图、检查点、错误类别和进度计数。

译文按单元另存 pending / inflight / completed / failed 等状态；取消后保留已提交成功结果。部分失败进入 partial，不能将 170 / 200 块成功报告为全文翻译完成。

---

# 89. Job Progress

状态快照包含 stage、已完成 / 总数、失败与跳过数量、当前 run ID 和事件序号。翻译单元、语义段落、API 请求分别计数，不混为同一个进度。

Parser 提供真实页计数时显示页进度；没有可靠进度时显示“正在解析”及耗时，不伪造 38% 等百分比。`ready` 阅读能力与翻译完成分开：原文 IR 提交后即可阅读，翻译可以继续或部分失败。

---

# 90. Progress Protocol

SSE 用于增量通知，数据库状态快照是恢复依据。事件包含 jobId、runId、递增序号与阶段 / 单元变化。

客户端重连携带 Last-Event-ID；若历史不可重放，获取最新快照再订阅。提供轮询状态兜底，去重迟到事件。页面关闭不取消任务；取消必须有显式请求和持久化意图，停止解析子进程或模型请求后记录结果。

---

# 91. API

规划接口（PDF 阶段再实现）：

```text
POST /api/documents                         上传、校验、去重并创建任务
GET  /api/documents                         本地文档列表
GET  /api/documents/{id}                    metadata / 当前运行版本
GET  /api/documents/{id}/content            Reader IR + 已提交译文
GET  /api/documents/{id}/source.pdf         原 PDF
GET  /api/documents/{id}/assets/{assetId}    受控资产访问
POST /api/documents/{id}/translate          创建 translation run
POST /api/documents/{id}/blocks/{blockId}/retranslate
GET  /api/jobs/{jobId}                      恢复用状态快照
GET  /api/jobs/{jobId}/events               SSE
POST /api/jobs/{jobId}/cancel
```

重译请求包含所基于的 parse run / 内容版本；输入过期时拒绝或明确重新绑定。创建任务支持请求幂等键，不能通过重复点击无界叠加计费任务。V1 为单用户、可部署服务器的应用；服务器访问需认证，注册 / 团队 / 多用户数据隔离另行设计。网站助手的对话、摘要、选区与阅读位置由后端按稳定 documentId 保存。

---

# 92. Upload

```text
POST /api/documents
multipart/form-data
```

Backend：

```text
validate
hash
dedupe
save
create job
```

---

# 93. PDF Validation

检查：

```text
PDF magic bytes
file extension
file size
page count
encryption
```

---

# 94. Encrypted PDF

如果需要密码：

V1：

```text
Unsupported encrypted PDF
```

或者以后支持 password input。

---

# 95. File Limits

文件 bytes、页数、解码后像素 / 内存、解析时限、资产总量和排队数量分别限制。100–200 MB / 500 页是原稿的容量预算候选，不代表已经验证支持的默认值或质量范围。

P0 在目标机器测量冷启动、模型占用和最坏样本后，确定配置默认值与硬上限。先验收常见单 / 双栏论文；超限或加密 / 损坏输入给出明确状态，保存原件但不无限重试。

---

# 96. Parser Worker

PDF parser 很重。

不要直接运行在 HTTP 请求处理路径或阻塞 Node 事件循环。

建议：

```text
API
 ↓
Job
 ↓
Worker
 ↓
Parser
```

---

# 97. V1 Worker

V1 使用 PostgreSQL 任务表与单个 worker。领取任务在短事务中按队列顺序锁定待运行记录，例如 `FOR UPDATE SKIP LOCKED`，更新状态、lease owner / epoch、截止时间后提交；长时间解析与模型调用在事务外进行。PostgreSQL 文档将这种锁跳过方式列为队列表的适用场景。[官方说明](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

heartbeat 延长当前 lease；超时后的恢复检查已提交阶段 / 批次和缓存，再按剩余尝试预算领取。结果提交同时检查 run ID、输入版本、当前 lease epoch、未删除与未取消状态，旧 worker 即使之后返回也不能覆写新运行。API 重启或浏览器关闭不取消翻译任务，显式取消意图写入数据库。

API 进程不执行长时间解析。Python parser 是子进程，记录退出码 / 超时 / 资源限制，取消时终止其工作；翻译由 TypeScript worker 调用 SDK。重试按错误分类，认证错误不重复请求，所有层共享有界预算。

缓存、SDK 检查点、块结果、完成计数与对应事件尽量在同一 PostgreSQL 事务提交，源文件和解析对象通过 manifest 校对。数据库提交及任务领取不能保证网络故障下恰好一次模型计费。

这些能力从上传 / 解析第一条链路开始实现，不等到后续 UI 完成才补任务模型。

后续扩到多个 worker 时，须补充跨进程的 endpoint 并发槽位、冷却和重试预算；SDK 的进程内 scheduler 不能直接作为分布式限流。第一版保持单 worker，部署单元与数据接口保留可拆分边界。

## 97.1 部署、配置与访问

首版交付本机与单服务器的 Compose 部署说明；规划服务为 web / 反向代理、API、worker、PostgreSQL。API 和 worker 可使用同一 TypeScript 工程的不同入口；worker 的运行环境另含已验证的 Python parser 依赖。只有 web / API 的应用入口对浏览器开放，数据库端口仅供内部网络或本机开发访问。

数据库、本地对象目录和模型缓存使用明确的持久卷，任务临时目录单独管理。镜像 / 应用升级不替换持久化数据；数据库主版本升级有独立迁移步骤。Compose 的卷能独立于服务容器保存数据，但不替代备份。[Docker 卷说明](https://docs.docker.com/reference/compose-file/volumes/)

配置通过环境变量或受控配置文件注入，包括 `DATABASE_URL`、`PAGELINGO_DATA_DIR`、存储 backend 和 parser 设备 / 模型位置。LLM 凭据只由 API / 翻译运行层读取；parser 子进程使用环境变量白名单，不继承密钥。配置快照、普通 settings、日志、导出与前端构建均排除密钥。已有 `.env.local` 可供本机后端联调读取，服务器使用自己的运行配置。

本机入口默认绑定 loopback；服务器入口通过 HTTPS 和单用户认证访问，上传、原件 / 资产、任务、SSE 与对话 API 采用同一访问边界。单用户认证不要求首版实现注册、团队或跨用户权限系统；未认证访问不得读取论文或调用计费任务。Origin / CSRF 校验与会话设置随 HTTP 接入一起验收。

服务器解析仍采用任务私有工作目录和资源限制。对象目录不挂为未经访问检查的公共静态站点；浏览器通过文档 / 资产 ID 请求，服务端解析 blob 引用，并支持 PDF 查看所需的范围读取。

## 97.2 备份、迁移与验收

V1 备份覆盖 PostgreSQL、数据库引用的不可变对象与恢复所需的配置；模型和 work 目录可以重新获取 / 创建。首版优先在只读维护窗口实施：暂停任务领取与对象清理，排空或中断运行中任务，冻结会修改状态的请求；导出数据库并复制其引用对象，保存 checksum manifest 和 schema / 应用版本。数据库导出本身的一致性不能替代对象集合的核对。[PostgreSQL 备份说明](https://www.postgresql.org/docs/current/backup.html)

恢复到另一台机器时先加载兼容 schema / 应用，再恢复对象与数据库、核对 checksum / 引用；旧 lease 的任务按 checkpoint 重新调度。已有可兼容的解析与译文无需为验证迁移而重新请求模型。迁移完成后检查文档、图片 / 公式、已提交译文、对话 / 选区、阅读位置及未完成任务。

未来迁往 S3 时，复制对象后验证大小 / checksum，再更新 backend 引用或切换存储配置；保留旧对象至验证完成。并发写入冻结或通过明确的增量同步处理，不能让配置切换造成部分 key 指向不存在的对象。不同 S3 兼容实现的写入 / 校验能力须用 adapter 验收；S3 的条件写入可以避免覆写，但不能假定所有兼容实现行为完全相同。[S3 条件写入](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)

P1 起验证迁移执行与跨存储提交的故障路径，P5 完成容器重建后数据保留、空环境恢复备份、换数据根目录 / 主机、worker 中断恢复、API 重启及未认证访问回归。尚无部署实现时，不用示例 Compose 或抽象接口的存在宣称这些检查已通过。

---

# 98. Parser Benchmark

进入 PDF 实施时先做 P0，确定主解析器、输出能力与资源预算。浏览器剩余的文档分析 / 动态术语工作可以在 PDF 阶段补进共享 SDK，并回归已交付插件。

这是整个 PDF 项目最重要的工程验证。

---

# 99. Benchmark Corpus

准备：

```text
20~50 PDFs
```

覆盖：

```text
ML conference papers
arXiv papers
single-column
double-column
many equations
inline math
large tables
multi-page tables
many figures
footnotes
appendices
references
long papers
```

扫描件可以另外准备，但不计 V1。

---

# 100. Benchmark Parser

优先比较 MinerU 和 Docling 的可运行配置；Marker 在依赖 / 模型 / 资源条件满足时加入。先用 3–5 个 smoke 样本确认能力和预算，再扩展到 §99 的 20–50 份 corpus。

每个候选必须有真实运行记录，stub 不计作已评测适配器。保证请求页集合覆盖全文，记录 backend、模型、OCR / VLM / LLM 增强开关、冷 / 热缓存和设备。不能用一个候选的远程大模型增强结果与另一个候选的纯本地运行混成同一成本口径。

Reader 依赖本项目 IR，不依赖原始 parser schema。更换 parser 仍需要重新验证 IR 的质量和降级情况，抽象接口不保证无损替换。

---

# 101. Benchmark 输出

每个 Parser：

```text
parsed.json
normalized-ir.json
debug.html
```

debug.html：

```text
PDF page screenshot
+
detected block boxes
+
reading order number
```

---

# 102. Benchmark 人工评分

评分：

```text
Text completeness
Reading order
Heading detection
Paragraph merging
Cross-page merging
Equation handling
Figure detection
Caption association
Table quality
Footnote handling
Reference handling
```

---

# 103. Parser 选择原则

首版优先科技阅读效果。CPU basic 仅是首轮基线；用户可在当前机器提供 GPU / 内存进行高质量处理，再把完成产物导入阅读服务器。继续评测 MinerU standard / advanced 及相关的独立增强功能，不因首轮 CPU 的耗时或内存就冻结主配置；先在同一渲染器中确认代表页的结构与阅读效果，再扩展 corpus / golden。配置与机器约束见 [处理设计](pdf-processing.md)。

不要追求：

> Benchmark 总分最高。

而应该选择：

> 对科技论文最稳定的 Parser。

优先级：

```text
reading order
>
text completeness
>
paragraph quality
>
formula preservation
>
figure/table
>
speed
```

---

# 104. 自动 Parser Fallback

不属于 V1。P0 选定一个主解析器及明确的 backend / 模型 / 配置后锁定版本；评测材料保留其他候选。

主解析器失败时保存原 PDF 和诊断，显示可重试 / 不支持状态。不能静默改用不同配置、只处理部分页或转为云端解析后仍声称同一结果。自动 fallback 在后续增加，并记录实际采用的解析链。

---

# 105. Parse Confidence

保留 parser 的原始评分、评分类型与来源；缺失时为 null，不填默认 1。不同 parser 或不同块类型的评分不能直接比较，也不作为校准后的正确概率。

面向 Reader 的诊断记录结构事实，例如来源缺失、顺序不确定、公式识别未确认、表格降级。debug 可以展示评分；涉及正文缺失或内容可信度的降级必须让用户可见，并提供原页入口，不能只藏在 debug 中。

---

# 106. Error Handling

Parser failure：

```text
Parsing failed.
Original PDF has been preserved.
```

Translation failure：

```text
部分段落翻译失败。
```

不能让整个 document 不可阅读。

---

# 107. Partial Translation

必须支持。

例如：

```text
200 blocks
```

翻译了：

```text
170
```

另外：

```text
30 failed
```

Reader：

170 显示中文。

失败 block：

```text
English source

Translation failed
[Retry]
```

---

# 108. 渐进式翻译

不必等整篇完成。

顺序：

```text
parse complete
 ↓
reader available immediately
 ↓
translation batches arrive
 ↓
blocks update
```

用户可以：

> 一边翻译一边阅读。

---

# 109. Translation Priority

优先：

```text
title
abstract
introduction
body order
```

不要优先 references。

---

# 110. References

最后甚至：

> 不提交 Translation Engine。

---

# 111. Translation Cache Hit

缓存 block：

立即显示。

未缓存：

加入 translation queue。

---

# 112. Security

LLM 只收到：

```text
需要翻译的文字
```

不需要默认上传：

```text
whole PDF
figure
```

除非未来使用 VLM。

---

# 113. API Key

与浏览器插件相同：

```text
BYOK
```

用户设置：

```text
Base URL
API Key
Model
```

存储：

后端受控运行配置；本机和服务器使用同一配置接口，LLM Key 排除在普通 settings、运行快照和数据库 / 文档导出之外。服务端部署使用环境变量或受控 secret 文件，parser 子进程不继承这些密钥。

禁止 log API key。

---

# 114. Parser Security

上传的 PDF：

- 文件名重新生成
- 不信任用户文件名
- parser 运行在受限目录
- asset path 由 server 生成
- 防止 path traversal

---

# 115. Frontend Design

主页面：

```text
┌──────────────────────────────┐
│ PDF Translation Reader       │
│                              │
│ Drop PDF here                │
│                              │
│ [ Select PDF ]               │
└──────────────────────────────┘
```

---

# 116. Library

即使没有账号，也推荐 V1 有本地文档列表：

```text
Documents

Scaling Laws...
Attention Is All You Need
...
```

因为结果已经缓存。

---

# 117. Document Card

显示：

```text
title
filename
page count
status
translated language
updated time
```

---

# 118. Reader Layout

Desktop：

```text
┌─────────────────────────────────────────────┐
│ ← Documents | Title | 译文 对照 原文 PDF   │
├─────────────┬───────────────────────────────┤
│ Outline     │                               │
│             │       Article                │
│ Abstract    │                               │
│ Intro       │       content                 │
│ Method      │                               │
│ Results     │                               │
└─────────────┴───────────────────────────────┘
```

---

# 119. Article Width

不要模拟论文双栏。

建议：

```text
700~900 px
```

保持舒适阅读宽度。

---

# 120. Figure

居中：

```text
[ Figure ]

图 2：……
```

点击：

```text
open full size
```

---

# 121. Table

宽表：

```text
horizontal scroll
```

不要压缩整个页面。

---

# 122. Equation

居中正常显示。

编号：

```text
(3)
```

保持。

---

# 123. Translation-first UX

这是本产品区别普通“双语阅读器”的关键。

默认：

```text
Chinese-first
```

而不是：

```text
50% English
50% Chinese
```

因为用户目的：

> 提高阅读速度。

---

# 124. Original-on-demand

英文应该：

> 随时可见。

但：

> 不应该一直抢占 50% 页面空间。

这也是为什么 V1 不默认左右双栏。

---

# 125. 快捷键

可选：

```text
O
```

展开当前 hover paragraph 原文。

```text
B
```

切换 bilingual。

不是 V1 必须。

---

# 126. Accessibility

按钮：

```text
原文
收起
重译
```

必须真实 button。

不要只依赖 hover。

---

# 127. Mobile

V1 不重点优化。

但上下式 bilingual 天然比左右栏兼容。

---

# 128. Performance

大型论文：

```text
500~1000 semantic blocks
```

React Reader 不应一次做昂贵 computation。

可考虑：

```text
memoized blocks
lazy images
```

暂时不必 virtual scrolling。

---

# 129. Logging

记录：

```text
PDF hash
parser version
parse duration
physical block count
semantic block count
merge count
cache hit
translation batch
validation errors
```

禁止记录：

```text
API Key
authorization
```

---

# 130. Debug Mode

必须有开发模式：

显示：

```text
block ID
page
bbox
parser confidence
raw block IDs
translation cache status
```

对调试 PDF parser 非常重要。

---

# 131. Debug Reader

例如：

```text
[block-39]
pages: 4-5
raw: r233,r234
cache: HIT
```

正式 UI 隐藏。

---

# 132. Testing Strategy

测试分：

```text
Unit
Integration
Golden PDF
End-to-end
```

---

# 133. Unit Tests

重点：

```text
text normalization
dehyphenation
header/footer detection
paragraph merge
cross-page merge
reference detection
block fingerprint
placeholder protect/restore
cache key
```

---

# 134. Parser Adapter Tests

每个 adapter：

输入 fixture parser JSON。

输出：

```text
RawParseResult
```

必须稳定。

避免 Parser 升级直接污染应用。

---

# 135. Golden Document IR

选择约：

```text
10 PDFs
```

人工确认：

```text
expected-ir.json
```

用于 regression。

---

# 136. Reader Tests

给定：

```text
Document IR
```

不需要真正 PDF parser。

测试：

```text
source
translation
bilingual
expand original
figure
table
equation
```

---

# 137. Translation Tests

同一个 SDK 直接运行其公共测试和语义评测，再增加 PDF Reader 投影 / 回填测试；不能只借鉴测试思想而维护另一套引擎。

---

# 138. V1 Parser 验收要求

P0 建立 20–50 份带来源与版本的 corpus，其中至少 10 份形成有人工标注的 golden IR。正式范围先为 born-digital 单 / 双栏；复杂多栏、异常长文、扫描 / 混合页单列挑战集，不与正式样本平均后掩盖失败。

初始验收目标如下，P0 必须报告实测值并冻结支持范围；若无法达到，需要显式缩小范围或修订目标：

- 标注的正文块保留率总体至少 98%，且正式支持的单篇不低于 95%；重复正文另行计错。
- 标注阅读顺序的相邻关系正确率至少 98%；跨栏穿插、错误段落合并、跨页漏合并分别报告计数与分母。
- 每个应保留的图、表、公式区域都有结构对象或可用原图 / 原页降级入口；无法确认公式识别时不以猜测的 LaTeX 替代原件。
- 每个可翻译块都能定位到至少一页；bbox 有值时通过旋转 / 裁剪样本的定位检查。
- bibliography / code / 独立公式不会被误送为普通段落翻译；SDK 保护对象在翻译前后 100% 原样。
- 归一化前数据可追溯，不用清理规则静默删除未知内容；partial / failed / unsupported 状态不会伪装成全文成功。

公式保护内容未改变不等于公式识别正确；解析错误和翻译错误分开评测。耗时、峰值内存 / 显存、CPU 与模型下载需求按目标机器报告，文件大小上限不作为性能测量结果。

---

# 139. V1 Reader 验收要求

长文验收包括至少一份 300 页以上文档：检查滚动、目录、首尾与中间跳转、
反复切换和断网阅读；报告最大活动 DOM / HTML 分片、主线程停顿和资源错误。
头部和页尾翻页、页码跳转及来源页入口均保持可用，不将 P0 断网 Chromium 的
滚动 smoke test 当作全部用户设备的性能保证。目录定位不能被固定导航栏遮住。

图表主视图须与原 PDF 区域核对；有定位缺陷时显示原页入口。被误识别为表格
的流程图不能通过重建单元格改变原图。正文 / 公式识别质量与是否原样展示图表
分别评测。

必须：

```text
译文模式
原文模式
对照模式
```

瞬间切换。

不重新：

```text
parse
translate
```

---

# 140. 原文展开

任意 paragraph：

```text
[原文]
```

点击：

显示对应英文。

必须：

- 不滚动到其他位置
- 不请求 backend translation
- 不刷新页面

---

# 141. Translation Cache 验收

同一 PDF、完整页范围、相同解析 / 翻译依赖、完整成功结果时再次打开：0 次新解析、0 次模型请求。分别记录 parse hit、analysis hit、translation hit 与请求数量。

变更模型 / endpoint / 生效生成配置 / 上下文 / 相关术语 / prompt 或 protection 版本时，受影响译文失效；源 PDF 与兼容解析结果仍保留。重解析改变块 ID 时，只有语义和依赖相同的块才能重绑命中。

中断任务恢复只补未完成且无有效缓存的单元。旧配置结果可供用户明确选择查看，不得在新配置任务中冒充新生成结果。

---

# 142. 修改模型

如果：

```text
same PDF
different LLM
```

则：

```text
0 parse
translation according to cache key
```

---

# 143. Parser Upgrade

如果：

```text
new parser version
```

可以创建新的 Parse Run。

旧结果仍然保留。

---

# 144. V1 Definition of Done

V1 完成必须满足：

### PDF

能够稳定处理主流 born-digital 科技论文 PDF。

### Parsing

能够重建合理：

```text
title
abstract
section
paragraph
figure
caption
table
equation
reference
```

### Translation

复用高质量科技翻译策略。

### Reader

提供：

```text
译文
对照
原文
PDF
```

### 对照

每一个 semantic paragraph：

可以立即查看对应英文。

### Cache

符合 §78–83 / §141 的内容、版本和配置依赖时，同一 PDF 不重复 parse，兼容 block 不重复 translation。重解析和显式重译是独立运行，不适用无条件缓存承诺。

### Reliability

单个 paragraph / table 失败不使已成功的 Reader 内容不可读。整体解析失败时仍能打开原 PDF 并查看诊断，但不能声称已得到完整语义 Reader。

### Assistant

通过 Reader IR 投影调用共享 assistant-core，完整选区和问题共同请求；对话、引用快照、草稿、摘要和阅读位置由后端按稳定文档 ID 保存。切换论文或重解析不会混入其他论文的引用，换浏览器可以读取已有历史。

### Storage / Deployment

本机与单服务器使用同一 PostgreSQL schema 和对象存储接口，应用升级 / 容器重建后数据保留；迁移入口识别已应用版本并拒绝不兼容 schema。空环境备份恢复与另一台主机迁移经过验证，覆盖原件、资产、译文、对话、阅读进度及未完成任务。服务器上传、文档 / 资产、任务、SSE 和对话经过单用户访问校验，密钥不进入前端或导出。

---

# 145. 推荐开发阶段

**当前进入 PDF P0 首轮评测。** 已有真实解析入口与布局检查；以下是正式产品的实施顺序，PDF 网站和部署仍未实现；P0 实测决定解析配置，P1 起采用可部署服务器的持久化与任务边界。

- **P0：解析器评测。** 少量 smoke 样本后建立 corpus，输出 raw / normalized JSON 与 debug 定位图，测量 §138 指标、资源预算和候选条件，选定主配置。
- **P1：协议、存储与任务骨架。** 定义 Reader IR、跨语言 schema、来源 / 资产 manifest；落实 PostgreSQL 迁移、LocalObjectStore、API / worker 配置与单用户访问，实现输入保存、任务领取 / 取消 / 恢复和阶段产物。这时就能跑 headless 解析任务，并验证存储提交的故障路径。
- **P2：解析与语义重建。** 主 parser adapter、页眉脚识别、阅读顺序、段落 / 跨页重建、章节、图表公式与引用；保留诊断及原件降级。
- **P3：原文 Reader。** React 连续英文阅读、图表 / 公式、目录与原 PDF 定位；英文语义结构达标后才开启翻译验收。
- **P4：共享 SDK 接入。** IR 投影、分析 / 术语、翻译缓存、逐批回填、取消、部分失败与重译；直接复用已通过扩展验收的核心。
- **P5：助手、翻译优先体验与部署验收。** 译文 / 对照 / 原文 / PDF、按块原文展开、文档库；通过 Reader IR 投影复用 assistant-core，实现右侧助手、完整选区提问和后端对话 / 阅读进度存储。完成 SSE 重连 / 轮询、缓存依赖矩阵、故障恢复、Compose 部署、备份恢复与主机迁移验收。

解析缓存与任务模型从 P1 起参与，不推迟到最后补建。PDF P0 不要求完整 UI，也不要求同时实现三个 parser 或任何中文版 PDF 排版器。

---

# 146. V1.1

建议加入：

```text
左右 HTML 对照
paragraph hover correspondence
PDF bbox highlight
document glossary editor
retranslate affected blocks
sentence-level optional alignment
better table translation
parser fallback
```

---

# 147. V2：OCR

增加：

```text
scanned PDF
hybrid PDF
OCR
```

但仍然输出同一个：

```text
Document IR
```

Reader 完全不变。

---

# 148. V3：Translated PDF

只有在 HTML Reader 已经很好用以后再做。

提供两种：

### Reading PDF

```text
Reflow HTML
↓
Print PDF
```

生成适合阅读的中文 PDF。

---

### Original-layout PDF

```text
Original PDF
+
bbox
+
translated text
+
local reflow
```

尽量保持原版。

这是独立 Renderer。

不影响主系统。

---

# 149. V4：在线服务

后续：

```text
account
cloud storage
share
multi-device
public link
```

---

# 150. V1 明确不做的错误方向

Codex 实现时禁止以下设计。

## 禁止 1

```text
PDF
→ Markdown
→ Translation
```

作为系统核心。

Markdown 可以作为 export。

不能作为 canonical representation。

---

## 禁止 2

以 PDF TextLine 为翻译单位。

---

## 禁止 3

以 PDF page 为翻译单位。

---

## 禁止 4

把 Parser 原始 JSON 直接暴露给 Frontend。

---

## 禁止 5

为了模仿 PDF 双栏而牺牲 HTML 阅读体验。

---

## 禁止 6

V1 花大量时间实现中文版 PDF。

---

## 禁止 7

让 LLM 修改 equation。

---

## 禁止 8

强行翻译 bibliography。

---

## 禁止 9

复杂表格解析失败以后仍然“猜”一个 HTML table。

应该：

```text
fallback original image
```

---

## 禁止 10

因为一个 block 失败而重新处理整篇 PDF。

---

# 151. 核心工程原则

整个系统应遵循：

```text
PDF is input format.

Document IR is truth.

Semantic block is translation unit.

HTML Reader is primary output.

Original English is always one click away.

PDF is fallback reference.

Translated PDF is optional renderer.
```

---

# 152. 产品判断标准

这个产品是否成功，不看：

> 中文 PDF 和原 PDF 长得有多像。

而应该看：

### 1

用户是否可以明显快于直接读英文 PDF。

### 2

翻译难懂时，是否可以瞬间看到对应英文。

### 3

Formula / Figure / Table 是否没有因为翻译被破坏。

### 4

科技名词是否足够可靠。

### 5

论文的逻辑结构是否恢复正确。

### 6

上传过一次以后，是否能快速再次打开。

### 7

更换翻译模型是否不需要重新解析 PDF。

---

# 153. 推荐仓库结构

本产品加入现有 PageLingo monorepo，不新建 `pdf-translation-reader` 仓库：

```text
apps/extension/              已交付：网页翻译插件，SDK 变化继续回归
apps/web/                    后续：PDF / LaTeX 共用 React Reader
apps/document-service/       后续：TypeScript API / jobs / SDK / storage
deploy/                      后续：Compose / Dockerfile / 迁移与备份说明
packages/translation-core/   已有：唯一翻译核心实现
packages/document-contracts/ 后续：Reader IR / 来源 / API schema
services/document-parser/    后续：Python adapters / normalizers
benchmarks/pdf/              后续：parser corpus / runner / debug
evals/                       后续：共享翻译质量评测
```

未来目录当前只含职责说明。语言和部署单元不决定仓库数量；各 app 单独构建发布，SDK 保留公开包入口与独立安装测试。详见 [monorepo.md](monorepo.md)。

---

# 154. PDF 第一个任务（当前 P0）

进入 PDF 实施阶段后执行，浏览器插件按共享 SDK 变化继续回归。

读取本规格和 monorepo 架构；在 `services/document-parser` 与 `benchmarks/pdf` 建立可运行候选的评测入口。先确认适配能力、全文页范围与资源预算，再扩展 corpus。输出原始结果、版本化 raw blocks、阅读顺序、坐标变换、来源与 debug 图。记录真实失败，不用空适配器宣称兼容。

本任务不实现翻译、生产网站或中文版 PDF。主解析器由报告决定。

---

# 155. PDF 第二个任务（后续 P1–P3）

P0 选型后落实共同 Reader schema、来源 / 资产模型与持久化任务。接入主 parser、归一化和语义重建，再实现英文 HTML Reader、原页入口及图表公式降级。

目标是读得完整、顺序正确、错误可见的原文 Reader。先验收解析和恢复，不通过调试一个译文样例跳过结构质量门槛。

---

# 156. PDF 第三个任务（后续 P4）

英文 Reader 达标后，通过 TypeScript 服务调用已验证的 `translation-core`。只实现 Reader / SDK 投影、存储适配和运行绑定，不在 Python 复制核心逻辑。

接入真实上下文 / 术语、缓存、渐进结果、取消和部分失败。保持 source IR 不变，译文按运行版本单独保存；公共质量策略的改进回到 SDK，同时回归浏览器插件。

---

# 157. PDF 第四个任务（后续 P5）

完善译文优先、上下对照、原文和 PDF 四种视图。每个已翻译段落可原位展开英文；失败块保留原文，模式切换不产生解析或翻译请求。

完成文档库、进度恢复、重译、缓存依赖和作业故障验收。原版式中文 PDF 仍是后续独立 renderer，不加入 V1 交付。

---

# 158. 最终产品定位

一句话定义：

> PDF Translation Reader 不是把英文论文“变成中文 PDF”，而是把 PDF 恢复成一个面向技术读者的高质量语义阅读文档，让中文负责提高速度，让英文负责最终确认。

这也是整个 V1 所有技术取舍的最高原则。

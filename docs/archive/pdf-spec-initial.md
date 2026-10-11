# PDF Translation Reader V1 详细设计 SPEC

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

# 3. 另外两种模式

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
- 普通复杂多栏
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

## Frontend

推荐：

```text
React
TypeScript
Vite
```

Reader 完全浏览器端渲染。

---

## Backend

推荐：

```text
Python
FastAPI
```

原因：

PDF 解析生态主要在 Python。

---

## PDF Engine

主解析器：

```text
MinerU
```

同时预留：

```text
DoclingAdapter
MarkerAdapter
```

作为 benchmark / fallback。

MinerU 当前结构化结果能够提供 reading order、内容类型、page index 和 bbox，并且专门提供 layout debug 输出，因此很适合转成自己的 IR。

但 MinerU 不同 backend / 大版本的 structured schema 曾发生变化，因此应用层绝不能直接依赖其原始 JSON；必须有独立 Adapter。

---

## Low-level PDF

使用：

```text
PyMuPDF
```

负责：

- 原 PDF 页面访问
- page size
- crop
- figure fallback
- table screenshot fallback
- source PDF preview
- 未来 PDF export

未来如果做 PDF 重新生成，PyMuPDF 的 `insert_htmlbox()` 可以在矩形区域内进行 HTML/CSS 文本排版，但这不属于 V1 主路径。

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

Reader 和 Translation Engine 不应该发生任何改变。

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

```python
class BoundingBox:

    x0: float
    y0: float
    x1: float
    y1: float
```

建议统一使用：

```text
normalized 0~1
```

禁止把某个 Parser 特有坐标系泄露到 Document IR。

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

Semantic Block 表示：

> 人正常阅读文章时看到的逻辑内容。

```python
class SemanticBlock:

    id: str

    type: SemanticBlockType

    order: int

    section_id: str | None

    source_content: BlockContent

    translation: BlockContent | None

    provenance: list[SourceReference]

    fingerprint: str

    parser_confidence: float | None

    warnings: list[str]
```

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

Paragraph 不能只是纯字符串。

需要：

```python
class InlineSpan:

    type: InlineSpanType

    text: str

    latex: str | None

    href: str | None

    target_id: str | None
```

类型：

```text
text
inline_math
citation
reference
code
link
emphasis
```

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
我们按照 Vaswani 等人的方法 ⟦CITE_1⟧ 最小化 ⟦MATH_1⟧。
```

恢复后：

```text
我们按照 Vaswani 等人的方法 [12] 最小化 L(θ)。
```

---

# 19. Document IR

建议：

```python
class DocumentIR:

    schema_version: str

    document_id: str

    source_hash: str

    parser_info: ParserInfo

    metadata: DocumentMetadata

    pages: list[PageMetadata]

    sections: list[SectionNode]

    blocks: list[SemanticBlock]

    assets: list[Asset]

    warnings: list[DocumentWarning]
```

---

# 20. Schema Version

必须存在：

```text
schemaVersion
```

例如：

```text
pdf-reader-ir/1
```

未来 IR 修改：

```text
pdf-reader-ir/2
```

不要无版本演进。

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

学术 PDF 经常重复：

```text
Conference Name
Authors
DOI
Page 4
```

不能进入正文。

推荐算法：

对每页：

```text
顶部 10~12%
底部 10~12%
```

提取文本。

normalize：

```text
lowercase
remove page number
collapse whitespace
```

统计重复次数。

如果：

```text
相同或高度相似文本
出现在 >= 30% 页面
```

标记：

```text
page furniture
```

删除。

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

需要处理：

```text
Unicode normalization
ligature
soft hyphen
line wrapping
multiple spaces
```

例如：

```text
ﬁ → fi
ﬂ → fl
```

但保留：

```text
数学符号
Greek letters
Unicode math
```

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

MinerU 的 layout debug 输出会直接标注 reading order，因此 Phase 0 benchmark 应利用这一输出人工检查。

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

重点实现。

例如：

Page 3：

```text
Our experiments demonstrate that the proposed
method significantly improves
```

Page 4：

```text
performance across all benchmarks.
```

必须合并。

判断：

- Page N 最后正文 block
- Page N+1 第一个正文 block
- 没有 heading 插入
- 前一个 block 没有明显结束标点
- typography compatible
- 下一 block 不以 bullet/heading 开始

满足：

```text
merge
```

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

优先使用 Parser 输出的 figure。

如果 Parser 没有可靠 asset：

使用：

```text
PyMuPDF
+
bbox crop
```

从原 PDF 生成。

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

如果结构识别可靠：

```text
Structured HTML Table
```

如果不可靠：

```text
Original Table Image
```

原则：

> 宁愿保留英文原表格，也不要生成结构错误的中文表格。

---

# 40. Structured Table Translation

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

所有资源统一：

```python
class Asset:

    id: str

    type:
        image
        figure
        table_image
        equation_image

    path: str

    mime_type: str

    source_page: int

    bbox: BoundingBox | None
```

---

# 51. Block ID

Semantic Block ID 必须稳定。

建议：

```text
block_
+
hash(
  documentHash
  + normalizedSourceContent
  + approximateOrder
)
```

这样：

Parser 小范围变化时：

> 相同段落仍有机会复用 Translation Cache。

---

# 52. Block Fingerprint

单独生成：

```text
SHA256(
 normalized semantic source
)
```

用于：

```text
translation cache
```

不要把 page number 放入 translation cache key。

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

如果浏览器插件是 TypeScript，而 PDF Backend 是 Python：

不要为了“代码复用”强行把全部 PDF backend 改成 Node。

推荐复用：

```text
Prompt specification
Glossary assets
Terminology policy
Placeholder protocol
Validation rules
Cache semantics
Translation request schema
Translation response schema
```

这些使用共享文件：

```text
shared/
  glossary/
  prompts/
  schemas/
```

例如：

```text
shared/glossary/tech-v1.json
shared/prompts/translation-v3.txt
shared/prompts/document-analysis-v2.txt
```

两个产品读取相同文件。

这样可以做到真正的：

> Translation behavior reuse。

---

# 55. Translation Request Contract

例如：

```json
{
  "document": {
    "title": "...",
    "domain": "machine-learning",
    "section": "3.2 Architecture"
  },

  "glossary": [],

  "blocks": [
    {
      "id": "block-039",
      "text": "..."
    }
  ]
}
```

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

每批：

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
Transformer → keep
PyTorch → keep
token → prefer-source
prompt → prefer-source
gradient descent → 梯度下降
```

---

# 61. Placeholder

统一 protocol：

```text
⟦MATH_0001⟧
⟦CITE_0002⟧
⟦CODE_0003⟧
⟦TERM_0004⟧
```

两个产品应使用相同协议。

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

需要四类数据。

---

## Source Cache

key：

```text
SHA256(PDF bytes)
```

避免同一 PDF 重复存储。

---

## Parse Cache

key：

```text
sourceHash
+
parserName
+
parserVersion
+
parserOptionsVersion
+
normalizerVersion
```

value：

```text
Document IR without translation
```

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

key：

```text
document semantic fingerprint
+
analysisPromptVersion
```

value：

```text
domain
summary
glossary
```

---

# 81. Translation Cache

key：

```text
blockFingerprint
+
targetLanguage
+
model
+
translationPromptVersion
+
glossaryVersion
```

value：

```text
translated block
```

---

# 82. 不必缓存 HTML

V1 没必要。

HTML render 很便宜。

缓存：

```text
Document IR
+
Translated IR
```

Reader 每次直接生成。

---

# 83. Document Dedupe

用户再次上传同一 PDF：

```text
SHA256 hit
```

直接提示：

```text
This document already exists.
Open existing translation?
```

无需：

```text
parse
translate
```

---

# 84. Storage

V1 单机：

```text
SQLite
+
filesystem
```

足够。

---

# 85. 文件结构

推荐：

```text
data/

documents/
  {document_id}/
    source.pdf

    parse/
      ir.json
      parser.json

    assets/
      figure-001.png
      table-003.png
      equation-010.png

    translations/
      zh-CN.json
```

---

# 86. SQLite

建议表：

```text
documents
jobs
parse_runs
translation_runs
translation_cache
settings
```

无需把所有 blocks 拆成关系表。

IR 用 JSON 存储即可。

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

状态：

```text
uploaded
classifying
parsing
normalizing
analyzing
translating
ready
failed
```

---

# 89. Job Progress

例如：

```text
Parsing PDF 38%
Analyzing document
Translating 48 / 213 paragraphs
```

---

# 90. Progress Protocol

推荐：

```text
SSE
```

即：

```text
GET /api/documents/{id}/events
```

比 WebSocket 简单。

V1 足够。

---

# 91. API

建议：

```text
POST
/api/documents

GET
/api/documents/{id}

GET
/api/documents/{id}/status

GET
/api/documents/{id}/content

GET
/api/documents/{id}/events

POST
/api/documents/{id}/translate

POST
/api/documents/{id}/blocks/{blockId}/retranslate

GET
/api/documents/{id}/source.pdf
```

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

建议第一版：

```text
max 100~200 MB
```

具体可以配置。

页数：

```text
max 500 pages
```

作为默认保护。

---

# 96. Parser Worker

PDF parser 很重。

不要直接运行在 FastAPI request thread。

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

无需 Redis / Celery。

可以：

```text
SQLite job table
+
single worker process
```

Worker：

```text
poll queued jobs
```

这样：

- 简单
- 可恢复
- 重启不会丢 job metadata

---

# 98. Parser Benchmark

在正式产品实现之前，必须做 Phase 0。

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

至少：

```text
MinerU
Docling
Marker
```

Docling 当前实现本身也包含 reading-order model、页面 provenance bbox、table 和 picture 等结构，因此值得作为第二候选进行同批测试。

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

不属于 V1。

V1：

```text
Primary = MinerU
```

如果 Phase 0 结果显示另一个明显更好：

直接切换 Primary。

---

# 105. Parse Confidence

IR：

```text
parserConfidence
```

如果某个 block：

```text
low confidence
```

Reader 可以显示：

```text
⚠
```

点击：

```text
查看 PDF
```

V1 可不显示默认 warning，只用于 debug。

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

本地 server 配置。

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

直接复用浏览器插件 Translation Engine 的测试思想。

---

# 138. V1 Parser 验收要求

在 benchmark corpus 中重点确认：

- 正文基本没有大量遗漏
- 双栏 reading order 正常
- 不频繁混入 header/footer
- paragraph 不被严重切碎
- 跨页 paragraph 大多数可以正确合并
- section heading 顺序正常
- formula 不被当普通英文翻译
- figures 不丢
- captions 基本正确
- references 不进入正常翻译

---

# 139. V1 Reader 验收要求

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

再次上传相同 PDF：

```text
0 parse
0 translation
```

直接打开已有结果。

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

同一 PDF 不重复 parse。

相同 block 不重复 translation。

### Reliability

单个 paragraph / table / parser error：

不会让整篇文章不可读。

---

# 145. 推荐开发阶段

## Phase 0 — Parser Benchmark

这是第一个开发任务。

实现：

```text
MinerU adapter
Docling adapter
Marker adapter
benchmark runner
debug renderer
```

先选 Parser。

不要先开发漂亮 UI。

---

## Phase 1 — Document IR

完成：

```text
IR schema
physical blocks
semantic blocks
provenance
assets
versioning
```

以及：

```text
JSON serialization
```

---

## Phase 2 — Primary Parser

基于 Phase 0 结果选择。

大概率先实现：

```text
MinerUParser
```

但最终以 benchmark 为准。

---

## Phase 3 — Semantic Normalizer

完成：

```text
header/footer remove
page number remove
text normalize
reading order
paragraph reconstruction
cross-page merge
section tree
```

这一阶段是整个产品最核心代码。

---

## Phase 4 — Original HTML Reader

暂时不要做翻译。

输入：

```text
Document IR
```

输出：

```text
source HTML reader
```

必须能够正常看完整论文。

这是一个重要 milestone：

> 如果英文 HTML 都恢复不好，不允许继续做翻译。

---

## Phase 5 — Assets

实现：

```text
figure
caption
equation
table
footnote
reference
```

---

## Phase 6 — Translation Integration

复用：

```text
Document Analyzer
Glossary
Translation Pipeline
Validation
Cache
```

输出：

```text
Translated Document IR
```

---

## Phase 7 — Translation-first Reader

完成：

```text
中文默认
paragraph 原文展开
source
bilingual
```

---

## Phase 8 — Cache

完成：

```text
source
parse
analysis
translation
```

---

## Phase 9 — Job System

完成：

```text
upload
progress
error
retry
partial result
```

---

## Phase 10 — Polish

完成：

```text
outline
PDF fallback
paragraph → source page
retranslate block
document library
debug mode
```

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

```text
pdf-translation-reader/

├── frontend/
│   └── React / TypeScript
│
├── backend/
│   └── Python / FastAPI
│
├── parser/
│   ├── base.py
│   ├── mineru.py
│   ├── docling.py
│   └── marker.py
│
├── ir/
│   ├── schema.py
│   ├── blocks.py
│   └── serialization.py
│
├── normalize/
│   ├── text.py
│   ├── furniture.py
│   ├── reading_order.py
│   ├── paragraphs.py
│   ├── cross_page.py
│   ├── sections.py
│   ├── figures.py
│   └── references.py
│
├── translation/
│   ├── pipeline.py
│   ├── glossary.py
│   ├── protect.py
│   ├── validator.py
│   └── cache.py
│
├── storage/
│   ├── db.py
│   ├── documents.py
│   └── assets.py
│
├── shared/
│   ├── glossary/
│   ├── prompts/
│   └── schemas/
│
├── benchmark/
│   ├── corpus/
│   ├── runner.py
│   ├── metrics.py
│   └── debug_renderer.py
│
└── tests/
```

---

# 154. Codex 第一个任务

建议不要让 Codex 直接开发整套产品。

第一条任务：

```text
Read SPEC.md completely.

Implement Phase 0 only.

Goal:
Evaluate PDF parsing quality for scientific and technical papers
before building the main product.

Requirements:

1. Create a common PDFParser interface.
2. Implement MinerUParser.
3. Implement adapters/stubs for Docling and Marker.
4. Define RawParseResult independent of any parser.
5. Build a benchmark CLI.
6. For every PDF, output:
   - parser raw output
   - normalized raw blocks
   - block type
   - page
   - bbox
   - reading order
7. Generate a debug HTML visualization for human inspection.
8. Do NOT implement translation.
9. Do NOT build the production frontend.
10. Do NOT attempt translated PDF generation.

The purpose of Phase 0 is to choose the best parser for
born-digital scientific PDFs.

Follow SPEC.md and keep parser-specific schemas behind adapters.
```

---

# 155. Codex 第二个任务

Phase 0 完成后：

```text
Implement Phase 1-4.

Goal:
Turn born-digital scientific PDFs into high-quality semantic HTML.

Implement:

1. Document IR v1.
2. Parser adapter normalization.
3. Header/footer removal.
4. Text normalization.
5. Paragraph reconstruction.
6. Cross-page paragraph merging.
7. Section reconstruction.
8. Figure/caption association.
9. Basic table handling.
10. Equation preservation.
11. Reference detection.
12. Original HTML reader.

No translation yet.

Definition of done:

A scientific PDF should be readable as continuous semantic English
HTML with correct section and paragraph order.

Do not reproduce PDF pagination or column layout.
```

---

# 156. Codex 第三个任务

只有英文 Semantic Reader 稳定以后：

```text
Implement the translation layer.

Reuse the same translation policies as the browser extension:

- document context
- technical glossary
- placeholder protection
- block batching
- terminology consistency
- validation
- retry
- block cache

Add translated content to Document IR.

Do not modify source content.
```

---

# 157. Codex 第四个任务

最后：

```text
Implement the Translation Reader UX.

Required modes:

1. Translation-first
2. Bilingual
3. Source
4. Original PDF

Translation-first is the default.

Each translated paragraph must allow the user to reveal
the exact corresponding English semantic paragraph inline.

Do not implement page-layout reproduction.
```

---

# 158. 最终产品定位

一句话定义：

> PDF Translation Reader 不是把英文论文“变成中文 PDF”，而是把 PDF 恢复成一个面向技术读者的高质量语义阅读文档，让中文负责提高速度，让英文负责最终确认。

这也是整个 V1 所有技术取舍的最高原则。

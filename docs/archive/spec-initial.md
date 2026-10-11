# 科技论文网页翻译浏览器插件 V1 详细设计 Spec

## 0. 文档目标

本文定义一个 Chrome / Edge 浏览器扩展的 V1 版本设计。

产品定位：

> 面向科技文章、技术文档、论文网页的高质量网页翻译插件。

V1 优先目标不是“支持所有网页”，而是：

1. 高质量翻译科技内容；
2. 尽量不破坏网页原布局；
3. 支持全文翻译和选中翻译；
4. 支持原文 / 中文 / 中英对照切换；
5. 强化专业名词和科技术语处理；
6. 尽可能保持同一篇文章术语一致；
7. 做可靠的本地缓存，避免重复调用 LLM；
8. 使用用户自己的 LLM API；
9. 插件只需本地安装，不要求发布到 Chrome Web Store。

---

# 1. 产品范围

## 1.1 V1 必须实现

### 基本翻译

- 翻译当前页面正文
- 翻译用户选中的文本
- 自动检测主要可翻译文本块
- 保留网页原结构
- 不修改代码、公式、链接地址等非自然语言内容

### 显示模式

必须支持：

- 原文模式
- 中文模式
- 中英对照模式

中英对照 V1 默认采用：

> 原文在上，译文在下

暂不以左右双栏作为默认模式。

### 翻译质量

重点优化：

- 科技论文
- AI / ML / CS
- 软件工程
- 技术文档
- 科学论文
- 工程类文章

必须实现：

- 文档级上下文分析
- 专业术语识别
- 动态 glossary
- 内置基础科技 glossary
- 保留技术专有名词
- 术语一致性
- placeholder 保护
- 翻译后结构校验
- 基础术语校验

### 缓存

必须实现：

- block 级翻译缓存
- 文档级 metadata 缓存
- 文档 glossary 缓存
- prompt version 参与 cache key
- glossary version 参与 cache key
- model 参与 cache key

### LLM

V1 支持 OpenAI-compatible API。

设置项：

- Base URL
- API Key
- Model
- Temperature
- Target language
- 翻译模式

API Key 仅存储在用户本地浏览器中。

---

# 2. V1 明确不做

以下功能不属于本期。

## 2.1 PDF

V1 不处理：

- PDF 文件上传
- PDF OCR
- PDF 重排
- PDF 翻译导出

后续版本实现。

## 2.2 arXiv LaTeX

V1 不实现：

- arXiv source 下载
- LaTeX parser
- LaTeX 翻译
- LaTeX 重编译
- 中文 PDF 输出

后续单独作为 Paper Web 产品实现。

## 2.3 云端系统

V1 不实现：

- 登录系统
- 云同步
- 在线阅读库
- 网页保存到服务器
- 多设备同步
- 分享链接

## 2.4 商业化

V1 不实现：

- 用户计费
- 套餐
- API 配额
- SaaS backend

## 2.5 多 Provider 完整支持

V1 暂不要求原生适配：

- Anthropic
- Gemini
- DeepSeek SDK
- Azure OpenAI SDK
- AWS Bedrock

但代码架构必须允许以后添加。

---

# 3. 目标浏览器

优先支持：

1. Google Chrome
2. Microsoft Edge

浏览器扩展规范：

> Manifest V3

不要求 Firefox。

---

# 4. 推荐技术栈

## Extension

- TypeScript
- Vite
- Manifest V3
- 原生 DOM API
- IndexedDB

UI 可以选择：

- 原生 HTML + CSS + TypeScript

或者：

- React

V1 推荐尽量保持轻量。

建议：

> popup / options 页面使用 React 也可以，但 content script 核心逻辑不得依赖 React。

---

# 5. 推荐工程结构

```text
tech-translator/
│
├── manifest.json
├── package.json
├── tsconfig.json
├── vite.config.ts
│
├── src/
│   │
│   ├── background/
│   │   ├── service-worker.ts
│   │   ├── context-menu.ts
│   │   └── messaging.ts
│   │
│   ├── content/
│   │   ├── index.ts
│   │   ├── page-controller.ts
│   │   ├── selection-controller.ts
│   │   └── mutation-controller.ts
│   │
│   ├── dom/
│   │   ├── extractor.ts
│   │   ├── block-builder.ts
│   │   ├── protect.ts
│   │   ├── restore.ts
│   │   ├── renderer.ts
│   │   ├── visibility.ts
│   │   └── selectors.ts
│   │
│   ├── translation/
│   │   ├── translator.ts
│   │   ├── translation-pipeline.ts
│   │   ├── batcher.ts
│   │   ├── validator.ts
│   │   ├── glossary.ts
│   │   ├── context-analyzer.ts
│   │   └── prompts.ts
│   │
│   ├── providers/
│   │   ├── provider.ts
│   │   └── openai-compatible.ts
│   │
│   ├── cache/
│   │   ├── db.ts
│   │   ├── translation-cache.ts
│   │   └── document-cache.ts
│   │
│   ├── settings/
│   │   ├── schema.ts
│   │   └── storage.ts
│   │
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.ts
│   │   └── popup.css
│   │
│   ├── options/
│   │   ├── index.html
│   │   ├── options.ts
│   │   └── options.css
│   │
│   ├── shared/
│   │   ├── types.ts
│   │   ├── hash.ts
│   │   ├── logger.ts
│   │   └── errors.ts
│   │
│   └── glossary/
│       └── default-tech-glossary.ts
│
└── tests/
```

---

# 6. 核心架构

整体流程：

```text
Web Page
   ↓
DOM Extractor
   ↓
Semantic Block Builder
   ↓
Protection Layer
   ↓
Document Context Analyzer
   ↓
Glossary Builder
   ↓
Cache Lookup
   ↓
Translation Batcher
   ↓
LLM Provider
   ↓
Translation Validator
   ↓
Retry / Repair
   ↓
Cache Write
   ↓
DOM Renderer
```

各部分必须尽量解耦。

---

# 7. 核心数据类型

推荐定义以下类型。

```ts
export type BlockId = string;

export interface TranslationBlock {
  id: BlockId;

  element: HTMLElement;

  sourceText: string;

  protectedText: string;

  placeholders: Placeholder[];

  sectionTitle?: string;

  order: number;

  fingerprint: string;
}

export interface Placeholder {
  id: string;

  type:
    | "code"
    | "math"
    | "link"
    | "term"
    | "citation"
    | "variable"
    | "html";

  originalText: string;

  originalNode?: Node;
}

export interface TranslationResult {
  blockId: string;

  sourceText: string;

  translatedText: string;

  restoredText?: string;

  cached: boolean;

  validation: ValidationResult;
}

export interface ValidationResult {
  valid: boolean;

  placeholderErrors: string[];

  terminologyErrors: string[];

  structuralErrors: string[];
}
```

---

# 8. 页面正文识别

## 8.1 可翻译元素

V1 主要处理：

```text
p
li
blockquote
figcaption
td
th
h1
h2
h3
h4
h5
h6
```

可根据网页适配逐步扩展。

---

# 9. 排除元素

以下元素及其子节点默认不翻译：

```text
script
style
noscript
textarea
input
select
option
button
canvas
svg
video
audio
iframe
```

默认保护：

```text
pre
code
kbd
samp
```

公式相关：

```text
math
mjx-container
.katex
.katex-display
.MathJax
.MathJax_Display
```

---

# 10. DOM 提取原则

严禁简单遍历所有 TextNode 并逐节点翻译。

必须以：

> semantic block

作为最小翻译单位。

例如：

```html
<p>
  A <strong>Transformer</strong> uses
  <a href="/attention">self-attention</a>.
</p>
```

不能拆成：

```text
A
Transformer
uses
self-attention
```

必须生成一个 TranslationBlock。

逻辑内容应类似：

```text
A {{INLINE_001}} uses {{LINK_001}}.
```

其中：

```text
{{INLINE_001}}
```

最终恢复为原 `<strong>` 内容。

---

# 11. Semantic Block Builder

每个段落级 DOM 元素生成一个 block。

Block 必须包含：

- 原始 Element
- 原始文本
- 保护后的文本
- placeholder
- 页面顺序
- section context
- fingerprint

Example：

```json
{
  "id": "block-102",
  "sourceText": "A Transformer uses self-attention.",
  "protectedText": "A {{TERM_001}} uses {{TERM_002}}.",
  "order": 102,
  "sectionTitle": "Architecture"
}
```

---

# 12. 文本过短过滤

以下内容默认不单独翻译：

- 单个标点
- 单个数字
- 长度小于 2 的无意义文本
- 纯 URL
- 纯代码
- 纯数学公式

短标题例外。

例如：

```text
Introduction
Results
Discussion
```

需要翻译。

---

# 13. Placeholder 保护机制

所有关键结构都必须在发送给 LLM 前转换成 placeholder。

格式建议：

```text
⟦CODE_0001⟧
⟦MATH_0001⟧
⟦TERM_0001⟧
⟦LINK_0001⟧
⟦CITE_0001⟧
```

不要使用普通：

```text
[1]
(x)
```

以减少与原文冲突。

---

# 14. 必须保护的对象

## 代码

包括：

```text
torch.compile()
npm install
pip install
MyClass
foo_bar()
--enable-feature
```

---

## 数学

包括：

- MathJax
- KaTeX
- `<math>`
- TeX inline expressions

---

## URL

例如：

```text
https://arxiv.org/...
```

不翻译。

---

## 专有技术名词

例如：

```text
Transformer
GPT
BERT
Llama
PyTorch
TensorFlow
CUDA
MMLU
ImageNet
LoRA
QLoRA
RLHF
DPO
RAG
MCP
```

根据 glossary 决定是否 placeholder 化。

---

## 软件标识符

例如：

```text
camelCase
PascalCase
snake_case
foo.bar()
```

---

# 15. 文档 Context Analyzer

全文翻译开始前，必须先执行一次文章级分析。

输入：

- document.title
- h1
- 前若干 h2
- abstract，如果能识别
- 前 3～10 个正文 block

限制分析长度。

目的：

1. 判断文章领域
2. 识别高价值专业术语
3. 生成 document glossary
4. 识别模型名、框架名、数据集名等
5. 判断文章语言

---

# 16. Context Analyzer 输出结构

```ts
export interface DocumentContext {
  title: string;

  sourceLanguage: string;

  domain:
    | "machine-learning"
    | "computer-science"
    | "software-engineering"
    | "physics"
    | "biology"
    | "engineering"
    | "general-technical"
    | "unknown";

  summary?: string;

  glossary: GlossaryEntry[];
}
```

---

# 17. Glossary 数据结构

```ts
export type GlossaryPolicy =
  | "keep"
  | "translate"
  | "first-bilingual"
  | "prefer-source";

export interface GlossaryEntry {
  source: string;

  target: string;

  policy: GlossaryPolicy;

  category?:
    | "model"
    | "framework"
    | "algorithm"
    | "dataset"
    | "concept"
    | "metric"
    | "software"
    | "other";

  confidence?: number;
}
```

---

# 18. Glossary Policy 含义

## keep

保持原文。

例如：

```text
Transformer → Transformer
PyTorch → PyTorch
CUDA → CUDA
MMLU → MMLU
```

---

## translate

使用固定中文术语。

例如：

```text
gradient descent → 梯度下降
loss function → 损失函数
learning rate → 学习率
```

---

## first-bilingual

第一次出现：

```text
检索增强生成（Retrieval-Augmented Generation, RAG）
```

之后：

```text
RAG
```

V1 可以简化：

先全部统一输出：

```text
检索增强生成（RAG）
```

后续再优化首次出现状态。

---

## prefer-source

倾向保持英文。

例如：

```text
token
prompt
checkpoint
pipeline
agent
```

如果中文翻译存在明显歧义，优先保留英文。

---

# 19. 内置 Tech Glossary

V1 必须自带默认科技 glossary。

建议初始规模：

> 500～2000 个高频术语

优先覆盖：

- AI
- Machine Learning
- LLM
- Deep Learning
- Computer Vision
- NLP
- Software Engineering
- Programming
- Cloud
- Databases

示例：

```text
Transformer → keep
token → prefer-source
prompt → prefer-source
embedding → 嵌入
attention → 注意力
fine-tuning → 微调
inference → 推理
training → 训练
loss function → 损失函数
learning rate → 学习率
gradient → 梯度
gradient descent → 梯度下降
overfitting → 过拟合
underfitting → 欠拟合
benchmark → 基准测试
dataset → 数据集
checkpoint → prefer-source
pipeline → prefer-source
hallucination → 幻觉
reasoning → 推理
retrieval → 检索
alignment → 对齐
```

---

# 20. Glossary 合并策略

优先级：

```text
用户自定义 glossary
>
document dynamic glossary
>
内置 tech glossary
>
LLM 自行判断
```

如果冲突：

用户设置最高优先级。

---

# 21. 翻译模式

V1 可以内部定义两个模式。

## High Quality

默认。

执行：

```text
Context Analysis
+
Glossary
+
Protection
+
Batch Translation
+
Validation
+
Retry
```

---

## Fast

V1 可以保留内部接口，但 UI 暂时不暴露。

执行：

```text
Protection
+
Simple Translation
```

默认始终使用 High Quality。

---

# 22. Translation Pipeline

完整 pipeline：

```text
extract
 ↓
build blocks
 ↓
context analysis
 ↓
glossary merge
 ↓
protect
 ↓
cache lookup
 ↓
batch
 ↓
translate
 ↓
validate
 ↓
retry if needed
 ↓
restore
 ↓
cache
 ↓
render
```

---

# 23. 翻译 Batch

禁止整页一次性发送。

原因：

- token 太大
- retry 成本高
- JSON 输出容易损坏
- 页面可渐进显示
- 缓存无法精细复用

建议 batch：

```text
5～20 个 block
```

同时限制：

```text
约 2000～5000 input tokens
```

具体由 token estimator 决定。

---

# 24. Batch Request 格式

推荐向模型发送 JSON 数据。

例如：

```json
{
  "document": {
    "title": "Scaling Laws for Neural Language Models",
    "domain": "machine-learning",
    "section": "Training Setup"
  },
  "glossary": [
    {
      "source": "Transformer",
      "target": "Transformer",
      "policy": "keep"
    }
  ],
  "blocks": [
    {
      "id": "b100",
      "text": "We train ⟦TERM_0001⟧ using..."
    },
    {
      "id": "b101",
      "text": "The learning rate..."
    }
  ]
}
```

---

# 25. LLM 返回格式

必须要求纯 JSON。

```json
{
  "translations": [
    {
      "id": "b100",
      "text": "我们使用 ⟦TERM_0001⟧ 进行训练……"
    },
    {
      "id": "b101",
      "text": "学习率……"
    }
  ]
}
```

不接受 Markdown。

---

# 26. Translation System Prompt

建议核心内容如下。

```text
You are a professional translator specializing in scientific,
engineering, software and computer science content.

Translate the provided technical text into Simplified Chinese.

Priority order:

1. Technical correctness.
2. Terminology consistency.
3. Preservation of technical identifiers and placeholders.
4. Readability for engineers and researchers.
5. Natural Chinese.

Rules:

- Never translate placeholders.
- Preserve every placeholder exactly.
- Never translate model names, framework names, API names,
  software identifiers, dataset names or code unless the glossary
  explicitly says otherwise.
- Prefer keeping an English technical term unchanged if its Chinese
  translation would be uncommon, ambiguous or misleading.
- Never translate Transformer as 变压器 or 变形金刚.
- Do not invent explanations.
- Do not summarize.
- Do not omit qualifiers.
- Preserve logical meaning and technical precision.
- Follow the provided glossary exactly.
- Return JSON only.
```

---

# 27. 用户目标语言

V1 默认：

```text
Simplified Chinese
```

设置中保留：

```ts
targetLanguage: string
```

但 UI V1 主要优化中文。

---

# 28. Temperature

默认：

```text
0.1
```

建议范围：

```text
0～0.3
```

科技翻译不追求创造性。

---

# 29. 翻译验证

Translation Validator 至少包含三层。

---

# 30. Placeholder Validation

原文：

```text
⟦TERM_001⟧
⟦CODE_003⟧
⟦MATH_004⟧
```

译文必须：

- 每个 placeholder 存在
- 数量一致
- 不增加未知 placeholder
- 不重复 placeholder

否则：

```text
validation.valid = false
```

触发 retry。

---

# 31. Block Validation

检查模型返回：

- block ID 是否齐全
- 是否有重复 ID
- 是否出现未知 ID
- translated text 是否为空

任何异常：

retry batch。

---

# 32. Terminology Validation

对 policy=keep 的词做检查。

例如：

```text
Transformer
```

原文出现，译文原则上必须保留。

如果检测到：

```text
变压器
变形金刚
```

判定 terminology error。

V1 可通过：

- blacklist
- glossary check

完成。

---

# 33. 技术术语危险翻译黑名单

建议内置少量明确错误翻译。

例如：

```text
Transformer:
  - 变压器
  - 变形金刚

token:
  - 令牌
```

注意：

token → 令牌并不在所有场景错误。

因此 blacklist 应区分：

```text
hard error
soft warning
```

Transformer 的错误属于 hard error。

---

# 34. Retry 策略

默认最多：

```text
2 retries
```

第一次失败：

重新调用同模型，并增加：

```text
Your previous response violated placeholder or terminology constraints.
Fix the translation.
```

第二次仍失败：

- 保留原文
- 标记 block translation failed
- 页面不得崩溃

---

# 35. DOM Renderer

核心原则：

> 不替换或销毁原页面结构。

不要直接：

```ts
element.innerHTML = translatedHtml;
```

---

# 36. 推荐渲染结构

原网页：

```html
<p class="original">
  The Transformer architecture...
</p>
```

翻译后追加：

```html
<p class="original">
  The Transformer architecture...
</p>

<div
  class="tt-translation"
  data-tt-block-id="b123"
>
  Transformer 架构……
</div>
```

---

# 37. Translation Node

译文 node 必须：

- 带统一 class
- 带 block ID
- 可快速 show / hide
- 不干扰原元素事件
- 尽量继承父节点视觉属性

---

# 38. 三种显示模式

定义：

```ts
type DisplayMode =
  | "source"
  | "translation"
  | "bilingual";
```

---

## source

```text
原文显示
译文隐藏
```

---

## translation

```text
原文隐藏
译文显示
```

注意：

必须通过 CSS 隐藏。

不能删除原文。

---

## bilingual

```text
原文显示
译文显示
```

译文放在对应 block 下方。

---

# 39. 样式原则

避免强制固定字体。

推荐：

```css
.tt-translation {
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  max-width: inherit;
  box-sizing: border-box;
}
```

可以增加轻微区分：

```css
.tt-translation {
  margin-top: 0.35em;
  margin-bottom: 0.8em;
}
```

不要：

- 固定背景色
- 固定文本颜色
- 大量边框
- 强制宽度
- 强制字体

必须兼容 dark mode。

---

# 40. 中英对照视觉

V1 推荐：

```text
English paragraph

中文翻译

English paragraph

中文翻译
```

而不是左右栏。

原因：

- 更兼容移动布局
- 不改变页面宽度
- 不破坏 table / figure
- 不影响公式

---

# 41. Heading

对于：

```html
<h2>Architecture</h2>
```

双语模式建议：

```text
Architecture
架构
```

译文视觉可略小于 heading。

但不要生成第二个 h2。

避免影响：

- document outline
- anchor
- SEO
- 页面 JS

建议译文使用 div。

---

# 42. Table

V1 可以翻译：

```text
th
td
```

但必须谨慎。

如果 table 布局出现明显异常：

优先保留原 table。

译文可作为：

```text
small inline block
```

或者未来单独优化。

第一版要求：

> 不得因为翻译造成 table 横向结构破坏。

---

# 43. Code

`pre` / `code` 完全保持。

代码附近的说明文字可翻译。

例如：

```text
Run the following command:
```

翻译。

但：

```bash
pip install torch
```

不翻译。

---

# 44. 公式

MathJax / KaTeX 完全保持。

不要尝试重新生成公式。

正文中的数学变量也优先 placeholder。

---

# 45. Link

链接地址不变。

链接文字：

例如：

```html
<a href="/paper">previous work</a>
```

如果它是自然语言，则允许翻译显示文本。

但必须保持：

```text
href
target
event
```

不变。

第一版如果 inline link 恢复过于复杂，可以：

> 将链接节点整体 placeholder 化

即：

```text
previous work
```

暂时保持英文。

稳定性优先。

---

# 46. 全文翻译交互

Popup：

```text
Tech Translator

[ Translate Page ]

Display:
○ Source
○ Chinese
● Bilingual

Status:
Translated 143 / 180

[ Stop ]

Settings
```

---

# 47. 翻译过程

必须渐进式。

不能：

> 等全文翻完后一次显示。

流程：

```text
batch 1
↓
render

batch 2
↓
render

batch 3
↓
render
```

用户可以边翻边看。

---

# 48. 页面翻译状态

```ts
type PageTranslationStatus =
  | "idle"
  | "analyzing"
  | "translating"
  | "completed"
  | "cancelled"
  | "error";
```

---

# 49. Stop

用户点击 Stop：

- 停止后续 LLM 请求
- 已翻译内容保留
- 已完成缓存保留

使用 AbortController。

---

# 50. 选中翻译

支持：

```text
鼠标选中文本
↓
右键
↓
Translate Selection
```

也可以增加悬浮按钮，但不是 V1 必须。

---

# 51. Selection Translation

选中内容：

- 不修改原 DOM
- 显示浮动 translation popup

Popup 内容：

```text
原文
------
译文

[ Copy ]
[ Close ]
```

选中翻译也使用：

- tech glossary
- document context
- placeholder protection

但不需要全文 batch。

---

# 52. Selection 缓存

同样进入 block translation cache。

---

# 53. 缓存系统

使用：

> IndexedDB

禁止将大量翻译存入 localStorage。

---

# 54. Database

建议：

```text
DB name:
tech-translator

version:
1
```

Stores：

```text
translations
documents
settings-meta
```

---

# 55. Translation Cache Schema

```ts
interface TranslationCacheEntry {
  key: string;

  sourceText: string;

  translatedText: string;

  sourceLanguage: string;

  targetLanguage: string;

  model: string;

  promptVersion: string;

  glossaryVersion: string;

  createdAt: number;

  lastAccessedAt: number;
}
```

---

# 56. Cache Key

推荐：

```text
SHA256(
  normalizedSourceText
  +
  sourceLanguage
  +
  targetLanguage
  +
  model
  +
  promptVersion
  +
  glossaryVersion
)
```

---

# 57. 文本 Normalize

normalize 只处理：

- 首尾空格
- 连续空白
- 非语义换行

例如：

```text
"Hello   world"
```

与：

```text
"Hello world"
```

可命中同一缓存。

但不要：

- lowercase 全部文本
- 删除标点
- 改变代码
- 改数字

---

# 58. Document Cache

```ts
interface DocumentCacheEntry {
  documentKey: string;

  url: string;

  title: string;

  fingerprint: string;

  sourceLanguage: string;

  domain: string;

  glossary: GlossaryEntry[];

  createdAt: number;

  updatedAt: number;
}
```

---

# 59. Document Key

推荐：

```text
normalized URL
```

需要移除：

```text
utm_source
utm_medium
utm_campaign
```

但保留：

- arXiv ID
- docs path
- query 中决定正文的参数

---

# 60. Document Fingerprint

基于：

```text
title
+
first N block fingerprints
```

如果内容发生明显变化：

重新进行 Context Analysis。

---

# 61. Cache 命中流程

每个 block：

```text
build cache key
↓
IndexedDB lookup
↓
hit
 ├ yes → render immediately
 └ no  → enqueue translation
```

---

# 62. Cache 效果目标

相同页面第二次访问：

> 绝大多数未变化正文不得重新调用 LLM。

---

# 63. 缓存清理

V1 Settings：

```text
Cache Size
Clear Translation Cache
Clear Document Cache
Clear All Cache
```

可增加：

```text
最大缓存：
500 MB
```

如果实现复杂，第一版不自动 LRU。

但 schema 必须包含：

```text
lastAccessedAt
```

便于未来加入 LRU。

---

# 64. Settings

必须包含：

```ts
interface UserSettings {
  provider: "openai-compatible";

  baseUrl: string;

  apiKey: string;

  model: string;

  temperature: number;

  targetLanguage: "zh-CN";

  displayMode: DisplayMode;

  translationMode: "high-quality";

  customGlossary: GlossaryEntry[];
}
```

---

# 65. API Key

要求：

- 不发送到除用户配置 endpoint 外的其他服务器
- 不写日志
- UI 默认 mask
- 不在错误信息完整输出

---

# 66. Provider Interface

即使 V1 只有一个 provider，也必须抽象。

```ts
export interface LLMProvider {
  testConnection(): Promise<boolean>;

  translateBatch(
    request: TranslationRequest,
    signal?: AbortSignal
  ): Promise<TranslationResponse>;

  analyzeDocument(
    request: AnalyzeDocumentRequest,
    signal?: AbortSignal
  ): Promise<DocumentContext>;
}
```

---

# 67. OpenAI Compatible

配置：

```text
Base URL
API Key
Model
```

需要兼容：

```text
/v1/chat/completions
```

未来可增加 Responses API。

V1 优先保证广泛兼容。

---

# 68. Error Handling

错误分为：

```ts
enum ErrorCode {
  API_AUTH_ERROR,
  API_RATE_LIMIT,
  API_NETWORK_ERROR,
  API_INVALID_RESPONSE,
  TRANSLATION_VALIDATION_ERROR,
  PAGE_EXTRACTION_ERROR,
  CACHE_ERROR
}
```

---

# 69. API Error UX

不得只显示：

```text
Error 401
```

应该：

```text
API authentication failed.
Please check your API key and Base URL.
```

---

# 70. Rate Limit

HTTP 429：

指数退避：

```text
1s
2s
4s
```

最多三次。

并且尊重 Retry-After。

---

# 71. Network Failure

失败：

- 当前 batch 可 retry
- 不影响已完成 batch
- 不清除缓存
- 页面不会恢复为空

---

# 72. MutationObserver

V1 建议支持动态页面。

例如：

- GitHub
- docs SPA
- infinite scrolling

MutationObserver 发现新增内容后：

不要自动马上调用 API。

第一版策略：

> 用户点击 Translate Page 时翻译当前已加载内容。

翻译过程中新增元素可以加入 pending queue。

但无限滚动自动翻译不是 V1 必须。

---

# 73. SPA Navigation

监听：

- history.pushState
- popstate
- URL change

URL 变化后：

重置 PageController。

避免旧页面译文污染新页面。

---

# 74. 页面适配优先级

第一阶段重点测试：

## arXiv HTML

例如：

```text
arxiv.org/html/*
```

## GitHub

README / docs。

## Hugging Face

论文页、文档页。

## 技术文档

包括常见 documentation 网站。

## 技术博客

Medium-like / blog-like 页面。

---

# 75. 特殊页面规则

允许后续定义：

```ts
interface SiteAdapter {
  matches(url: URL): boolean;

  getContentRoot(): HTMLElement | null;

  getExcludedSelectors(): string[];

  getPrioritySelectors(): string[];
}
```

---

# 76. 通用策略优先

V1 不要一开始写大量 site-specific hack。

优先：

```text
generic DOM extractor
```

只有明显高价值网站再加 adapter。

---

# 77. Logging

开发模式记录：

```text
page extraction
block count
cache hit
cache miss
batch size
API latency
validation failure
retry
```

正式版默认关闭详细日志。

绝不记录：

```text
API Key
Authorization header
```

---

# 78. Debug Mode

建议设置隐藏 debug mode。

开启后 console：

```text
[TT] extracted 182 blocks
[TT] cache hit 143
[TT] translating 39
[TT] batch #1 success
```

便于开发。

---

# 79. 性能目标

普通技术网页：

```text
100～300 blocks
```

插件 DOM 提取不应明显卡住主线程。

推荐：

- 分批处理
- requestIdleCallback
- setTimeout yield

避免一次同步遍历巨大 DOM。

---

# 80. API 并发

默认：

```text
2 concurrent batches
```

不要无限并发。

设置内部常量：

```ts
MAX_CONCURRENCY = 2
```

未来可配置。

---

# 81. Translation Priority

页面顶部 block 优先。

即：

```text
block order ascending
```

用户越早看到页面开头翻译。

---

# 82. Security

插件权限尽量最小化。

建议：

```json
{
  "permissions": [
    "storage",
    "contextMenus",
    "activeTab",
    "scripting"
  ]
}
```

host permissions 根据 API 使用策略设计。

---

# 83. API 请求安全

如果 OpenAI-compatible base URL 是用户自定义：

需要支持动态 host permission。

安装时不应默认：

```text
<all_urls>
```

如果实现成本过高，V1 可以允许必要权限，但应记录为后续安全优化事项。

---

# 84. 原页面安全

Content Script 插入节点时：

不要执行：

- 页面返回的 HTML
- LLM 返回的 HTML

LLM 返回全部按 plain text 处理。

避免：

```ts
innerHTML = modelOutput;
```

必须使用：

```ts
textContent
```

或安全 DOM construction。

---

# 85. 翻译输出禁止 HTML

LLM contract：

> translation text only

这样可以避免 XSS。

---

# 86. 用户自定义 Glossary

Settings 支持简单表格：

```text
Source       Target       Policy

Transformer Transformer  Keep
token       token        Prefer source
```

支持：

- Add
- Edit
- Delete

---

# 87. Custom Glossary 导入导出

不是 V1 必须。

后续实现 JSON import/export。

---

# 88. Popup 状态

建议显示：

```text
Page detected:
Technical / Research

Blocks:
182

Translated:
120

Cached:
95

API:
27
```

这对调试也很有帮助。

---

# 89. Connection Test

Settings 页面必须：

```text
[Test Connection]
```

成功：

```text
Connection successful
```

失败：

显示原因。

---

# 90. 首次使用流程

第一次打开：

```text
1. 打开 Settings
2. 输入 Base URL
3. 输入 API Key
4. 输入 Model
5. Test Connection
6. Save
```

之后点击：

```text
Translate Page
```

即可。

---

# 91. 默认行为

如果没有 API 设置：

点击 Translate Page：

直接打开 Settings 或提示：

```text
Configure your LLM API before translating.
```

---

# 92. Context Analysis 缓存

如果文档 cache 已存在且 fingerprint 相同：

跳过 Context Analyzer。

直接复用：

```text
domain
glossary
```

---

# 93. Context Analyzer Prompt

示例：

```text
Analyze this scientific or technical document.

Your tasks:

1. Identify the technical domain.
2. Identify important technical terms.
3. Identify model names, framework names, dataset names,
   API names and software identifiers.
4. Produce a translation glossary for Simplified Chinese.

Important principles:

- Preserve established English terms when Chinese translation is
  uncommon or potentially misleading.
- Do not translate product, model, library or framework names.
- Transformer in ML must remain Transformer.
- Prefer terminology used by Chinese researchers and engineers.

Return JSON only.
```

---

# 94. Context Analyzer 输出限制

最多：

```text
50～100 glossary entries
```

防止 glossary 无限增长。

---

# 95. Glossary Entry Confidence

动态 glossary 可以输出：

```text
confidence: 0-1
```

低于：

```text
0.6
```

可以忽略。

---

# 96. 翻译文本长度控制

如果一个 block 过大：

例如超过：

```text
1500～2500 words
```

应进一步按：

- sentence
- paragraph
- line break

拆分。

但恢复后仍属于同一 DOM block。

---

# 97. Sentence Split

不要简单按英文句点 split。

可以优先使用：

```text
Intl.Segmenter
```

如果浏览器支持。

---

# 98. 科技名词启发式识别

除 glossary 外，可识别：

```text
CamelCase
ALL_CAPS
Mixed123
foo()
package.module
version numbers
```

作为保护候选。

---

# 99. 名词保留策略核心原则

必须固化在 Prompt + code 中：

> 当一个科技术语的标准中文译法不明确时，优先保留原英文，而不是强行中文化。

---

# 100. 质量优先原则

翻译优先级：

```text
技术正确性
>
术语一致性
>
结构完整
>
可读性
>
文学流畅性
```

---

# 101. 页面显示优先原则

UI 优先级：

```text
不破坏网页
>
清晰双语
>
视觉美化
```

---

# 102. 验收测试：术语

必须测试：

```text
Transformer
token
prompt
checkpoint
pipeline
agent
embedding
attention
gradient descent
loss function
learning rate
RLHF
DPO
LoRA
MMLU
CUDA
PyTorch
```

至少确保：

```text
Transformer
```

绝不翻译成：

```text
变压器
变形金刚
```

---

# 103. 验收测试：DOM

测试页面包含：

- inline strong
- em
- link
- code
- math
- table
- list
- heading
- blockquote
- image
- figure caption

翻译后：

- 页面结构可用
- 链接可点击
- 代码未变化
- 公式未变化
- 图片未变化

---

# 104. 验收测试：Display Mode

同一翻译页面：

```text
Source
Translation
Bilingual
```

三种模式切换：

- 不重新调用 API
- 不重新刷新网页
- 不丢失滚动位置

---

# 105. 验收测试：缓存

第一次：

```text
100 blocks
100 API
```

第二次：

```text
100 blocks
接近 100 cache hits
```

如果只有 3 段发生变化：

```text
约 97 cache hits
约 3 API translations
```

---

# 106. 验收测试：错误

模拟：

- 401
- 429
- network timeout
- invalid JSON
- placeholder missing
- terminology violation

插件：

- 不崩
- 已翻内容保留
- 用户看到可理解错误

---

# 107. 验收测试：页面恢复

用户点击：

```text
Source
```

必须看到完整原页面。

刷新页面：

原网页不得永久修改。

---

# 108. Unit Tests

重点测试：

```text
normalizeText
hash
placeholder protect/restore
glossary merge
cache key
validator
batch builder
```

---

# 109. Integration Tests

可以使用 fixture HTML。

例如：

```text
tests/fixtures/arxiv.html
tests/fixtures/github-readme.html
tests/fixtures/technical-doc.html
```

测试：

```text
extract
→ protect
→ fake translation
→ restore
→ render
```

---

# 110. Mock Provider

必须提供：

```ts
MockLLMProvider
```

测试时不依赖真实 API。

---

# 111. V1 Definition of Done

只有满足以下要求才算 V1 完成。

### 功能

- 全文翻译正常
- 选中翻译正常
- 三种显示模式正常
- API 配置正常
- 缓存正常

### 翻译

- 有 document context
- 有 glossary
- 有 placeholder protection
- 有 validation
- 有 retry
- 术语不会明显乱翻

### 页面

- 主流科技文章页面布局基本不变
- code / formula 不被破坏
- link 可正常使用

### 缓存

- 第二次进入同一页面显著减少 API 调用

---

# 112. V1 开发阶段拆分

推荐 Codex 按以下阶段完成。

---

## Phase 1：插件基础骨架

完成：

- Manifest V3
- popup
- options
- settings
- content script
- background
- messaging
- Test Connection

验收：

插件能加载。

---

## Phase 2：DOM Extractor

完成：

- block 识别
- exclude
- block ID
- sourceText
- page order

先不调用 LLM。

验收：

开发模式能够打印所有 translation blocks。

---

## Phase 3：Renderer

使用 fake translator：

```text
[ZH] + 原文
```

完成：

- source
- translation
- bilingual

验收：

布局基本不破坏。

---

## Phase 4：Provider

完成：

- OpenAI-compatible
- translateBatch
- API errors
- AbortController

---

## Phase 5：Basic Translation

完成：

```text
extract
→ batch
→ translate
→ render
```

此阶段已有基础可用版本。

---

## Phase 6：Cache

完成：

- IndexedDB
- translation cache
- document cache
- cache hit / miss

---

## Phase 7：Protection Layer

完成：

- code
- formula
- URL
- technical identifiers
- placeholders
- restore

---

## Phase 8：Glossary

完成：

- default tech glossary
- custom glossary
- merge
- policy

---

## Phase 9：Document Analyzer

完成：

- title / headings / initial paragraphs
- domain
- dynamic glossary
- document cache

---

## Phase 10：Validation

完成：

- placeholder validation
- block validation
- terminology validation
- retry

---

## Phase 11：Selection Translation

完成：

- context menu
- selected text
- translation popup
- copy

---

## Phase 12：Polish

完成：

- SPA support
- mutation handling
- loading state
- progress
- cancel
- errors
- tests

---

# 113. 后续 V1.1

V1 完成后优先考虑：

### Better Bilingual UI

- 左右双栏模式
- 原文淡化
- hover 对应段落
- 同步高亮

### Progressive Translation

只翻可视区域：

```text
IntersectionObserver
```

用户滚动时优先翻下面部分。

### 更智能术语

支持：

```text
第一次：
中文（English）

后续：
中文
```

### 用户术语表增强

- JSON import
- JSON export
- domain glossary

### Provider

增加：

- Anthropic
- Gemini
- OpenAI Responses API

---

# 114. 后续 V2：网页阅读库

增加 backend：

```text
Extension
↓
Save Page
↓
Server
↓
Personal Reading Library
```

功能：

- 保存原文
- 保存翻译
- 保存 glossary
- 永久访问
- 搜索
- 标签

---

# 115. 后续 V3：arXiv 论文网站

单独 Web App。

输入：

```text
arXiv URL
arXiv ID
```

处理：

```text
arXiv source
↓
LaTeX
↓
parser
↓
translation
↓
validation
↓
compile
↓
translated PDF / HTML
```

---

# 116. arXiv V3 核心

必须复用当前插件的：

```text
Translation Core
Glossary
Provider
Validator
Cache concepts
Prompt strategy
```

只替换：

```text
DOM input adapter
```

为：

```text
LaTeX input adapter
```

---

# 117. 后续 V4：普通 PDF

先做：

```text
PDF
↓
layout extraction
↓
semantic blocks
↓
HTML bilingual reader
```

不要一开始追求：

```text
100% 原 PDF 版式复刻
```

---

# 118. 后续 V5：PDF 重排

最后再实现：

```text
PDF
↓
layout parser
↓
translate
↓
layout reconstruction
↓
new translated PDF
```

这是独立的大工程。

---

# 119. 核心设计约束总结

Codex 实现时必须遵守以下原则。

## 原则 1

禁止逐 TextNode 翻译。

必须使用 semantic block。

## 原则 2

禁止让 LLM 返回 HTML。

只允许 structured JSON + plain text。

## 原则 3

禁止通过 innerHTML 替换网页正文。

必须保留原 DOM。

## 原则 4

代码、公式、URL、标识符必须保护。

## 原则 5

科技名词不确定时：

> 保留英文优先于错误中文化。

## 原则 6

Transformer 在 ML 语境中绝不能翻译为变压器或变形金刚。

## 原则 7

术语一致性是文章级问题，不是 paragraph 级问题。

必须有 document glossary。

## 原则 8

全文必须 batch translation。

禁止整页一次性提交。

## 原则 9

缓存必须 block level。

## 原则 10

用户随时可切回原文，且不重新加载页面。

## 原则 11

页面视觉优化优先保证：

> 不破坏原网页。

## 原则 12

所有模块必须为未来 arXiv / PDF 产品复用留出接口。

---

# 120. 建议第一版产品名称

代码名可以暂时使用：

```text
Tech Translator
```

或者：

```text
Paper Translator
```

工程名：

```text
tech-translator
```

名称不影响实现，后续可以修改。

---

# 121. Codex 首条实现任务建议

不要直接让 Codex：

> 实现整个项目。

推荐按阶段给任务。

第一条任务可以是：

```text
Read SPEC.md completely.

Implement Phase 1-3 only:

1. Create a Chrome/Edge Manifest V3 extension using TypeScript + Vite.
2. Implement popup and settings pages.
3. Implement generic DOM semantic block extraction.
4. Do not integrate an LLM yet.
5. Implement a FakeTranslator that returns "[ZH] " + source text.
6. Implement Source / Translation / Bilingual display modes.
7. Preserve the original DOM and never replace page innerHTML.
8. Add tests for DOM block extraction and renderer.

Follow the architecture and interfaces in SPEC.md.
Do not implement later phases unless required to keep the architecture clean.
```

Phase 1-3 验证稳定后，再让 Codex 实现真实 LLM。

---

# 122. 最终目标

V1 不是一个“Google Translate 替代品”。

它应该是：

> 一个专门为工程师、研究人员和科技论文阅读设计的高质量浏览器翻译层。

判断 V1 成功与否，不看支持多少网站，而看：

1. 技术文章翻译是否准确；
2. 术语是否稳定；
3. 专业名词是否保留合理；
4. 原网页是否基本不被破坏；
5. 第二次阅读是否几乎不产生重复 API 成本；
6. 是否能成为未来 arXiv / PDF 翻译系统的核心翻译引擎。

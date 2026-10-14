# @pagelingo/translation-core

PageLingo 的独立 TypeScript 翻译 SDK，使用 npm workspace 开发，输出可单独安装的 ESM JavaScript 和类型声明。支持现代浏览器和 Node.js；仓库在 Node.js 24 上验证。

当前为 **0.4.0**：统一文档、保护与还原、OpenAI-compatible Provider、预算/拆分、有限重试、缓存语义、检查点及调度扩展点。测试入口提供有明确标记的 MockProvider。已支持个人术语文件解析、后写合并、领域匹配、槽位保护及相关缓存依赖；Mock 输出不能用于评价翻译质量。

## 调用示例

```ts
import { TranslationEngine, type TranslationDocument } from '@pagelingo/translation-core';
import { MockProvider } from '@pagelingo/translation-core/testing';

const document: TranslationDocument = {
  id: 'paper-1',
  title: 'Optimization methods',
  sourceLanguage: 'en',
  blocks: [{
    id: 'methods-p1',
    kind: 'paragraph',
    sectionPath: ['Methods', 'Optimization'],
    content: [
      { type: 'text', text: 'We minimize ' },
      { type: 'protected', id: 'loss', kind: 'math', source: '\\mathcal{L}(\\theta)' },
      { type: 'text', text: '.' },
    ],
  }],
};

const engine = new TranslationEngine(new MockProvider(), { batchSize: 8 });
const abort = new AbortController();
for await (const batch of engine.translate(document, {
  targetLanguage: 'zh-CN',
  profile: 'academic',
  signal: abort.signal,
  glossary: [{ source: 'Optimization', target: '优化', policy: 'translate', domain: 'all' }],
  glossaryDomain: 'machine-learning',
})) {
  console.log(batch.completed, batch.total, batch.translations);
}
```

在仓库根目录运行 `npm run example:sdk` 可执行完整 Node 示例；也可运行 `npm run example:sdk -- ./document.json`，输入须为统一文档 JSON。示例中的数学表达式和引用是人工准备的结构数据，不代表已实现 PDF / LaTeX 解析。

每个结果块包含 `id`、带保护标记的 `text` 和已还原的 `content` 树。一般适配器使用 `content`；需要按标记绑定原节点的适配器可使用 `text`。译文始终是数据：HTML 渲染使用文本节点，LaTeX 导出器负责转义译文中的特殊字符，不得把模型输出直接当作可执行标记语言。

## 真实 API Provider

```ts
import { OpenAICompatibleProvider, TranslationEngine } from '@pagelingo/translation-core';

const provider = new OpenAICompatibleProvider({
  baseUrl: 'https://api.example.com/v1',
  model: 'your-model-id',
  apiKey: 'read-from-your-trusted-local-configuration',
  temperature: 0.1,
  responseFormat: 'json-object',
  maxOutputTokens: 4096,
  timeoutMs: 25_000,
});
const engine = new TranslationEngine(provider, { batchSize: 4 });
// Use engine.translate(document, options) as above.
```

Base URL 只追加 `/chat/completions`，不猜测或重复追加 `/v1`。生产地址使用 HTTPS，本机 loopback 可用 HTTP。URL 不接受内嵌凭据、查询参数或片段；请求禁止重定向、携带网站 cookie 或由浏览器 HTTP 缓存复用。

`responseFormat` 可选 `json-object`（默认）、`json-schema`、`text`。JSON Schema 需要服务支持；`text` 不发送 `response_format`，仍要求模型输出 JSON，可去除整个答案外层的 JSON code fence。所有模式都由引擎进行相同的块与保护结构校验。没有自动探测失败后的隐式重试，服务能力在应用中明确配置。

`maxTokensParameter` 可选 `max_tokens`（默认）或 `max_completion_tokens`。`temperature` 可省略；不接受该参数的服务可由调用方省略。Provider 不根据模型名称猜参数；`thinking: 'disabled'` 仅在调用方明确配置时发送。扩展的自动模式仅对 DeepSeek 官方主机应用此项设置。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)

`fetch` 可注入测试传输；`onUsage` 可接收服务返回的输入、输出和总 Token 数。`ProviderError` 导出 `code` 与可选 HTTP `status`，错误提示不包含服务响应正文、密钥或原文。空响应、损坏 JSON、截断和拒绝都作为失败处理，不输出未校验结果。

仓库中 `npm run test:llm` 读取 `.env.local` 或同名进程环境变量，进行少量真实请求；默认 `npm run check` 不连接真实 API。SDK 本身不读取环境变量或本地文件。

## 文档与适配器边界

- 文档含标题、源语言和按阅读顺序排列的块。块 ID 在文档内唯一；行内对象 ID 在块内唯一，不能使用随机槽位作为缓存身份。
- 块类型包含段落、标题、列表项、引用段落、图注和表格单元。`sectionPath` 从外到内排列章节标题；其内容同样必须经过适配器的可见性和排除规则过滤。
- `text` 是可翻译文本；`format` 保留强调、链接等结构，但翻译其内部自然语言；`protected` 保留公式、代码、引用、标识符、URL 或其他原样内容。
- `format.kind` 支持 `underline` 和 `style`。颜色等具体样式由应用按对象 ID 保存，SDK 仅校验格式边界与嵌套，不接收 CSS。提示词变量与答题线使用 `protected.kind='literal'`，译文必须保留每个对象一次；独立的占位行可由应用直接保留，不需要请求模型。
- 适配器保存 `(blockId, inlineId)` 到 DOM 节点、PDF 坐标或 LaTeX AST 位置的映射。链接地址、页面权限、密钥和 UI 状态不进入通用文档模型。
- SDK 生成确定性的块内标记，保护源文本中碰巧出现的 `⟦...⟧`。还原使用原始对象数据，不接受模型替换公式或代码的内容。
- SDK 不解析 PDF、OCR 或 TeX 语法，也不负责阅读顺序修复、排版或重新编译。先将这些格式转换为文档模型，再把结构化译文交给对应输出适配器。

完整性检查是结构验收，不是语义质量评分。章节、领域、术语和全文一致性的人工评测仍需分别建立。

## Provider 契约

`TranslationProvider.generate(request, signal): Promise<unknown>` 负责传输，返回**已解析、尚未信任的 JSON 对象**。SDK 负责策略和校验：

1. `request.instructions` 是统一翻译指令；`request.data` 是标题、语言、章节及编码块等源数据。
2. Provider 按模型 API 的角色格式发送指令和 JSON 数据。支持结构化输出时传入 `responseSchema`，不支持时将 schema 作为输出格式要求附入请求；Provider 不自行另写翻译提示词。
3. 模型返回结构为 `{ translations: [{ id, text }] }`。SDK 检查 schema、块集合、所有标记的数量和嵌套，成功后才输出该批结果。
4. Provider 应传递 AbortSignal 给实际请求。SDK 也会在取消时停止等待、丢弃迟到结果；这不保证服务端停止生成或计费。

API Key、endpoint、model 和生成配置由具体 Provider 构造参数持有，不放进文档对象。浏览器扩展的真实 SDK 执行和 Provider 位于可信后台；仅本地 Mock 布局预览在 content script 执行。

未设置 `reliability` 时保留旧行为：按块数严格分批、失败抛错、无隐式重试。文档在开始迭代时快照，消费方 `break` 后不请求新批次；取消丢弃迟到结果。

## 可靠执行与存储注入

```ts
import {
  OpenAICompatibleProvider, TranslationEngine, ConcurrencyScheduler,
  chatCompletionsUrl, type CacheEntry, type TranslationCache,
} from '@pagelingo/translation-core';

const baseUrl = 'https://api.example.com/v1';
const model = 'your-model';
const generation = {
  temperature: 0.1, responseFormat: 'json-object' as const,
  maxOutputTokens: 4096, maxTokensParameter: 'max_tokens' as const, stream: false,
};
const provider = new OpenAICompatibleProvider({
  baseUrl, model, apiKey: 'load-from-your-trusted-configuration', ...generation,
  timeoutMs: 120000, firstResponseTimeoutMs: 25000, idleTimeoutMs: 25000,
});
const entries = new Map<string, CacheEntry>();
const cache: TranslationCache = {
  get: async (key) => entries.get(key),
  putMany: async (values) => { values.forEach((value) => entries.set(value.key, value)); },
  delete: async (key) => { entries.delete(key); },
};
const scheduler = new ConcurrencyScheduler(2); // Share between documents.
const engine = new TranslationEngine(provider, { reliability: {
  identity: { endpoint: chatCompletionsUrl(baseUrl), model, generation },
  budget: { maxInputTokens: 6000, maxOutputTokens: 4096,
    contextWindowTokens: 32768, maxBatchBlocks: 4, reserveTokens: 512 },
  cache, scheduler, maxRetries: 2,
} });
```

示例 Map 只存内存。生产应用注入 IndexedDB、SQLite 或文件存储；参考 `apps/extension/src/background/database.ts`，SDK 不依赖该实现。`identity.generation` 必须包含实际生效参数，包括服务特有选项；不要放 API Key。额外上下文依赖通过 `dependencies` 传入实际内容快照；`translate` 的 glossary 参数由 SDK 自动计算当前块实际命中的术语依赖。

`failures` 单独报告保留原文的块；`completed` 只计成功原块，拆分单元不会重复计数。`metrics` 记录请求、重试分片、缓存块、耗时及服务报告的用量；`usageRequests` 表示有用量报告的请求数。成功部分立即可用，不随坏块重试。

`TranslationStateStore.load/save` 持久化 `TranslationCheckpoint`。save 同时接收缓存写入，应用尽可能在同一事务保存；应用负责作业授权和版本围栏，失效时抛出 `CheckpointConflictError`。inflight 已消耗的 attempt 和 `nextRequestAt` 冷却截止时间在恢复时保留。共享 scheduler 的 `deferUntil(endpoint, deadline)` 延迟该服务的新请求，不占活跃请求槽；应用重启后应恢复仍有效的任务冷却。普通存储失败降级并出现在 `metrics.storageWarning`；围栏冲突终止旧执行。

预算是通用估算，不等于模型 tokenizer 或账单。保护对象无法拆分、最小单元仍截断时保留原文。SSE 只收集最终内容，不使用 reasoning 文本；完整结构校验后才输出，不逐字符写入页面。网络中断或取消不能保证服务端不计费。

## 构建、复用和更新

仓库根目录：

```bash
npm ci
npm run build:sdk
npm run test:package
```

`test:package` 将 tarball 安装到仓库之外的临时项目，验证公开入口、类型声明和 Node 执行。安装使用 `npm ci` 已填充的本地 npm 缓存，不访问网络。

尚未发布 npm 包。需要交给其他本地项目时，在仓库根目录执行：

```bash
npm pack --workspace @pagelingo/translation-core --pack-destination /tmp
```

然后在消费项目中执行 `npm install /tmp/pagelingo-translation-core-0.3.0.tgz`。开发时修改 SDK 源码后执行 `npm run build:sdk`，或单独运行 `npm run dev:sdk` 持续编译；扩展的 `npm run dev` 加载 SDK 构建产物。

应用需要升级 SDK 并重新构建、分发，才会获得改进。0.3.x 接口仍会演进，应固定版本。`PROMPT_VERSION` 与 `PROTECTION_VERSION` 已单独导出；缓存 key 已包含模型、endpoint、生效配置、上下文及显式 dependencies，不能只使用 SDK 包版本或只用原文作为 key。个人词表通过 `glossary` 和 `glossaryDomain` 传入，解析 / 合并 API 及使用方式见 [词表维护](../../docs/glossary.md)。

## 后续核心能力

- M2 已实现预算、有限重试、调度、版本化缓存与检查点契约；具体存储由应用注入。
- M3 个人术语已实现：领域选择、词边界和最长匹配、英文 / 固定译名 / 双语保护、prefer-source 软偏好与相关缓存依赖。
- 后续 M3：自动领域识别、文档上下文分析、内置及动态词表与共享人工评测。

不在 SDK 中引入 React、`chrome.*`、DOM、Node 文件系统、浏览器任务持久化或云服务。Python 应用后续可以通过 Node CLI 或本地服务调用同一份引擎，避免维护重复的翻译策略。

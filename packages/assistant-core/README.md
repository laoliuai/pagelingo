# @pagelingo/assistant-core

可独立安装的技术阅读对话 SDK。接收纯数据的 `ReadingDocument`、问题、引用和历史，管理上下文预算、相关段落选择及较早对话摘要，通过 Pi Agent runtime 调用 OpenAI compatible Chat Completions 服务。

不依赖 React、Chrome、DOM、数据库或特定文件格式。网页、PDF、LaTeX 应用负责内容适配、权限、凭据、持久化和展示；初版没有搜索或工具调用。

```ts
import { AssistantEngine, PiChatProvider, type ReadingDocument } from '@pagelingo/assistant-core';

const document: ReadingDocument = {
  key: 'pdf:your-document-id', revision: 'content-v1', title: 'An article',
  blocks: [{ id: 'p1', kind: 'paragraph', text: 'A technical paragraph.', sectionPath: [] }],
  warnings: [],
};
const provider = new PiChatProvider({
  baseUrl: 'https://your-provider.example/v1', apiKey: 'YOUR_KEY',
  model: 'YOUR_MODEL', stream: true,
});
const cancel = new AbortController();
for await (const event of new AssistantEngine(provider).run({
  document,
  question: { id: 'q1', role: 'user', text: '解释这一段', quotes: [], createdAt: Date.now() },
  history: [], mode: 'auto',
  budget: { maxInputTokens: 12000, maxOutputTokens: 4096, contextWindowTokens: 32768 },
}, cancel.signal)) {
  if (event.type === 'delta') process.stdout.write(event.text);
  if (event.type === 'summary') { /* Persist event.summary alongside the full history. */ }
  if (event.type === 'context') { /* Show actual coverage and the estimated input size. */ }
}
```

`auto` 使用完整的小文章；超预算时按引用位置、邻近段落和问题关键词选取片段。`full` 要求全文，超预算会报错；`selection` 仅提供引用、问题、文章信息及历史。输入估算按 UTF-8 字节保守计算，属于预算控制，不能替代具体模型的 tokenizer。问题和引用完整保留，超预算时不会静默截断。

`quotes[].text` 是用户实际选中的内容，`quotes[].label` 仅标明来源章节或文章标题。完整选区与问题共同组成最后一条自然语言用户消息，文章正文和来源元数据另放在前一条仅供参考的 JSON 消息中；两者通过同一次模型请求发送。来源段落 ID 指向所在位置，不将整段扩大为选区。引用使用自适应长度的 Markdown 围栏，保留代码缩进、换行与末尾换行。「这个东西」「这段代码」等含糊指代默认指向本轮选区；先解释所选概念或代码，按需补充文章背景。明确指定其他对象或要求总结全文时以用户问题为准。应用的预览截断不应修改 SDK 输入或历史中的引用快照。

0.2.0 调整了模型请求的消息格式，公开的文档、引用和历史 schema 不变。自定义 `ChatProvider` 应转发 `ChatRequest.messages` 中的角色与文本，支持连续的用户消息，不应假设最后一条用户消息可以解析为 JSON。历史中的问题和引用也使用与当前问题一致的自然语言格式。

历史超过阈值时，SDK 额外请求模型生成摘要，发出 `compacting` / `summary` 事件。调用方保存摘要和全部原始消息，下一次传回 `summary`；`throughId` 标明摘要覆盖的历史位置。中断或失败的回答不会作为已完成对话提供给模型。每个调用绑定传入的文档快照，SDK 不修改调用方的数据。

`PiChatProvider` 支持 SSE、普通 JSON 响应、`max_tokens` / `max_completion_tokens`、关闭思考选项、超时和取消。错误不包含服务端原始响应或密钥；不会自动重试请求。API 地址要求 HTTPS，localhost / loopback 可使用 HTTP。用 `fetch` 参数注入传输层以测试或适配环境。

应用可以实现 `ChatProvider` 替换模型传输，也可以实现 `ConversationStore` 使用自己的持久化后端。SDK 只定义存储接口；本仓库扩展用独立 IndexedDB 实现历史上限和并发保护。`webDocumentKey` 提供网页 URL 规范化，其他应用应使用自身稳定的文档 ID。

开发：在仓库根目录运行 `npm run build:assistant`、`npm run test:assistant`；`npm run test:package` 会在仓库外安装 tarball 并验证类型与 Node 运行。SDK 的公共类型不暴露 Pi 的内部事件和消息格式。

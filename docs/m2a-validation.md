# M2-A 交付与验收记录

日期：2026-10-06。当前完成真实网页翻译闭环；M2-B 的缓存、调度与恢复，以及 M3 的术语和质量评测继续按计划推进。

## 已实现

- `translation-core` 的 `OpenAICompatibleProvider`：通用 Chat Completions fetch、JSON Object / JSON Schema / 提示词 JSON、可配置输出参数、超时、AbortSignal、HTTP / 截断 / 空响应等错误分类、可选 Token 用量回调。
- 真实翻译引擎运行于扩展后台。内容脚本发送纯文档，通过 Port 接收通过 SDK 校验的结果；每批消费后继续下一批。
- 可信 popup / options 和右键菜单发放一次性标签页授权。页面不能指定 endpoint / Authorization，也不能自行启动未授权会话；Key 存于可信扩展上下文。
- 设置页的服务授权、短句连接测试与显式兼容配置；全文与选中翻译、进度、取消、模式切换及原文恢复。
- 独立 Node 联调脚本读取 `.env.local` 或进程变量，配置不注入扩展构建。构建产物检查不含实际本地 Key；默认检查不调用付费模型。

## 实际模型与页面

配置模型：`deepseek-flash`，API 根地址 `https://api.deepseek.com/v1`。使用 JSON Object、Temperature 0.1；应用显式关闭该官方服务的思考模式。[JSON Output 参数](https://api-docs.deepseek.com/guides/json_mode/)、[思考模式参数](https://api-docs.deepseek.com/guides/thinking_mode/)

SDK 联调：一批 3 个固定段落，耗时 950 ms，675 输入 Tokens、99 输出 Tokens、共 774 Tokens。结构校验通过，代码与公式从本地原对象还原，链接格式保留。示例输出：

> 该实验未显示出显著改善。延迟降低了 15%，从 200 ms 降至 170 ms。

这段输入和输出来自仓库自编联调样例；单次示例正确不代表翻译质量已全面达标。

扩展联调：[DeepSeek JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/)，12 个正文块，3 批翻译，耗时 2242 ms；另有一次短句连接测试，合计 4 次 API 请求。真实流程“页面 → 提取 → 后台 SDK → 模型 → 结构校验 → DOM 回填 → 模式切换 → 恢复原文”通过；正文 HTML 在恢复后与初始值相同。耗时仅为该次实测，不是服务延迟承诺。

该真实页面暴露了标题中零宽锚点的问题：模型会遗漏没有可见内容的格式标记。DOM 适配器现在把空格式、零宽标题链接和图标链接保留在原节点，不向模型发送空成对标记；相关段落保留原文。补充了确定性单元样例及文档页 fixture，校验规则仍然检查所有实际发送的格式标记。

## 自动化检查

`npm run check` 全部通过：65 项单元测试（SDK 43、DOM / 设置 22）、1 项 SDK tarball 独立安装与 Node 消费测试、类型检查、生产构建，以及 16 项 Chromium 扩展回归。

SDK 覆盖请求构造、兼容模式、HTTP 错误、无效输出、结构破坏、超时、取消和迟到结果；浏览器覆盖取消 fetch、popup 关闭、页面变化、未授权 host、伪造会话、错误不回填、密钥不可读与安全选中翻译。独立包消费同时验证 Mock 和真实 Provider 的公开入口，传输使用测试实现。

默认 Chromium 使用本地 API fixture，验证实际后台网络路径及确定性结果；不代替真实模型或语义质量评测。真实联调由 `npm run test:llm`、`npm run test:llm:extension` 单独触发，使用临时浏览器配置，不输出 Key、请求正文或含密钥的 trace。

## 当前限制与后续

- 当前每批 4 个块顺序执行、默认单次输出上限 4096 Tokens，按块数分批，尚未按输入 Token 预算拆分。单次请求 25 秒超时，以便在后台失去连接前返回明确错误。
- 没有自动重试、IndexedDB 缓存、跨标签页全局并发控制或后台回收后的任务恢复。失败或后台断开时保留已完成译文；重新开始会再次请求。取消不保证服务端停止生成或计费。
- 个人 glossary 当前仅保存，不影响译文。领域术语、动态上下文与人工评测属于 M3。
- 无头测试对临时副本预授目标网页和 API host 权限；生产 manifest 无默认 host_permissions。原生浏览器按钮的 activeTab 与权限确认窗口，以及 Edge 手动验收仍需本地安装测试。
- 真实站点目前验证一篇文档文章；完整 arXiv HTML / GitHub README / 文档站点回归属于后续验收。PDF / LaTeX 仍为规划。

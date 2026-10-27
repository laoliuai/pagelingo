# PageLingo 浏览器扩展

当前优先开发的应用，规格见 [web-spec.md](../../docs/web-spec.md)。M2（A / B / C）已实现：真实翻译、预算与分片、全局并发、有限重试、IndexedDB 缓存和 worker 恢复。见 [安装指南](../../docs/install-m2.md) / [验收记录](../../docs/m2-validation.md)。插件 / SDK 0.3.0 已实现 M3 个人术语部分，见 [词表维护](../../docs/glossary.md)；自动上下文、内置 / 动态词表与人工质量评测仍待后续。

从仓库根目录运行 `npm ci`、`npm run build`，在 Chrome / Edge 加载 `apps/extension/dist/`。重新构建后需重新加载扩展并刷新已注入的网页。

插件 0.4.4 / translation-core 0.4.0 支持译文局部颜色、背景高亮、下划线，以及 PDF 导出 HTML
提示框的变量与答题线。格式类型和对象 ID 通过通用 SDK，具体样式留在本地绑定；
提示框角色列与示例映射直接保留。插件当前仅支持 HTTP/HTTPS；翻译本地阅读包时通过
本地静态 HTTP 服务打开，具体命令见安装指南。

0.2.1 修复 X 帖子与长文的 `div` 正文提取，按当前帖子链接选择正文；中文插入原文下方，保留原节点和交互，互动计数与回复更新不使正文译文失效。X 的“仅译文”也保留原文。布局预览直接显示在当前网页，不调用 API。

0.2.2 区分正文变化与自动样式、追踪属性、X 通知标题和媒体更新。相同正文节点被重建时重新绑定已完成译文，继续当前任务及后台恢复；真实文字、链接、代码、公式、段落数量/顺序或可见性变化时自动停止并显示原因。停止或失败后可直接点击“重新翻译”，无需先恢复页面，有效缓存继续复用；“已停止”表示任务已经取消。

在设置页填写 API 根地址、Key、Model，点击“授权并测试连接”；然后使用 popup 的“翻译当前页面”或右键菜单的“翻译选中内容”。兼容选项包含 JSON 输出方式、Token 参数、输出上限和思考模式。`.env.local` 仅用于根目录联调脚本，浏览器安装包从设置读取配置。

生产 manifest 只声明可选 API host 权限，实际授权在用户点击时针对配置的主机请求。持久化会话绑定标签页、documentId 和正文版本，content script 不传 endpoint / Key。停止/失效持久化取消；后台重启验证原文后重连，按原块 ID 幂等回填。页面/整个浏览器重载后由用户再次触发翻译，复用缓存或匹配的暂停检查点。

`src/dom` 保存网页节点映射与安全渲染；`src/content` 管理页面会话与失效；`src/background` 管理可信扩展操作；React popup / options 独立于宿主页面。翻译逻辑通过 `@pagelingo/translation-core` 的公开入口调用。

配置和 `tests/unit`、`tests/fixtures.ts`、`tests/e2e` 随应用管理。合成测试页面由代码生成，不依赖本机 HTML 数据文件。根命令 `npm run test:extension`、`npm run test:e2e` 自动先构建 SDK；也可先在根构建 SDK，再在本目录执行自身 npm scripts。测试输出在本目录 `test-results/`。

## 保存到资料站点

在扩展设置的「资料站点」中填写 HTTPS 站点 origin（本机开发可用带固定端口的 HTTP loopback 地址），粘贴站点设置生成的五分钟一次性配对码，再点击「授权并连接站点」。站点设备令牌只保存在 trusted extension storage；原有 LLM 设置与资料归档独立，保存中文原文不需要 API Key，也不会启动模型任务。

在页面打开扩展，点击「保存当前页面原文」。原文先进入独立的 `pagelingo-archives-v1` IndexedDB。若所选资源需要额外主机权限，面板列出主机，可点击授权或「不授权，继续保存」；未获取、过期或无法原生解码的图片保留缺失说明。等待资源授权时请保持来源页面打开。正文不可用时保存真实链接，并保留原因说明。

关闭面板或重启后台不会取消已入队资料。上传以文件为单位恢复，使用持久 capture UUID 和服务器 ingestion UUID 查询缺项；服务器确认后才显示「原文已保存」，链接确认只显示「链接已保存」。自动失败最多五次，之后需要手动重试。取消与服务器提交竞争时以服务器实际结果为准。切换站点或账号后只显示当前账号的归档；重新连接同一站点同一账号可接续原队列。普通翻译缓存清理不删除归档，断开连接也不会删除已排队资料。

新增检查（均不调用真实模型）：

```sh
npm run test --workspace @pagelingo/extension -- tests/unit/archive-outbox.test.ts tests/unit/archive-resources.test.ts tests/unit/archive-background.test.ts tests/unit/archive-client.test.ts
npm run build --workspace @pagelingo/extension
npx playwright test --config apps/extension/playwright.config.ts archive-upload.test.ts
# 显式集成检查：使用临时 PostgreSQL 17、实际站点路由及扩展客户端。
node scripts/with-test-postgres.mjs -- npm run test:integration --workspace @pagelingo/document-service -- tests/integration/extension-archive.test.ts --fileParallelism=false
```

浏览器故障测试使用本地 HTTP 故障注入服务，验证 Chromium 的真实存储、资源解码、权限边界与后台终止恢复。单独的服务集成检查覆盖实际配对、设备鉴权、原文字节上传、提交重放和单一持久 source；默认 unit tests 不需要 Docker。

已验证的界面截图：[紧凑弹窗（浅色）](../../docs/superpowers/specs/assets/2026-10-27-s3-validation/archive-popup-light.png)、[紧凑弹窗（深色）](../../docs/superpowers/specs/assets/2026-10-27-s3-validation/archive-popup-dark.png)、[移动宽度的站点连接](../../docs/superpowers/specs/assets/2026-10-27-s3-validation/archive-connection-mobile.png)。截图只使用本地测试资料与临时配对账号。

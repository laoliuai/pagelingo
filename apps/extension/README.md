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

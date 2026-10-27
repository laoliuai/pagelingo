# PageLingo 私有网站

React / TypeScript 网站已接通登录、个人密码、管理员账号管理、个人模型配置、私有 PDF 资料库和 PDF.js 原件阅读。只显示当前账号保存的真实资料，并支持导入本地阅读包及查看真实处理状态。

安装、密钥与数据库准备见 [学习站安装指南](../../docs/learning-site-install.md)。从仓库根目录执行：

- `npm run build:site`：构建 SDK、文档协议、服务和网站，网站产物位于 `apps/web/dist/`。
- `npm run test:site:e2e`：构建后启动独立 PostgreSQL 与真实同源服务，运行 Chromium 账号、配置、资料库、PDF 与账号隔离测试。仅使用模拟 Provider，不调用模型服务，也不读取 `.env`。显式 `PAGELINGO_TEST_DATABASE_URL` 可使用已有的测试库；每次运行仍创建并删除随机 schema 和临时文件目录。
- `npm run dev:site`：同时启动 API 和 Vite，转发退出信号；Vite 监听 `127.0.0.1:5174`，把 `/api` 代理到 `127.0.0.1:4320`。服务的 public origin 必须对应浏览器访问的网站地址。

生产和同源测试复用 document-service 的静态网站路径。配置 `PAGELINGO_WEB_DIR` 指向构建目录后，服务提供 SPA 与 CSP；API 和缺失资源不会回退到 HTML。默认根 `dev` / `build` 仍运行扩展，默认单元检查不需要 PostgreSQL。

业务 DTO 来自 `@pagelingo/document-contracts`。`apiRequest` 仅接受同源 `/api/v1` 请求，自动带 Cookie、CSRF 和 `cache: no-store`；调用方可传 `AbortSignal` 与上传专用 `idempotencyKey`，204 返回 `undefined`。Query key 必须以 `useSession().user.id` 开头。账号切换、退出与 401 会中止旧请求、清空 Query，并通过 session epoch 卸载敏感表单和后续阅读视图。跨标签页通知仅携带变更信号；不会传递会话或用户数据。

浏览器仅持久化主题偏好；API Key 与会话 token 不写 localStorage / sessionStorage。Provider 的保存回显只含脱敏状态；测试连接需要明确确认，并先保存未保存配置。

视觉验证截图位于 [S1 validation](../../docs/superpowers/specs/assets/2026-10-27-s1-validation/)，使用隔离测试账号、空密码框与空 Key 框。

资料库 `/library` 使用 URL 中的 `q` / `page` 搜索和分页，`/library/:id` 为原件阅读路由。上传一次接收一个 PDF，使用 AbortController 和稳定幂等键重试，服务器确认后才展示“原文已保存 / 等待本地处理”。取消上传不代表已经由服务器接收的原件被删除。

PDF.js 按当前页渲染单个 canvas，支持翻页、缩放与原件下载；使用同源 Cookie 和 64 KiB 分块 Range，不自动预取。离开文档或切换账号会取消渲染、销毁 loadingTask 和独立 worker，并清空 canvas。原件 401 清空会话；404 / 无法解析时提供下载与重试。

构建目录必须整体打包，包括拆分的阅读器 JS、独立 worker，以及 `assets/pdfjs/{cmaps,standard_fonts,wasm}/` 下的本地解码资源与许可证。Vite 开发服务也提供同一路径。未打包 PDF 脚本沙箱 `quickjs-eval.wasm`；应用没有启用 PDF 脚本执行。代码保留显式 `isEvalSupported: false`，但固定版本 PDF.js 6 已移除该旧选项及对应动态求值路径，不能把此兼容字段当作运行时开关。网站 CSP 仅为同源 PDF 解码器允许 `wasm-unsafe-eval`，JavaScript `unsafe-eval` 仍被禁止。

浏览器测试服务只在隔离临时数据库与目录内注册 `/__test/metrics` 和丢失原件的故障注入路径；生产服务不包含这些端点。所有模型计数来自测试服务器的模拟出站传输。

固定 `assets/pdfjs/` 路径使用重新验证缓存，带 hash 的构建资源使用长期 immutable 缓存。常规截图位于忽略的 `test-results/captures/`；仅 `PAGELINGO_CAPTURE_DOCS=1` 会更新文档截图。

资料库与 PDF 详情均可“导入阅读包”。选择本地完整 ZIP 后，浏览器按认证接口返回的生效限额限制文件，以稳定幂等键创建任务，并直接上传 File，不整包读取到 JavaScript 内存。关闭弹窗继续保留任务；重开后可从当前账号最近导入恢复。显式取消会先请求服务器，再停止本地上传；回应丢失或取消与完成竞态均先查询服务器确认。

“阅读包导入完成”只表示服务器已校验并保存包。中文无需翻译、原文待处理、部分译文、缺页/解析不完整、区域图限制和模拟译文分别显示。导入反馈读取确切的 imported readerVersionId；新包未提升为当前版本时，原有已完成版本仍保留。详情仍使用原 PDF 阅读入口，双栏内容阅读和阅读进度属于后续阶段。恢复的任务未提供原目标标识时显示“此前的导入任务”，不假定绑定当前详情页；如需导入当前 PDF，应先取消此前任务再重新选择包。

阅读包 UI 的浅色/深色、桌面/移动截图见 [S2 import validation](../../docs/superpowers/specs/assets/2026-10-27-s2-import-validation/)。

# PageLingo 私有网站

React / TypeScript 网站已接通登录、个人密码、管理员账号管理与个人模型配置。资料库和 PDF 阅读界面由后续任务接入；当前不展示示例资料。

从仓库根目录执行：

- `npm run build:site`：构建 SDK、文档协议、服务和网站，网站产物位于 `apps/web/dist/`。
- `npm run test:site:e2e -- accounts.test.ts`：构建后启动独立 PostgreSQL 与真实同源服务，运行 Chromium 账号与配置测试。仅使用模拟 Provider，不调用模型服务，也不读取 `.env`。显式 `PAGELINGO_TEST_DATABASE_URL` 可使用已有的测试库；每次运行仍创建并删除随机 schema 和临时文件目录。
- `npm run dev --workspace @pagelingo/web`：Vite 监听 `127.0.0.1:5174`，把 `/api` 代理到 `127.0.0.1:4320`。服务的 public origin 必须对应浏览器访问的网站地址。

生产和同源测试复用 document-service 的静态网站路径。配置 `PAGELINGO_WEB_DIR` 指向构建目录后，服务提供 SPA 与 CSP；API 和缺失资源不会回退到 HTML。默认根 `dev` / `build` 仍运行扩展，默认单元检查不需要 PostgreSQL。

业务 DTO 来自 `@pagelingo/document-contracts`。`apiRequest` 仅接受同源 `/api/v1` 请求，自动带 Cookie、CSRF 和 `cache: no-store`；调用方可传 `AbortSignal`，204 返回 `undefined`。Query key 必须以 `useSession().user.id` 开头。账号切换、退出与 401 会中止旧请求、清空 Query，并通过 session epoch 卸载敏感表单和后续阅读视图。跨标签页通知仅携带变更信号；不会传递会话或用户数据。

浏览器仅持久化主题偏好；API Key 与会话 token 不写 localStorage / sessionStorage。Provider 的保存回显只含脱敏状态；测试连接需要明确确认，并先保存未保存配置。

视觉验证截图位于 [S1 validation](../../docs/superpowers/specs/assets/2026-10-27-s1-validation/)，使用隔离测试账号、空密码框与空 Key 框。

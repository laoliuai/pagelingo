# 私有学习站 S1 验证记录

2026-10-27，Linux 本机验证；网站与文档服务均为 **0.1.0**，原扩展仍为 **0.4.5**。S1 完成私有账号与模型配置、PDF 原件保存 / 阅读及本机持久化基础。安装与操作见 [安装指南](learning-site-install.md)。

## 实际执行结果

| 命令 | 本次结果 |
| --- | --- |
| `node --test tests/site/*.test.mjs` | 6 个密钥文件测试通过；5 个需要隔离数据库的 dev smoke 明确跳过，随后在 `check:site` 实际执行 |
| `npm run check` | 类型检查通过；321 单元测试通过（service 101、extension 86、assistant 31、contracts 14、translation 89）；6 glossary + 2 独立包测试通过；55 扩展 Chromium 测试通过 |
| `npm run check:site` | 最后一轮小修复后，`build:site` 通过；87 PostgreSQL 集成测试、20 网站 Chromium 测试、5 dev smoke 全部通过；一个独立 PostgreSQL 生命周期，结束后清理 |
| `npm run test:service:db -- users.test.ts` | 最后一轮聚焦回归：20/20 通过，包含大小写 UUID 的启用 / 停用、密码重置、规范化 DTO / 审计目标与最后管理员保护 |
| `npm run test:site:e2e -- accounts.test.ts` | 最后一轮聚焦 Chromium 回归：9/9 通过，错误当前密码保留有效会话并聚焦错误提示，随后正确修改撤销会话；真实撤销后的密码请求仍清理登录状态 |
| `npm run typecheck --workspace @pagelingo/document-service` / `npm run typecheck --workspace @pagelingo/web` | 最后一轮服务与网站类型检查均通过 |
| `npm run test:site:restart` | 镜像构建 / 内容检查、真实登录 / 上传 / 保存配置、保留命名卷重建 app + db 容器、原件 hash / SourceIdentity、密钥解密、授权与撤销均通过；独立项目 / 卷清理成功 |
| `npm audit --json` | 同一锁文件，控制代理实际执行的审计中，所有级别漏洞均为 0 |
| `git diff --check` | 通过；常规网站检查没有修改任何已提交截图 |

最后一轮小修复只修改密码错误反馈、管理目标 UUID 规范化及外部测试库的 Compose CLI 前提说明；以上聚焦回归与完整 `check:site` 为修复后的实际执行结果。随后在最终业务代码提交 `5812e25` 上重新执行 `npm run check`，类型检查、321 项单测、8 项独立检查和 55 项扩展 Chromium 测试全部通过。容器重建与依赖审计沿用此前同次 S1 验收结果，对应的容器配置和锁文件未改动。原扩展和 SDK 源码未改动。整分支审查及最终修正复审通过，S1 审查项均已关闭。

独立 dev 聚焦命令 `node scripts/with-test-postgres.mjs -- node --test tests/site/dev.test.mjs` 也为 5/5 通过：使用临时 env、随机端口和独立数据库，验证 API / Vite 代理、PDF fallback JavaScript MIME，并分别发送 SIGTERM / SIGINT，确认两端口关闭和退出码 143 / 130。另外验证无效配置、API 端口被占用时命令失败且不终止占用者，以及独立开发库 / 主机原件目录中的 PDF 在开发进程重启后仍可读。没有借用已有开发服务。显式集成 runner 遇到空或不可用测试数据库时失败，不回退用户 `DATABASE_URL`；只有不带数据库的通用 Node 测试命令跳过上述 dev smoke。开发 smoke 的 URL 显式指定随机 `pgl_test_*` search_path，清理后检查 public 对象未改变且自己的 schema 不再存在。

另以全新 runner 自有临时 PostgreSQL 模拟“外部测试库”：外层探针创建唯一 public 哨兵表后，以显式测试 URL 执行上述 5 个 smoke，确认 public catalog / 哨兵值完全不变、没有新增残留测试 schema，再删除自己的哨兵和容器。标准 smoke 不创建 public 哨兵，也不向调用方 public schema 写入。

默认扩展构建含现有 `inlineDynamicImports` 被忽略提示，Playwright 含 `NO_COLOR` / `FORCE_COLOR` 冲突提示，不影响退出码和测试结果；网站检查无这些提示。未调用真实模型或使用用户现有 `.env.local`。PDF 原件上传、阅读、设置保存不触发模型；网站测试的显式连接测试使用受控模拟 Provider。

## 构建与运行版本

| 组件 | 实际版本 |
| --- | --- |
| Node / npm | 24.13.0 / 11.6.2 |
| Docker Engine / Compose | 29.8.2 / 5.6.0 |
| PostgreSQL | 17.11 |
| Fastify / Vite | 5.12.7 / 8.3.5 |
| PDF.js / Playwright | 6.4.299 / 1.63.0 |
| Playwright 浏览器 | Google Chrome for Testing 153.0.8010.12 |

构建与运行镜像固定为 `node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f`；数据库固定为 `postgres:17.11@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe`。

镜像包含整个 `apps/web/dist`：拆分 Reader、带 hash 的 worker、CMap、标准字体、WASM 与许可证。验收检查容器内第一方构建产物不含本次测试密码、假 Key、已知 UI 测试密码和本机工作区路径；不含 `.env.local`、`.git` 或第一方测试目录。PDF 脚本沙箱 `quickjs-eval.wasm` 不打包。固定 PDF 资源使用 `no-cache`，带 hash 的资源使用 immutable 缓存；同源 CSP 只允许 PDF 解码所需 WASM 求值，禁止 JavaScript `unsafe-eval`。

重启验收不是用 `hasApiKey` 代替解密：重启后在容器内部读取数据库密文，通过实际 runtime keyring 和 owner AAD 解密，与 stdin 传入的假 Key 比较，只输出通过 / 失败。local / production 禁止注入 `outboundFetch` 的边界保持不变，未为测试增加后门或调用远端模型。

## 视觉与阅读证据

已提交的 13 张代表截图位于 [S1 validation 目录](superpowers/specs/assets/2026-10-27-s1-validation/)，均为隔离测试账号、空密码 / Key 输入框：

- 登录与账号：[login-mobile.png](superpowers/specs/assets/2026-10-27-s1-validation/login-mobile.png)、[admin-light.png](superpowers/specs/assets/2026-10-27-s1-validation/admin-light.png)、[admin-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/admin-dark.png)。
- 配置：[settings-mobile.png](superpowers/specs/assets/2026-10-27-s1-validation/settings-mobile.png)、[settings-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/settings-dark.png)。
- 资料库：[library-desktop-light.png](superpowers/specs/assets/2026-10-27-s1-validation/library-desktop-light.png)、[library-desktop-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/library-desktop-dark.png)、[library-mobile-light.png](superpowers/specs/assets/2026-10-27-s1-validation/library-mobile-light.png)、[library-mobile-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/library-mobile-dark.png)。
- Reader：[reader-desktop-light.png](superpowers/specs/assets/2026-10-27-s1-validation/reader-desktop-light.png)、[reader-desktop-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/reader-desktop-dark.png)、[reader-mobile-light.png](superpowers/specs/assets/2026-10-27-s1-validation/reader-mobile-light.png)、[reader-mobile-dark.png](superpowers/specs/assets/2026-10-27-s1-validation/reader-mobile-dark.png)。

本次常规截图写到忽略的 `apps/web/test-results/captures/`，保留已有代表图片不被随机测试账号覆盖；bitmap 断言继续运行。UI 测试实际验证三页 PDF 渲染、缩放、Range 请求、ICC WASM 解码、失效 / 缺失来源提示、上传中断与重试，以及账号切换后的旧请求 / worker 清理，不仅检查 DOM 占位符。

## 范围与限制

S1 已交付登录、密码修改、管理员创建 / 禁用 / 重置账号、本人资料隔离、加密 Provider 配置、显式连接测试、私有 PDF 保存、原件阅读与下载、同源资源和本机卷重启。PDF 状态明确为 `original-saved` / `awaiting-local-processing`。管理账号不赋予读取他人文件的权限。

S2 才交付版本化 reader IR / bundle、校验导入、完整译文与对照 Reader、本地处理 CLI。接入必须绑定同一 owner、document、source hash / sourceVersionId；数据库字段是 `documents.current_source_version_id`，不能用文件名覆盖。原始 P0 schema / parser 产物不变，新处理写入新 run / 目录。

S1 没有 PDF 删除接口、解析 / 翻译 worker、持久阅读进度、网页收藏、设备授权、站内助手或完整备份恢复。公网 HTTPS 运维与跨主机灾备属于 S5；当前 Compose 只供 loopback local 预览。测试使用合成 PDF 和 Chromium，不能据此宣称所有真实 PDF、其他浏览器或生产公网部署已验收。

开发默认使用 `.env.site-dev.local` / `pagelingo-site-dev` / `./data/document-service-dev`，与预览 `.env.local` / `pagelingo-site` 命名卷各自保存账号和 PDF；两者切换只停启相应应用，不隐式迁移数据。API 后端为非 watch 进程，启动错误会使 launcher 非零退出并终止自己的 Vite。

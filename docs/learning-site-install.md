# 私有学习站 S1 安装

S1 提供账号、每人独立的模型配置、PDF 原件保存和原件阅读。网站与服务版本均为 0.1.0。译文包导入、完整译文 / 对照阅读属于 S2；本阶段没有解析 worker、导入成功占位接口或后台翻译。验收证据见 [S1 验证记录](learning-site-s1-validation.md)。

需要 Node.js 24.13.0（`.nvmrc`）、npm 和 Docker Compose。默认 `npm run dev` / `build` 仍是浏览器扩展；网站使用带 `site` 的命令。安装不需要 Python、模型权重或真实模型请求。

## 初始化

在仓库根目录执行 `npm ci`。以下命令创建新的受限 `.env.local`，生成随机数据库密码且不显示它；若文件已存在，命令会失败，请保留并手工合并缺少的网站配置，不要覆盖原文件。数据库密码使用十六进制，避免 URL 编码歧义。

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const password = randomBytes(24).toString('hex');
writeFileSync('.env.local', [
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgresql://pagelingo:${password}@127.0.0.1:54330/pagelingo`,
  'PAGELINGO_SITE_MODE=local',
  'PAGELINGO_SITE_ORIGIN=http://127.0.0.1:4320',
  'PAGELINGO_SERVICE_HOST=127.0.0.1',
  'PAGELINGO_SERVICE_PORT=4320',
  'PAGELINGO_DATA_DIR=./data/document-service',
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
JS
npm run site:keygen
```

`site:keygen` 仅补全缺少的主密钥 ID / keyring 变量，保留其他配置及已有 Key，权限设为 0600，不打印密钥。单独缺 ID 时使用已有 keyring 的首个 ID；单独缺 keyring 时为已有 ID 生成密钥。已有配置不合法或 ID 不匹配时失败，不自行替换密钥。自动化可指定 `-- --file <临时文件>`。保管 keyring：丢失主密钥后无法解密已保存的个人 API Key；轮换时必须保留仍在使用的旧 ID。

## Compose 本机预览

定义同一 shell 会话内使用的命令，固定项目名和配置文件：

```bash
site_compose() {
  docker compose --project-name pagelingo-site --env-file .env.local \
    -f deploy/compose.site.yml "$@"
}
site_compose up -d --build --wait
site_compose exec app node apps/document-service/dist/cli/bootstrap-admin.js --username myadmin
```

管理员密码在终端遮蔽输入，要求 12–128 个 Unicode 码点；用户名为 3–32 个小写字母、数字、下划线或短横线且以字母开头。仅可初始化第一个管理员。自动化使用 `exec -T` 与 `--password-stdin`，通过秘密管理工具的 stdin 传入密码，不放进参数或命令历史。

访问 <http://127.0.0.1:4320>。Compose 明确使用 `local` 模式：HTTP、非 Secure 本机会话 cookie，app 仅绑定主机 loopback；数据库没有主机映射。不要将这份预览配置直接公开到互联网。真正的 production 配置必须使用 HTTPS origin，服务会强制检查；公网 TLS、备份恢复演练属于 S5。

数据库卷为 `pagelingo-site_database`（容器 `/var/lib/postgresql/data`），原件卷为 `pagelingo-site_objects`（容器 `/data/objects`）。迁移在启动时执行，原件不可变写入。镜像不包含主密钥、测试服务或测试账号，运行时以非 root 用户运行；网站的拆分 JS、worker、CMap、字体、WASM 及许可证整体打包。

```bash
site_compose stop                 # 停止，保留数据
site_compose up -d --wait         # 再次启动
site_compose down                 # 移除本项目容器和网络，保留卷
```

`down --volumes` 会删除该项目全部数据库和原件，仅在明确要清空自己的预览数据时使用。数据库、原件卷和 keyring 都需要保存；单独保留数据库无法恢复 PDF，单独保留卷无法恢复权限。S1 重启验收不是完整灾备演练。

## 开发模式

停止 Compose app 后，将 `.env.local` 的 `PAGELINGO_SITE_ORIGIN` 改为 `http://127.0.0.1:5174`。保留上面生成的数据库 URL；`site:db` 使用相同命名项目、卷与密码。首次初始化后不要通过修改 env 密码来尝试修改现有 PostgreSQL 账号密码。

```bash
npm run site:db
npm run build:contracts
npm run site:admin -- --username myadmin  # 仅尚未创建管理员时
npm run dev:site
```

API 在 `127.0.0.1:4320`，Vite 在 `127.0.0.1:5174` 代理 `/api`。开发数据库仅在 `127.0.0.1:54330` 暴露。`dev:site` 明确加载 `.env.local`，先构建协议再启动 API / Vite；Vite 不加载秘密文件，只接收代理端口配置。Ctrl+C / SIGTERM 同时结束两组进程，五秒后强制结束未退出的子进程。端口占用会失败，不自动复用其他服务。测试可指定 `dev:site -- --file <临时文件>` 及 `PAGELINGO_VITE_PORT` / `PAGELINGO_SERVICE_PORT`。

服务的原始 `main` 入口只接受注入的环境，不隐式读取文件。`site:admin` 显式加载 `.env.local`，密码仍由终端或 stdin 输入。独立部署可在构建后使用 `node --env-file=<文件> apps/document-service/dist/main.js`。

## 使用和检查

1. 登录管理员账号，在用户管理中创建普通账号；禁用和重置密码会撤销目标账号旧会话。管理员不能读取其他人的资料。
2. 普通账号在设置中保存自己的 HTTPS API 根地址、模型及 Key。读取仅回显脱敏状态；保存不调用模型。“测试连接”需要明确确认，会请求用户配置的远端服务。
3. 资料库上传 PDF，默认上限 256 MiB。保存后显示“原文已保存 / 等待本地处理”。打开原件阅读，可翻页、缩放、下载；刷新后数据保留。取消上传不会删除服务器已完成接收的文档。
4. 退出登录清理当前页面的私有缓存和 PDF worker。修改密码后需重新登录。S1 不提供删除原件、译文阅读或持久化阅读进度。

```bash
node --test tests/site/*.test.mjs
npm run check
npm run check:site
npm run test:site:restart
```

默认 `check` 保留原扩展 / SDK 回归，不要求 Docker / Python 或付费 API。`check:site` 在一次独立 PostgreSQL 生命周期中构建网站、运行服务集成、Chromium UI 和开发信号 smoke；初次运行需准备 Playwright Chromium（`npx playwright install chromium`）。显式 `PAGELINGO_TEST_DATABASE_URL` 必须是专用的可丢弃测试库：开发 smoke 会应用 public schema 迁移；普通集成和 UI 仍使用随机 schema。不要指向用户数据库。

`test:site:restart` 不读取 `.env.local` 或复用环境里的数据库、项目、卷；创建随机项目、动态 loopback 端口、独立命名卷和凭据，密码通过 stdin，临时 env 为 0600。它真实登录、上传合成 PDF、保存假 Key、保留卷重建 app / db 容器，验证内容 hash、内部解密和权限，并在 finally 删除自己的资源。它不调用真实模型。中断也会清理；若 Docker 失联导致清理失败，只报告本次项目名供人工恢复。

常规 UI 截图写入忽略的 `apps/web/test-results/captures/`，不会改写提交的验收图片。需要更新文档截图时，显式执行 `PAGELINGO_CAPTURE_DOCS=1 npm run test:site:e2e`，人工检查后提交。

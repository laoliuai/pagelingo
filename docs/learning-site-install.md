# 私有学习站 S3 安装

S3 在 S2 的 PDF 阅读包、版本与进度基础上增加网页归档、扩展配对和独立网页翻译 worker。PDF 解析和本地阅读包工作流保持独立；服务器不安装 Python、模型或 PDF CLI。网页先保存原文，只有明确开启偏好或手动开始且配置有效时才运行模型任务。操作见[扩展收藏指南](extension-site-capture.md)，验证范围见 [S3 验证记录](learning-site-s3-validation.md) 和 [S2 验证记录](learning-site-s2-validation.md)。

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

数据库卷为 `pagelingo-site_database`（容器 `/var/lib/postgresql/data`），原件卷为 `pagelingo-site_objects`（容器 `/data/objects`）。API 启动执行迁移；S2 保留 001–005，S3 增量应用 006。worker 等待 API 健康后启动，并校验数据库版本。API 与 worker 必须共享数据库、原件卷和运行时 keyring，原件不可变写入。镜像不包含主密钥、测试服务或测试账号，运行时以非 root 用户运行；网站的拆分 JS、worker、CMap、字体、WASM 及许可证整体打包。

```bash
site_compose stop                 # 停止，保留数据
site_compose up -d --wait         # 再次启动
site_compose down                 # 移除本项目容器和网络，保留卷
```

`down --volumes` 会删除该项目全部数据库和原件，仅在明确要清空自己的预览数据时使用。数据库、原件卷和 keyring 都需要保存；单独保留数据库无法恢复 PDF，单独保留卷无法恢复权限。S3 升级 / 重启验收不是完整灾备演练。

## 开发模式

开发与 Compose 预览是**两套独立数据**：开发使用 `.env.site-dev.local`、`pagelingo-site-dev` 项目数据库与主机 `./data/document-service-dev`；预览继续使用 `.env.local`、`pagelingo-site` 数据库与命名原件卷。不要只共享数据库而切换原件目录。账号、主密钥和 PDF 不自动迁移，两套环境各自初始化管理员。已保存的 PDF 在其原环境内重启后继续可读。

先用 `site_compose stop app worker` 释放 4320 端口；预览的 `.env.local` 保持原样。以下命令独立生成开发凭据，不复制预览密码。已有开发文件时保留并手工合并，不能覆盖：

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const password = randomBytes(24).toString('hex');
writeFileSync('.env.site-dev.local', [
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgresql://pagelingo:${password}@127.0.0.1:54330/pagelingo`,
  'PAGELINGO_SITE_MODE=local',
  'PAGELINGO_SITE_ORIGIN=http://127.0.0.1:5174',
  'PAGELINGO_SERVICE_HOST=127.0.0.1',
  'PAGELINGO_SERVICE_PORT=4320',
  'PAGELINGO_DATA_DIR=./data/document-service-dev',
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
JS
npm run site:keygen -- --file .env.site-dev.local
npm run site:db
npm run build:bundle
npm run site:admin -- --username myadmin  # 开发数据库中首次初始化
npm run dev:site
```

`site:db` 默认只启动 `pagelingo-site-dev` 的数据库，独立卷为 `pagelingo-site-dev_database`，仅在 `127.0.0.1:54330` 暴露。`site:admin` 和 `dev:site` 默认读取 `.env.site-dev.local`；`site:keygen` 默认仍是预览的 `.env.local`，为开发生成密钥时必须使用上面的 `--file`。两个秘密文件均被 Git 和 Docker context 排除。

开发 API 在 `127.0.0.1:4320`，Vite 在 `127.0.0.1:5174` 代理 `/api`。`dev:site` 先构建协议再启动 API / Vite；API 使用非 watch 进程，修改后重新启动。API 配置错误或监听失败会让启动命令失败并结束其 Vite 进程，不接受或终止已存在的服务。Vite 不加载秘密文件，只接收代理端口配置。Ctrl+C / SIGTERM 同时结束两组进程，五秒后强制结束未退出的子进程。测试可指定 `dev:site -- --file <临时文件>` 及 `PAGELINGO_VITE_PORT` / `PAGELINGO_SERVICE_PORT`。

返回预览时先 Ctrl+C 停止开发进程，再运行 `site_compose up -d --wait`，访问原来的 `http://127.0.0.1:4320`；预览账号和 PDF 仍来自预览卷。开发数据仍保留在其独立数据库卷和主机目录，需要时可再次运行 `dev:site`，访问 5174。不要将开发 `DATABASE_URL` 指向预览库，也不要为“切换环境”更改任何已有数据库密码。

服务的原始 `main` 入口只接受注入的环境，不隐式读取文件。管理员密码仍由终端或 stdin 输入。独立部署可在构建后使用 `node --env-file=<文件> apps/document-service/dist/main.js`。
## 使用和检查

1. 登录管理员账号，在用户管理中创建普通账号；禁用和重置密码会撤销目标账号旧会话。管理员不能读取其他人的资料。
2. 普通账号在设置中保存自己的 HTTPS API 根地址、模型及 Key。读取仅回显脱敏状态；保存不调用模型。“测试连接”需要明确确认，会请求用户配置的远端服务。
3. 资料库上传 PDF，默认上限 256 MiB。保存后先读原件；在同一条目导入本地正式 ZIP 后进入对照阅读。导入也可从资料库新建条目。相同账号 / 同包身份幂等，PDF 身份不一致会拒绝。部分译文、未译、模拟译文和解析警告分别显示；完整下载得到原已验证 ZIP。
4. 退出登录清理当前页面的私有缓存和 PDF worker。修改密码后需重新登录。当前不提供删除原件；PDF 译文来自已导入的阅读包，网页译文可由独立 worker 生成，实际阅读交互后保存进度。

```bash
node --test tests/site/*.test.mjs
npm run check
npm run check:site
npm run test:site:restart
```

默认 `check` 保留原扩展 / SDK 回归，不要求 Docker / Python 或付费 API。`check:site` 在一次独立 PostgreSQL 生命周期中构建网站、运行服务集成、Chromium UI 和开发信号 smoke；初次运行需准备 Playwright Chromium（`npx playwright install chromium`）。显式 `PAGELINGO_TEST_DATABASE_URL` 必须是专用测试库；指定后跳过数据库容器的创建，但完整 `check:site` 仍需要 Docker Compose CLI 来校验开发 / 预览配置，这项配置校验不需要 Docker daemon。服务集成、UI 与开发 smoke 都仅在各自随机 `pgl_test_*` schema 内迁移，并在 finally 删除自己的 schema；不会在 public 中创建应用表。不要指向用户数据库。

`test:site:restart` 不读取 `.env.local` 或复用环境里的数据库、项目、卷；创建随机项目、动态 loopback 端口、独立命名卷和凭据，密码通过 stdin，临时 env 为 0600。它先在独立库中建立含账号与原件的 S1（001–004），由服务正常应用 005，登录、导入模拟译文包并保存进度 / 假 Key；保留卷重建 app / db 容器，逐片 / 图片核对、完整下载再验证、检查进度、内部解密和权限，并在 finally 删除自己的资源。它不调用真实模型。中断也会清理；若 Docker 失联导致清理失败，只报告本次项目名供人工恢复。

常规 UI 截图写入忽略的 `apps/web/test-results/captures/`，不会改写提交的验收图片。需要更新文档截图时，显式执行 `PAGELINGO_CAPTURE_DOCS=1 npm run test:site:e2e`，人工检查后提交。

## S1 升级与容量配置

保留同一项目的数据库卷、对象卷和 keyring，再执行 `site_compose up -d --build --wait`。
服务启动校验既有迁移 checksum 并事务应用 `005-reader-bundles`；原件、账号和设置继续保留。
不要删除卷来“完成升级”，也不要单独更换对象目录。镜像构建包含 contracts、renderer、bundle
及 SDK；运行镜像只包含 Node 服务 / 共享包和网站静态资源，不含本地 PDF CLI、Python 或模型。

默认原 PDF / ZIP 各 256 MiB、解压 1 GiB、10,000 文件、IR / 译文各 32 MiB。
管理员可在运行环境显式设置 `PAGELINGO_MAX_PDF_BYTES` 和严格部分对象
`PAGELINGO_BUNDLE_LIMITS_JSON`；PDF 不能在后者重复配置，结构上限只能收紧。
Compose 转发这两个参数。界面使用认证 `/api/v1/bundle-imports/limits` 的实际值。
本次四份真实样本未要求提高预算；具体测量见验证记录。

离线包的可信代码目录与当前构建绑定。升级后历史离线 ZIP 仍可自行阅读；再次导入时若可信
目录不相符，应使用原 ready run 重新导出到新目录 / ZIP，再验证，不能修改旧 manifest。
可传多个当前构建的包执行额外重启验收：

```sh
npm run test:site:restart -- --bundle /path/bert.zip --bundle /path/attention.zip
```

## S4 受控升级验收

S4 使用新增 007–009；上线时先停止旧 API/worker 写进程，再迁移并启动匹配版本。旧包兼容不代表旧二进制可穿越迁移继续写。实际部署属于独立操作；开发验收不操作个人服务。

从仓库根目录构建网站与扩展后，可运行：

```sh
npm run check:site:s4 -- --samples tests/fixtures/site-s4/samples.json --output /tmp/pagelingo-s4-new-run
```

输出必须为新目录，父目录须存在。声明需要至少一份经过实际校验的已发布 PDF 0.1.0/0.2.0 包，供 001–006 的有数据基线使用；不能仅把任意文件标成 bundle。所有输入先做类型、路径别名、单文件/总量、实际 hash 和包校验，然后才创建本次独立数据库、卷和进程。此命令不读取 `.env`、环境中的数据库地址或模型 Key；默认不调用模型、不安装 Python。完整格式见[样本声明说明](../tests/fixtures/site-s4/README.md)，实际证据及未验证范围见[S4 验收](learning-site-s4-validation.md)。

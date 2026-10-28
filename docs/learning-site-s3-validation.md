# S3 网页归档验证记录

S3 的验证分别记录合成来源、匿名公开输入、登录来源与 mock 翻译。合成夹具通过不代表当前真实网站全部支持；mock 回显仅验证保护结构、版本与生命周期，不验证语言质量。当前 X、知乎、公众号登录页面没有可用授权会话，live case 明确为 **UNVERIFIED**，不补造抓取结果。

## 可复现的采集检查

先执行 `npm ci`、`npm run build:site`、`npm run build:extension`。在安装了 Playwright Chromium 和可用 Docker 的环境中：

```sh
npm run check:web-capture -- --samples tests/fixtures/web-s3/samples.json --output /tmp/pagelingo-capture-new-run
```

输出目录必须不存在，父目录必须存在。脚本不读取 `.env`、用户模型 Key 或 `DATABASE_URL`；只允许显式测试数据库地址，否则创建随机命名、loopback 映射的临时 PostgreSQL。API、私有 ObjectStore、随机 schema、浏览器 profile 和 mock worker 均由本次检查拥有并清理，失败报告、截图、trace 留在输出目录。不会终止其他进程或修改生产数据。 收到 SIGINT/SIGTERM 后停止新工作、取消正在等待的请求并统一清理；报告标记 `interrupted`，保留信号、结束时间、逐项清理结果和可用 trace，退出码分别为 130/143。清理步骤失败或超时仍继续尝试其他自有资源；异步清理预算为 3.8 秒，低于数据库 wrapper 的 5 秒升级终止界限。

样本声明为 `pagelingo-web-samples/1`：每项包含唯一 `id`、`kind`（`synthetic` 或 `cached-public`）、原 URL、`htmlFile`、输入 `sha256`、实际采集 `capturedAt`、`expected.scope/contains` 和明确 `unverified`。文件路径相对声明文件；可选 `resources` 包含 URL、文件、媒体类型及 SHA256。检查使用实际构建扩展，仅测试副本增加明确来源和本机站点的 host grants，替代 headless 无法点击 action 授予 activeTab 的限制。生产 manifest 不变。

页面主文档使用声明的原始字节，页面请求由 harness 控制；扩展资源获取仍走实际生产逻辑、`credentials: omit`，已授权来源的 HTTPS 图片可能在检查时匿名下载。未授权、不可解码、未取得的资源保留缺失原因。报告区分输入采集时间和本次检查时间，并保存实际归档文件 SHA256/bytes、范围、原 URL、警告、Reader/job 身份及输入前后 hash。它不是新的登录网站抓取器。

## 来源矩阵

| 来源 | 合成 native 扩展→API→私有对象→独立 worker→Reader | 公开输入 / 当前 live 边界 |
| --- | --- | --- |
| Blog | 中/英文各一份；实际 PNG 字节、代码、MathML、原文与 mock 版本 | 两份 Lilian Weng 文章是 2026-10-27 14:07 UTC 的匿名 HTTP200 原始输入；当前检查只重放这些不可变 HTML，不冒称当天 live 页面 |
| X | 中/英文主帖；排除回复与引用帖子，保留限定 scope | 当前登录 live **UNVERIFIED**；不代表整线程采集 |
| 知乎 | 中/英文独立回答；排除另一回答 | 当前登录 live **UNVERIFIED**；问题页歧义保留链接，不冒充完整回答集 |
| 公众号 | 中/英文文章；`data-src` lazy 图片使用实际原字节 | 当前登录/验证页面 live **UNVERIFIED**；不自动展开不可见内容 |

公开原始输入位置：`data/web-s3/live/public-blog-XHAhox/inputs.json`（忽略目录，仅本地证据）。两个 URL 分别为 [LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/) 与 [A (Long) Peek into Reinforcement Learning](https://lilianweng.github.io/posts/2018-02-19-rl-overview/)。HTML 原始 SHA256 分别为 `03b6ed75b1dc0dedd200a077367d1f7737f0a18e08c104e7f653115e1f52b0ef` 和 `103c1caa52ebfb80ca4cc453322a85cadab0d2dfbba342520a6e52233417773e`。不提交第三方完整 HTML。预冻结的两份重放均为 `partial-resources`、`completeWithinScope:false`，各 13 项资源缺失、0 项图片成功归档，并保留 details/summary 等不支持结构及 MathML 属性清洗警告；不将这两份结果记为完整来源验收。最终报告逐项记录实际状态。

## 生命周期与兼容边界

原文先发布、默认自动翻译关闭、中文零模型调用；手动任务由独立 mock worker 生成明确标记的 mock 版本。native 检查在真实持久提交后丢弃 ACK，再停止 Chrome service worker，重试仍只有一条 capture。关闭来源并阻断源页面后，Reader 继续从本站读取；私有归档与 Reader 图片逐个核对 hash、匿名 401、其他 owner 404。进度、术语、Reader 在 owned API/worker 重启及数据库连接重开后保留。

完整数据库门禁另覆盖实际独立 worker 中断、确认检查点恢复、不重放已完成单元、429 冷却、全局 2/owner 1 槽位、取消、换 Key、停用与迟到发布围栏。这些证据与 Docker 容器重建分别记录，不能把开发进程或 Compose config 检查当成已运行镜像。

`test:site:restart` 使用随机隔离 Compose 项目与运行时生成密钥，实际构建镜像、先建 001–005 的 S2 数据，再由 API 应用 006。固定 S2 包和四份原始 ZIP 通过真实导入接口、私有下载与再验证；保留卷重建 API、worker、数据库后复验 PDF/Web 原文、部分导入译文、术语、进度、权限与资源。每份原 ZIP 在 finally 中记录前后 hash。原始迁移 001–005、P0/PDF/旧包及兼容静态目录不可改写。

## 最终门禁

源冻结后执行的顺序固定为 `npm ci` → `npm run check` → `npm run check:site` → 明确 samples 的 `check:web-capture` → 固定 S2 与四个原包兼容检查 → `npm audit`。首次 `npm ci` 与 `npm run check` 均退出 0（877 个 workspace 单元测试、6 个 glossary、2 个独立 package、63 个扩展浏览器测试）。首次 `check:site` 的全 DB 为 238/251，13 失败、2 个未处理错误，未运行到站点浏览器。原日志和已有 error context/截图均已保留。

未修改源码的 publication + bundle 两文件串行探针为 33/33。随后仅修正两个测试 harness 文件：integration 文件串行执行，publication fixture 用有界轮询消费 nullable `SKIP LOCKED` claim。schema 隔离仍共享数据库全局 advisory locks；捕获监视事务也可能暂时持有 owner 行锁，单次 claim 非空不是 API 保证。保留 isolation 和明确的独立 worker 并发场景，未增加任何超时、未修改生产 monitor。各 timeout 的具体耗时来源未逐一证明，不能一概归因为宿主负载。服务 typecheck 退出 0；修正后完整 DB 为 **251/251（21 files，401.52s）**，没有未处理错误。完整 `check:site` 最终退出 **0**：DB **251/251**、站点浏览器 **87/87（6.9m）**、Node 开发生命周期/CLI **11/11**。前述 root gate 在这两个测试修正前，运行时/shared/static 源码 hash 未变；不把 targeted 探针或旧 gate 冒称成修正后的全套通过。随后仅将新 native 检查 helper 的 mock worker stdout/stderr 转发到原始 CLI 日志；最终 native gate 覆盖该诊断改动。734 个非文档文件与 728 个实际 dist 文件按最后一次快照核对；最早的源快照未包含 ignored dist，不补造早期 dist hash 证据。Python 未修改，沿用 S2 证据，不安装模型或重跑解析。

任务审查 I1 发现 native CLI 中断时可能绕过清理。修正后重新冻结 CLI/测试 harness，再顺序运行完整 Node 生命周期/CLI 组（**14/14**，含实际 SIGINT/SIGTERM 和清理失败回归）及明确声明的 native 检查（**10/10**）。实际信号通过 CLI → wrapper 传递，在自有 worker、Chromium、私有 store/profile 和 schema 已建立后触发；退出 130/143，245/197 ms 完成关闭，所有清理步骤通过，保留中断报告与 trace，独立进程、schema、文件哨兵均存活。运行时/shared/static 与 728 个 dist 文件未变；没有把旧 root/DB/站点浏览器门禁重新标记为修正后重跑。失败探针及各轮结果独立保留，`acceptance-summary.json.reviewFixes` 记录此次源码 hash 和结果。

后续 I1 审查发现，首次等待超时后才完成的资源获取仍可能逃过一次性清理。第二轮修正将 schema 创建置于事务内，在提交前检查取消，DROP 明确等待创建/回滚完成；迟到的 app、监听器、Chromium context 和文件操作结果先执行自身释放，再离开跟踪集合。最后的 drain 只使用原 3.8 秒预算剩余时间，不增加 wrapper 的 5 秒界限。新增实际 PostgreSQL 延迟 CREATE 回归先复现了 schema 遗留，修正后退出143、1184 ms 内 schema/root 均不存在、哨兵保留；报告仍明确记录最初 1000 ms 等待超时，后续 DROP/drain 通过。迟到 app/context helper 用实际 HTTP server/Chromium context，在首次等待超时及普通资源查找结束后才返回资源，验证释放确实完成。第二轮冻结后 Node **18/18**、native **10/10**；原有获取完成后的 SIGINT/SIGTERM 也再次通过（130/143，209/260 ms）。这些补充证据不替代或重标历史全套门禁。

## 本次结果与证据

2026-10-28（Asia/Shanghai）完成以下检查；命令退出码均按各自实际 run 记录。

| 检查 | 最终结果 / 范围 |
| --- | --- |
| `npm ci` | 0；锁定版本安装；node-domexception 的既有弃用提示保留 |
| `npm run check` | 0；877 units / 77 files，glossary 6，独立 package 2，扩展浏览器 63；在上述测试 harness 修正前 |
| 修正后的 service typecheck | 0；覆盖有界 claim fixture 与串行配置 |
| 修正后的 `npm run check:site` | 0；DB 251、站点浏览器 87、Node 生命周期/CLI 11，全数通过 |
| `check:web-capture -- --samples <明确的合成8+缓存公开2声明> --output <新目录>` | 0；10 个声明场景，合成8完整；公开缓存2为明确的部分资源/范围结果 |
| `check-s2-compat.mjs` | 固定 S2 ZIP 1/1、四个原始 ZIP 4/4，退出0，所有输入前后 hash 相同 |
| `npm audit --json` | 0；info/low/moderate/high/critical 均为0 |
| 实际 Docker `test:site:restart`，显式传入五个 `--bundle` | 0；镜像构建/运行、S2→006、API/worker/DB 保留卷重建与五包导入/下载复验；运行时源码与最终状态相同 |

[实际 UI 截图与机器可读索引](superpowers/specs/assets/2026-10-27-s3-validation/README.md)保留配对、合成英文 Reader、合成中文公众号 Reader、公开缓存文章的部分归档 Reader。截图未编辑；不是当前登录来源截图。`acceptance-summary.json` 含每份来源 URL、输入/归档文件 hash、时间、scope、资源缺失原因、明确未验证项、前后 gate 记录及 S2 hash。原始日志、失败 context、trace 和详细报告留在忽略的 `.superpowers/sdd/2026-10-27-learning-site-s3/task-13-evidence/`，没有提交用户凭据或第三方完整 HTML。

实际 Docker 验证使用独立生产 worker 入口；模型结构测试使用独立测试 mock worker。两者不可合并声称 Docker 内真实模型质量通过。Docker 的 Web 部分保留的是受支持的部分导入译文和明确缺失图片状态；真实私有图片保留由五个 PDF 包（1/9/16/141/69 张）及 native Web 实际图片资源检查分别证明。固定 S2 包的 PDF 是历史合成合同夹具，四份原始 ZIP 才是真实 PDF 资料。

任务交付仍待独立任务审查与整分支审查；这些结果不代表 S3 已合入、已发布或所有真实登录来源已验收。

## 工具输出与 Minor 账本

- Playwright 子进程设置 FORCE_COLOR 时移除冲突的 NO_COLOR；没有关闭全部 warning。
- PDF 移动几何诊断仅在 `PAGELINGO_DEBUG_GEOMETRY=1` 时输出；相关行为断言保留。
- CRX 3.0.0 的内置 IIFE 配置仍传 `inlineDynamicImports`，Vite/Rolldown 提示其在 `codeSplitting:false` 下忽略。保留 warning，冻结版本下不修改依赖内部构建行为。
- Vitest transform-cache/isolation 的性能建议保留，隔离没有关闭。它不是测试失败，也未据此放宽超时。
- 既有 schema/lease 与 Reader page/job-status 的紧凑格式列为未完成 Minor：本任务没有扩展这些产品逻辑，不为格式重写已审查的大块代码。交控制方最终审查，不能静默丢弃。

- 任务审查 M1：restart harness 的 finally 中，若原 ZIP 变得不可读，hash 读取错误可能跳过后续 Compose 清理；记录为整分支审查待处理 Minor，本轮 I1 修正未改动该路径。
- 任务审查 M2：本地 samples 声明/输入文件的前置大小、数量与字段约束仍可收紧；受信任声明已验证，本轮没有扩展为通用输入加固。

执行期间的全部 R1–R30 及判断错误时的返工范围，见 [执行裁定记录](learning-site-s3-decisions.md)。任务级审查已完成；整分支最终审查与集成选择仍由控制方执行。

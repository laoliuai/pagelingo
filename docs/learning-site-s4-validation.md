# S4 收藏、来源与私有管理验收

本轮验收覆盖声明输入、001–006→007–009 有数据升级、真实进程中断恢复，以及收藏到离线读取和永久清理的完整链路。任务/整分支审查由后续审查 gate 决定；此文不表示已经合入、推送或部署。

实际命令、退出码、来源矩阵、运行时/输入身份及精选截图以[机器可读摘要](assets/learning-site-s4/acceptance/summary.json)为准。实施中已有 36 项裁定见[裁定记录](learning-site-s4-decisions.md)。本任务新增决定：完整验收必须显式声明至少一份实际校验通过、匹配已发布 PDF 0.1.0/0.2.0 目录的包，作为有数据 S3 基线；不以调用方的 `bundle` 标签代替校验。GitHub 同 URL 的 descriptor/raw/HTML 响应由实际 Accept 值区分。

## 可复现入口与边界

```sh
npm ci
npm run build:site
npm run build:extension
npm run check:site:s4 -- --samples tests/fixtures/site-s4/samples.json --output /tmp/pagelingo-s4-new-run
```

[默认声明](../tests/fixtures/site-s4/samples.json)明确标记为合成材料，包含本地文章、GitHub 文档子页 URL、已发布 S2/S3 包及两个合成论文版本。默认命令只证明已声明材料的覆盖；未声明来源仍未验证，实际完整公开来源和三类中断证据以本轮摘要为准。详细声明格式、512 MiB 总量/单文件上限、路径别名规则、流式读取和资源所有权见[说明](../tests/fixtures/site-s4/README.md)。

只读预检在创建输出、服务或数据库之前完成：声明 UTF-8≤1 MiB、1–32 项、资源≤256；样本 ID 必须是唯一的非空限定字符串；逐项 stat 校验路径/文件类型/限额，拒绝符号链接、硬链接别名和已有输出；依次流式核验实际输入 hash，再校验已发布包。GitHub 元信息 1 MiB、README descriptor 2 MiB、raw/commit 1 MiB、HTML 8 MiB 与总计 64 MiB 限额也在读取前执行，API 响应按明确的 Accept 区分，不能用调用方文件角色绕过。运行期间重新核验身份/大小/hash。不会整体加载所有样本。此命令忽略环境中的个人数据库/站点/模型配置，不读取 `.env`，不安装 Python，不调用真实模型。

真实公开材料另用声明记录本次匿名实际响应：GitHub `octocat/Hello-World` 的 repository metadata、commit、README descriptor/raw/HTML；arXiv `1706.03762v1`、`1706.03762v2` 的 Atom 和 PDF。原始响应、时间、HTTP 状态、字节/hash 保存在本次忽略的原始证据目录。公开摘要保留响应身份，仓库不提交论文 PDF 或原始日志。这些材料在采集时实际请求公开来源，进入应用时使用受控的 **cached-public 回放**；不把回放称为应用端实时抓取。`live-public` 入口则在创建服务前经生产受限网络传输重新读取声明 URL，保存响应并拒绝 hash 变化。

GitHub 真材料进入实际获取任务、不可变材料账本、阅读器、私有管理、Web ZIP 与离线浏览器。固定 arXiv 真材料进入实际论文获取任务、版本历史、私有 PDF 与来源 UI；没有在服务器解析 PDF。成功的本地阅读包目标绑定使用明确标注的合成论文/PDF/已发布包，两个版本共享真实相同 PDF 字节，验证历史绑定而不声称真实论文解析质量。GitHub 文档子页 URL 的正文也明确为合成材料，不能用来声称该公开子页的真实性。

## 本轮结果与截图

冻结后按顺序执行 npm ci、root check、site check、声明 S4、固定包兼容与 audit，全部退出 0。root check 为 1012 个 Vitest、10 个 Node、69 个 native 通过，另有 2 个需数据库的 native 跳过；这两个用例另以自有数据库定向补验，独立记录，不改写原轮结果。site check 为 402 个服务、117 个浏览器与 35 个 Node 通过；随后 CLI 限额定向回归 21 个通过；自检又修正非字符串 ID 被正则隐式转换的问题，ID 与 hash/role/Accept 的两批各 3 项 RED 后，最终预检 27 个通过，原 9 项声明在只读预检中仍被接纳且不创建输出。声明 S4 9 项与固定兼容 2 包通过，audit 为 0 漏洞。各阶段 harness/CLI 变更与冻结身份在摘要中分别记录。

| 截图 | 实际证明范围 |
| --- | --- |
| [GitHub 手机管理](assets/learning-site-s4/acceptance/github-mobile.png) | 375px 私有管理与实际 README 身份；正文仍在加载，不作正文渲染证明 |
| [GitHub 离线预览](assets/learning-site-s4/acceptance/github-offline.png) | 实际 README、已验证 Web ZIP、file:// 无 HTTP 请求的隔离预览 |
| [arXiv v2 来源](assets/learning-site-s4/acceptance/arxiv-v2-source.png) | 实际版本元信息与私有 PDF 下载链接；不作 PDF 渲染证明 |
| [离线手机暗色](assets/learning-site-s4/acceptance/offline-mobile-dark.png) | 合成危险文本保持惰性，暗色主题与手机布局；partial/mock 如实保留 |

## 断点与升级证据

本次独立 Docker 命名卷先应用原样 001–006，写入经过实际校验的已发布 PDF 包、私有对象、Web 原文/IR/阅读分片、两种阅读进度，再在旧写进程停止的边界应用 007–009。原始行快照保持相同；重建 API 与 PostgreSQL 容器后，旧会话、原件/ZIP hash、Web/PDF 阅读器、阅读位置与跨 owner 拒绝仍通过。独立 worker 子进程重新打开同一数据库/对象目录运行共享任务代码。

三个故障点均杀死本次拥有的进程，不使用替代清理引擎：

- acquisition：第一份材料已提交，下一次响应之前 SIGKILL；重启复用同一 acquisition 身份/hash，已保留的 GitHub repository 响应不重取。
- export：隔离 writer 已写出耐久 ZIP、尚未发布时 SIGKILL；实际共享维护保留当前 writer 的文件，重启后生成合法结果并清理旧尝试。
- purge：实际物理删除之后、队列确认之前 SIGKILL；共享持久队列和清理收据重启后完成剩余工作，读取入口始终撤销。

故障用例明确记录杀进程后对本次 lease/slot/writer 截止时间的测试时钟推进；没有改变个人服务或生产时间。完整流使用两套独立 Chromium 进程、两个 owner，以及独立 API/worker。普通保存、管理、阅读、恢复、导出和下载的模型调用数为零。

## 修正与仍开放范围

本轮修正了 impossible calendar date 被规范化为下月日期的问题；保留有效闰日和时区转换。离线主题首击以系统/显式有效主题为准，系统暗色下首击切到浅色。离线浏览器错误记录保留可见分类，仅对当前生成预览的精确 sandbox blocked-script 诊断作预期分类，其他 console error/pageerror 均判失败；另有真实浏览器注入错误的分类回归。网页 Playwright 配置只移除与其子进程 FORCE_COLOR 冲突的 NO_COLOR。

截图写入 `testInfo.outputPath`，可用 `PAGELINGO_TEST_OUTPUT_ROOT` 为整轮分配独立目录。历史 7 张 Task5、11 张 Task6 PNG 路径的原始字节无法独立认证；已有观察副本和 errata 保持原样。本轮截图是新证据，不是历史原图恢复。开发阶段发现 arXiv 截图处于加载状态，保留该原件并仅修正验收 harness 的 owner/UI 就绪等待；对应源码 hash 和阶段边界记录在摘要中。

仍开放的 Minor：新管理控件与 `web-validate.ts` limit walker、`registered-work.ts`、`web-exports/runner.ts` 的压缩排版尚可改善；离线 partial/mock 等内部来源词仍可补充更友好的标签，当前保留真实含义。本轮没有为这些排版/文案调整依赖或扩大产品行为。

四份原始 S2 大样本 ZIP 缺失，只对现有固定 S2/S3 包验证，不以新包冒充。Web ZIP 不支持重新导入；仅支持可重现的 `web-projector/1/defaultCaptureLimits`，未知历史配置返回不支持，不猜配置或重跑模型。X/知乎/公众号真实登录、真实 BYOK 语义质量、实际部署/停机和真实大样本质量留在 S5。Python/parser、已发布 PDF 目录、001–006、原始固定包及 SDK/P0 语义未改。

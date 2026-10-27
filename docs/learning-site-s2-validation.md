# S2 阅读包验收（2026-10-27）

本次覆盖 BERT 16 页、Attention 15 页、LLM Foundations 317 页、RL Little Book 154 页，
共 502 个物理页。使用本地已有 MinerU P0、最终原文 preview 和已准备解释器；没有重新推理、
下载模型、读取 `.env.local` 或调用真实模型 API。模拟翻译使用 echo provider，产物明确标为
`generationKind=mock`，正文保持原语言；**未验证中文语义译文质量**。

## 最终审查修复验证

I1 / I2 / I3 / M1 已在同一修复批次实现；以下是改动后的新证据，整分支最终结论仍由控制方复审。
390×844 站点仅 goto 的正文可见高度为 **359.7px**，恢复提示时 **317.3px**，恢复加 CAS 冲突时
**258.2px**，两种主题均为 `scrollY=0`。移动目录与版本 / 字号设置默认收起，模式与状态保持可见；
读区按剩余视口定高，未自动滚动外层页面。保留全部部分解析、模拟译文、原图与冲突提示。

站点新增默认收起的完整解析 / 阅读提示，合并去重 descriptor 与 index 的消息；303 条真实导入
fixture 的全部字符串、键盘展开、20vh 滚动边界、HTML 样式文本不执行与账号切换隔离均通过。
四类常见来源 / 列表警告有中文解释，逐片公式显示预算提示仍保留。

离线跳转只改变正文窗格，迟到邻片保持当前锚点；尾部非正文留白保证短分片也能到达目标，
不会通过外层滚动补偿。四个新包的初始页头 top 与 scrollY 均为 0，论文正文窗格为780px，
长书651px（1440×1000）。全502片的当前目标与窗格顶部偏差≤2px，235图、2,090处公式、
每包60字体与全部原页锚点重新验证，零 HTTP(S) / 页面错误。全包重新通过可信目录验证。
快照发布处统一归类磁盘错误为 `TRANSLATION_DISK_WRITE_FAILED`，注入里程碑 ENOSPC 后旧快照
仍可加载与 SDK 复验；检查点 / epoch 冲突码保留，原始异常信息不外泄。

最新 renderer 0.1.0 code SHA-256：
`3bfbbf4ce02a787185643792d617f80cb960261d108ad0ce224b0909ea4d47c3`。
新包从已验证的 Task12 ready run / 不可变译文快照导出到 `data/pdf-s2/final-fix/current/`；
未重做解析或模型调用。源 IR 字节不变，导出译文只换其规定的新快照 UUID；原有 Task12 包与 manifest、
原 P0 / preview manifest、release ZIP、源 PDF、快照 / 检查点 / 缓存共7,307个记录文件的前后 hash 一致。
中间试验的旧 catalog 包保留在独立目录，未当作当前包证据。

| 样本 | 新 ZIP 字节 | 新 ZIP SHA-256 |
| --- | ---: | --- |
| BERT | 4,222,342 | `5f29b868e1461755c66534cafe16230a5004640fa465fe61420ee0b4324db4d9` |
| Attention | 5,208,231 | `b5f57cf5ab49fba3ae96db5beec058c3b033b45cebea28c998b450f74d8e0f86` |
| LLM Foundations | 37,176,944 | `9eeae78e0b1ae6d44656f733626caffa799f228f0c9b6e0396c1ad9e0fc169cf` |
| RL Little Book | 28,241,882 | `b8454f9be349171ad43168ceff45a25d9330c25b08026b6559f7bde54a8bb26e` |

本轮实跑：renderer31 + bundle140 + CLI108 单元测试、四包 typecheck / 构建、完整站点56个
真实API浏览器用例；最后 offline-only 修正之后，当前 catalog 再跑4个移动布局 / 警告 / 账号用例。
file:// 警告 / 初始定位 smoke、3个长短块逆序邻片回归、6分片 CLI 离线包验收及4个 harness
测试通过。[当前截图与完整身份摘要](superpowers/specs/assets/2026-10-27-s2-validation/final-fix/)
独立保存，不覆盖前一轮截图。所有截图为实际 viewport / 页面捕获，未编辑图片或注入 CSS。

本轮四个新包还通过独立 Docker S1→005、导入与幂等、保留卷重建 API / DB、原件与全部
分片 / 图片 / 译文 / 进度、完整 ZIP 下载 hash 与全包复验、会话 / 另一账号 / 撤销检查。
以下命令退出0，专属容器 / 卷已清理：

```sh
node scripts/check-site-restart.mjs \
  --bundle data/pdf-s2/final-fix/current/bert/reader.zip \
  --bundle data/pdf-s2/final-fix/current/attention/reader.zip \
  --bundle data/pdf-s2/final-fix/current/llm-foundations/reader.zip \
  --bundle data/pdf-s2/final-fix/current/rl-little-book/reader.zip
```

验证期间 renderer 的 source / static / dist 共26个文件 hash 保持不变。

## Task12 已通过的原始全量证据（沿用）

以下命令、旧 catalog 产物身份、Python / P0 和全量套件结果来自 Task12；本轮未重复未改变的
SDK / extension / PostgreSQL / Python / 原布局广泛检查，也不将其标成新代码全量重跑。

### 可复现命令与证据

从仓库根目录执行，样本映射格式见 [PDF 工作流](pdf-reader-workflow.md)：

```sh
npm ci
npm run check
npm run check:site
npm run check:pdf-reader -- --corpus data/pdf-s2/task12-input/corpus.json \
  --runs-root /path/original/benchmarks/pdf/runs/2026-10-07 \
  --output data/pdf-s2/task12-final --mock-translation
npm audit
npm run test:site:restart -- \
  --bundle data/pdf-s2/task12-final/bert/reader.zip \
  --bundle data/pdf-s2/task12-final/attention/reader.zip \
  --bundle data/pdf-s2/task12-final/llm-foundations/reader.zip \
  --bundle data/pdf-s2/task12-final/rl-little-book/reader.zip
```

上述 corpus / run / ZIP / 解压文件与完整日志为本机 ignored 证据，不随源码分发 PDF。
发布的摘要、hash、命令结果和截图在
[验收资产目录](superpowers/specs/assets/2026-10-27-s2-validation/)。
原输入映射：论文使用 `mineru-smoke/mineru-{bert,attention}`；长书使用
`mineru-full/mineru-{llm-foundations,rl-little-book}`。
LLM 最终 preview 为 v11 / schema 0.6，RL 为 v6 / schema 0.5。完整旧 ZIP 先检查原
manifest 的字节数 / SHA-256 / 文件闭包，再解压至新目录；生成正式包不改旧档案。

## 检查内容

- 全页 source PDF hash、原始页元数据、完整 coverage；正式 IR / 译文 / provenance / 图片的
  实际字节绑定；全包 validator 重建可信 renderer 数据和代码目录。
- 所有原图按旧 preview manifest hash 与正式 IR 比对；正文、图注、公式、嵌套列表、提示框、
  角色和符号图在兼容能力内保留。首 / 中 / 末片及复杂内容有截图。源证据不足时保留页级警告。
- 模拟翻译在第二次请求取消，再恢复；已完成单元不重复请求，旧不可变快照 hash 保持一致，
  所有选中单元完成。自动语言选择留下的未选中内容继续明确 pending，所以状态可能是 partial。
- 从验证后 ZIP 新解压副本的 `file://` 入口断网打开，遍历全部分片；逐张滚入视口后验证图片
  解码，逐个加载全部 60 个字体文件，检查公式、三片 DOM / script 上限、原 PDF 本地响应和
  字节 hash、各片正文点击后的原页锚点。HTTP(S) 请求必须为 0；外部来源链接不主动点击。
- 对完整包扫描明确的运行目录 / 解释器路径与固定假 Key sentinel；正式 provenance 校验器检查
  已知运行字段。该扫描不声称能发现任意原文 / opaque raw 中的未知秘密。没有真实 Key 参与。
- 独立 Docker 项目先建立含账号与 PDF 的 S1 001–004，再由正常启动应用 005；同条目上传 / 导入、
  重复包幂等、进度保存后保留卷重建 API 与数据库容器。重登及旧会话、所有分片 / 图片 / 译文、
  原件、完整下载再验证、进度与拒绝未登录 / 另一账号读取均作为断言。最后只删除本次自建资源。

## 真实样本暴露并修复的问题

MinerU 的真实空白页只存 `{page_idx}`，没有 `blocks` 属性：LLM 第 11 页，RL 第 2、3、7、9、
11、25、39、41、113、145 页等。投影器原先拒绝这种已通过 manifest 校验的页。
现在只对**缺失属性**在内存中补空数组；显式 null、对象、字符串仍拒绝，原 raw / manifest /
provenance 字节不变。自有 fixture 回归经历 RED→GREEN，并检查全页 coverage、无证据时页级定位。
这不推断不存在的正文或精确 bbox。

长书初始离线页原先把所有 warning 展开在页头，挤占正文空间。现在状态栏保留提示数量，
使用默认收起、键盘可展开的原生 details 展示全部提示，展开列表在 20vh 内滚动；没有删除
index / 元数据警告或逐片提示。401 条含 HTML 样式文本的浏览器回归验证内容完整且不执行。

Docker 清单补齐 renderer / bundle 的构建与运行依赖，包括 renderer 的可信 `static/` 资源。
运行镜像不复制本地 CLI、parser 环境或模型，也没有 Python 可执行文件。

## 已知限制与未验项

原图里的文字、整表、符号图与原件保留区继续按源图显示，不声明图片文字已翻译。
已有 preview 手工修复内容只投影，不重新承诺 parser 原始精度；上游缺失 lock 文件、source binding
不足、未校准坐标、复杂公式 / 字母列表 source-only 回退等警告保留。英文短块的自动语言判断
及 mixed / und 的手工选择边界未放宽。

真实 API 语义质量、macOS / Windows 的本地处理、任意未来 preview、模型安装 / 下载、
跨主机灾备恢复与公网部署均未验证。完整本地 Node 处理目前以 Linux `/proc/self/fd` 为基线，
翻译还要求 `/usr/bin/flock`。ZIP 格式与浏览器离线阅读本身不绑定 Linux，但本次浏览器仅为 Linux Chromium。

原 Task12 的移动首屏与快照错误分类延后项已纳入页首最终修复验证。最终复审与 Step 6 勾选仍由控制方负责。

## Task12 当时的稳定树实测（旧 catalog）

以下为 R42 新目录 / 可信 catalog 下的正式运行，旧 probe ZIP 不作为当前导入证据。

| 样本 | 页 / 分片 | 原图 | ZIP 字节 | 解压字节 | 文件数 | IR 字节 | 译文字节 | 最大片 JSON 字节 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| llm-foundations | 317 | 141 | 37,176,700 | 116,728,498 | 1327 | 3,953,280 | 1,410,569 | 45,834 |
| rl-little-book | 154 | 69 | 28,241,638 | 42,087,363 | 581 | 841,724 | 255,019 | 23,098 |
| attention | 15 | 9 | 5,207,988 | 9,273,772 | 131 | 178,463 | 68,305 | 31,677 |
| bert | 16 | 16 | 4,222,104 | 9,110,137 | 142 | 329,748 | 118,922 | 53,099 |

全部低于默认预算，未提高上限或删减证据。共 502 片 / 235 图 / 2,090 处 KaTeX，
每包 60 个字体文件均实测加载；502 个物理页锚点通过，HTTP(S) 请求 / 页面错误均为 0。
全部源 PDF / 原 P0 manifest / 旧 release ZIP 与 manifest 的前后 hash 一致，详见
[完整 hash 与断言摘要](superpowers/specs/assets/2026-10-27-s2-validation/acceptance-summary.json)。

| 样本 | 选中且恢复的模拟单元 / 块 | 保留原文块 | warning 数 | bbox / 页级来源 |
| --- | ---: | ---: | ---: | --- |
| llm-foundations | 2675 | 327 | 292 | 3223 / 289 |
| rl-little-book | 653 | 83 | 117 | 757 / 115 |
| attention | 139 | 20 | 24 | 154 / 22 |
| bert | 225 | 31 | 41 | 240 / 39 |

四包均为 `partial`，因为 auto 没有选择全部文本；所有实际选中单元已恢复完成，
未选中块没有冒充译文。模型输出是 echo，不代表中文质量。正式渲染器为 0.1.0，
code SHA-256：`1d3d2d2e31f38c540ada0754745baa532e25e752a8806eed4d6a8159e20a3fb8`。

最终稳定输入上的 `npm run check` 退出 0（639 单元断言、8 glossary / package、55 Chromium）；
`npm run check:site` 退出 0（124 PostgreSQL、52 Chromium、9 dev / harness Node 测试）；
显式 `check:pdf-reader` 退出 0；`npm ci` / `npm audit` 退出 0，0 vulnerabilities。
保留既有 inlineDynamicImports 与 NO_COLOR/FORCE_COLOR 非阻断警告，安装还有
node-domexception 的传递依赖弃用提示。中间一次 site 运行因测试期间改变可信静态输入被严格
目录校验拒绝（124 PG、50/52 浏览器），不算通过；冻结代码 / 重新构建后的上述最终运行全绿。

S2 的 Python 检查使用已有环境、`--locked --no-sync`：`pdf:lint` 退出 0，
`pdf:test` 36/36；CLI inspection unittest 2/2；四旋转独立 PDFium 像素 oracle 最大误差 0px。
原布局 README 的十个 Python 回归脚本 60/60，旧包全部 699 成员及 210 个区域像素核对通过；
LLM 67 个提示框 / 15,629 原生字符核对通过；7 个代表页旧预览 / 模拟插件回填 / 精确恢复通过。
[旧包与像素检查](superpowers/specs/assets/2026-10-27-s2-validation/legacy-package-validation.json)、
[原布局检查](superpowers/specs/assets/2026-10-27-s2-validation/legacy-structure-validation.json)、
[旋转 oracle](superpowers/specs/assets/2026-10-27-s2-validation/rotation-oracle.json) 均为 Task12 当时重跑，本轮沿用，未改变旧 parser / P0 工具。

最终 `test:site:restart` 使用含 R42 catalog/runtime 的新镜像，四个正式包均退出 0：
BERT 16 / Attention 15 / LLM 317 / RL 154 片及对应 16 / 9 / 141 / 69 图逐项验证，
S1→005、同条目与重复导入、保存进度、容器重建、完整 ZIP 下载再验证、登录 / 会话 / 其他账号
隔离与撤销通过，镜像内容检查通过。测试项目、容器与命名卷已由 finally 清理。

旧 Task12 初始离线分栏的 scrollIntoView 外层滚动已由页首 I2 修复与新目录证据取代；
旧截图 / 诊断仅保留为问题复现。离线 headless 原 PDF
面板的可视栅格未验证，不能用本地响应成功替代视觉证据；完整原件字节、页几何、原区域像素及
站内 PDF.js 回归是分别记录的检查。

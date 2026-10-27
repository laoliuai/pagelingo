# S2 阅读包验收（2026-10-27）

本次覆盖 BERT 16 页、Attention 15 页、LLM Foundations 317 页、RL Little Book 154 页，
共 502 个物理页。使用本地已有 MinerU P0、最终原文 preview 和已准备解释器；没有重新推理、
下载模型、读取 `.env.local` 或调用真实模型 API。模拟翻译使用 echo provider，产物明确标为
`generationKind=mock`，正文保持原语言；**未验证中文语义译文质量**。

## 可复现命令与证据

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

两项已记录 Minor 仍待控制方最终分级：移动站点首屏可见正文较少（390×844 约 120px，
外层滚动后可增加阅读空间）；本地翻译快照在 SDK 迭代中写盘失败可能标成 `TRANSLATION_SDK_FAILED`，
先前快照仍可恢复。未在本任务顺带修改。整分支最终审查由控制方执行，Task 12 Step 6 在其完成前不勾选。

## 最终实测

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
[旋转 oracle](superpowers/specs/assets/2026-10-27-s2-validation/rotation-oracle.json) 都是本次重跑，未改变旧 parser / P0 工具。

最终 `test:site:restart` 使用含 R42 catalog/runtime 的新镜像，四个正式包均退出 0：
BERT 16 / Attention 15 / LLM 317 / RL 154 片及对应 16 / 9 / 141 / 69 图逐项验证，
S1→005、同条目与重复导入、保存进度、容器重建、完整 ZIP 下载再验证、登录 / 会话 / 其他账号
隔离与撤销通过，镜像内容检查通过。测试项目、容器与命名卷已由 finally 清理。

初始离线分栏画面中，runtime 会自动把首块 scrollIntoView，可能将页头和部分目录滚出视口；
本次单独复现并保留实际截图 / 诊断，作为控制方整分支可用性待分级观察。离线 headless 原 PDF
面板的可视栅格未验证，不能用本地响应成功替代视觉证据；完整原件字节、页几何、原区域像素及
站内 PDF.js 回归是分别记录的检查。

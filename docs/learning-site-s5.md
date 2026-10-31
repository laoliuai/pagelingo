# S5 记录：真实来源、论文阅读与部署

状态：2026-10-31。本阶段第一次用真实网页、真实论文和真实模型跑通整条链路。之前各阶段的验收以合成样本和受控回放为主，所以这里记录的问题大多是那些样本覆盖不到的。

## 架构判断

整体分层合理，不需要重做：

- SDK 与 DOM、存储解耦，Reader IR 和阅读包有版本化协议，后台任务有租约和围栏，本地 PDF 处理与服务器阅读分离。真实数据跑下来，这些边界都站得住。
- 真正的风险不在结构，而在验证方式：之前的验收几乎不接触真实输入。本阶段的绝大多数缺陷都是用真实页面跑一次就暴露的。
- 复杂度高于个人项目的需要（多账号、设备令牌、细粒度围栏、永久清理状态机）。这些已经建好且有测试，不拆，但在实际用起来之前不再加同类机制。
- `document-service` 和 `web-capture` 里有不少超长的单行代码（221 个文件里约 485 行超过 200 字符），改动成本偏高。以后动到哪里再整理到哪里，不做专门的大重排。

## 本阶段修复的真实问题

| 问题 | 影响 | 修复 |
| --- | --- | --- |
| 预算按分词次数而非节点数计算 | 约 2.5 万词以上的长文、公式多的论文整篇保存失败（Mamba、GPT-3） | 只在产生新文本节点时计数 |
| 白名单外的元素连内容一起删除 | `<q>`、`<cite>`、`<kbd>`、`<details>`、`<picture>` 和自定义元素里的文字、图片丢失；Distill 整篇变空 | 只去标签保留内容，代码类标签转为受保护的 `code` |
| 粘贴链接从不下载图片 | 文章全部缺图 | 公开抓取下载已登记的图片，失败的逐张记录原因 |
| `$...$` 公式没有保护 | TeX 被当成普通文字送去翻译 | 页面加载 MathJax / KaTeX 时按 Pandoc 规则识别；价格和代码不受影响 |
| `href="mailto:"` 让整页失败 | arXiv HTML 普遍含有 | 链接无效时只去掉链接，保留文字 |
| 所有真实页面都标“范围内不完整” | 这个状态失去意义 | 只有读者能察觉的损失才算不完整 |
| 公式渲染预算被重复计数，分片也不看渲染成本 | 公式多的文章后半部分退回 LaTeX 源码 | 修正计数，按实际渲染成本切片 |
| 自动翻译把纯数字、公式块也发给模型 | Attention 论文 401 块里有 183 块被白送，还可能改坏表格数字 | 默认只选需要翻译的块 |
| 术语表译文两侧多空格 | “词元（token） 嵌入（embedding） 在 编码器 和 解码器” | 还原时收紧中文术语两侧的空格 |
| `check:site` 在 S4 合并后的 HEAD 上是失败的 | 回收站测试未随行为更新；连带让永久删除中的链接无法重新保存 | 修正测试和查询 |
| 机器 DNS 走代理工具 fake-ip 时所有对外请求被拦截 | 抓取、GitHub、arXiv、调用模型全部失败，且原因不可见 | 显式开关 `PAGELINGO_ALLOW_FAKE_IP`，错误信息说明原因 |
| 代理后所有访客共用一个 IP | 一个人登录失败多次会锁住所有人 | `PAGELINGO_TRUST_PROXY_HOPS`，只信任紧邻代理写入的地址 |
| 阅读页正文只占很小一块 | 900px 高的窗口里正文约 335px | 控件收成一行，正文占满视口，新增专注阅读 |

## 新增能力

- **论文：** 保存 arXiv 链接时，如果该版本有 HTML，同时生成一条关联的文章，走现有网页管线翻译和阅读。提取时跳过 Readability，直接取 LaTeXML 正文；公式用作者的 TeX 渲染；脚注移到段落之后；SVG 插图在服务器转为 PNG。PDF 和版本历史照旧保留。
- **部署：** `deploy/compose.prod.yml` 和 Caddy 提供自动 HTTPS，`npm run site:init` 生成配置。
- **备份恢复：** `npm run site:backup`、`npm run site:restore`，恢复时校验所有文件哈希并试解密所有 API Key。
- **验证工具：** `npm run test:site:backup`（生产配置演练）、`npm run check:site:real`（真实网页和截图，可加 `--translate` 走真实模型）、`npm run eval:translation`（翻译质量评测）。

## 已知限制和权衡

- 一篇 arXiv 论文在资料库里是两条（PDF 和网页阅读版），在 PDF 页和“关联资料”中互相可见。合并成一条需要改 `documents` 的数据库约束，代价较高，先不做。
- 只有 arXiv 有 HTML 的版本能走这条路（抽样 6 篇有 5 篇）。没有 HTML 的论文、以及本地 `.tex` 文件还没有服务器翻译路径，仍可用本地 PDF 流程。
- 超过预算的图片不保存，例如动图超过帧数或像素上限、PNG 超过 3200 万像素（Illustrated Transformer 里有 2 张动图）。扩展采集不做 SVG 转 PNG。SVG 里的中文文字没有字体。
- `npm audit` 报 3 个 moderate，来自 `@fastify/static` 依赖的 `glob`，与用户输入无关，等上游更新。

## 尚未验证

- **X、知乎、公众号的真实登录页采集。** 需要你在自己的浏览器里用扩展试，这里无法代劳。
- **真实服务器部署。** 生产配置只在本机隔离环境里用内部证书验证过，没有用真实域名申请过证书。
- **翻译质量只抽样过一个模型、20 条样本和一篇论文。** 见下文。其他模型、其他领域、长文和长书还没有评测，所以提示词也没有改。
- **本地 PDF 处理链**（MinerU + 阅读包）这一轮没有重跑。

## 真实验证记录

运行环境：WSL2、Docker Compose 5.6、本机 fake-ip 代理（因此需要 `--allow-fake-ip`）。以下均在同一份代码上执行，且没有在运行中改动代码。

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过：各包单元测试、独立包与术语测试，扩展浏览器测试 69 通过、2 跳过（需数据库） |
| `npm run check:site` | 通过：服务集成 437、站点浏览器 120、Node 67 |
| `npm run test:site:backup` | 通过：HTTPS 跳转、`__Host-` Secure Cookie、代理后的真实 IP、备份、三种拒绝恢复、销毁后恢复、文件和 API Key 核对、Range、旧会话、匿名和管理员无法读取 |

真实来源（`npm run check:site:real`，公开网络，不调用模型）：

| 来源 | 结果 | 图片 |
| --- | --- | --- |
| Lil'Log《What are Diffusion Models?》 | 保存，公式渲染正常 | 19/19 |
| Lil'Log《LLM Powered Autonomous Agents》 | 保存 | 13/13 |
| The Illustrated Transformer | 保存 | 35/37，2 张动图超预算 |
| Karpathy《RNN Effectiveness》 | 保存 | 11/12，1 张动图超预算 |
| Anthropic《Building effective AI agents》 | 保存 | 8/8 |
| Martin Fowler《Microservices》 | 保存 | 7/7 |
| Distill《A Gentle Introduction to GNN》 | 保存 | 20/21，1 张超预算 |
| Kubernetes 文档 Overview | 保存 | 1/1 |
| GitHub `karpathy/nanoGPT` README | 保存 | 2/3，1 张取不到 |
| arXiv 1706.03762（PDF + 阅读版） | 保存 | 8/8 |
| arXiv 2312.00752v2（PDF + 阅读版） | 保存 | 16/16 |
| arXiv 2005.14165（PDF + 阅读版，4317 块） | 保存 | 62/74，12 张取不到，原因未查明 |

运行时内存：app 约 270 MiB、worker 约 260 MiB、PostgreSQL 约 80 MiB。

真实翻译（DeepSeek `deepseek-flash`，提示词版本 3）：

- 20 条针对性样本（`evals/translation/cases.json`）：不用术语表和导入 2799 条术语表都是 20/20，我逐条读过，否定、限定、数字、比较方向和指代都正确。这些检查只能发现明显错误。
- Attention Is All You Need 全文，经真实 worker：223 段全部完成，用时 1.5 分钟，失败 0。全文核对公式、引用零差异，无残留占位符；数字差异 2 处，都是正确换算（4.5 million → 450 万，40K → 4 万）。参考文献被模型原样保留。抽读的段落术语和句意准确，但没有逐句人工校对全文。
- 费用未单独统计，以 DeepSeek 后台为准。评测结果在忽略目录 `data/evals/`。

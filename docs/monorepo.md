# Monorepo 架构与开发顺序

状态：2026-10-07。浏览器扩展、翻译 SDK 和助手 SDK 为独立 workspace；PDF P0 的独立评测入口、候选适配器与定位图已实现；正式 Reader、网站、文档服务、数据库及部署仍未实现。

2026-10-26：个人学习站产品范围已更新为管理员手工开通账号、每用户独立资料与 API、桌面采集及本地 PDF 处理后导入服务器。新 [V1 设计稿](superpowers/specs/2026-10-26-personal-learning-site-design.md)已于 2026-10-27 获批；下文的单用户表述属于此前规划，后续按新规格推进。既有 SDK / 应用依赖边界和不可变产物原则继续保留。

## 1. 当前优先级

1. PDF 方案与 P0：在目标机器上进行解析器评测，确定范围和资源预算；随后实现可在本机 / 服务器部署的网站与文档服务。
2. 共享 SDK：在 PDF 阶段补充文档分析、自动术语与质量评测；升级后回归浏览器插件。扩展 M2、个人术语和阅读助手已交付，继续跟进真实 Chrome / Edge 体验。
3. LaTeX L0：PDF Reader 达标后评测源码转换；复用网站、翻译、助手与后端持久化。

本机自用是初始部署环境，首版产品范围为单用户；应用按服务器可部署的职责、配置、存储与访问边界设计。P0 是解析评测，不把 benchmark 文件目录或协议规划当作已完成的后端存储。

PDF 优先阅读效果，增强配置将在当前机器评测。处理与阅读可分机：本机完成解析、翻译与静态阅读快照，服务器校验导入后保存与展示；IR、译文和完整 HTML 资源一起保留，重复阅读不触发重处理。原文静态预览已可从现有 raw 导出，正式快照 / 导入 / 高质量配置仍待实现，见 [处理与产物设计](pdf-processing.md)。

## 2. 仓库目录

```text
apps/
  extension/                 已实现：扩展源码、配置、DOM fixtures、单元与 Chromium 测试
  web/                       规划：React 文档库与统一阅读器
  document-service/          规划：TypeScript API、持久化任务、SDK 执行、存储
packages/
  translation-core/          已实现：可单独打包的纯数据翻译 SDK
  assistant-core/            已实现：纯数据阅读对话、上下文预算、摘要与 Pi runtime
  document-contracts/        P0 评测 schema；正式 Reader IR、API 与任务协议待冻结
services/
  document-parser/           已实现 P0：Python adapter、来源归一化、独立进程与锁定环境
benchmarks/
  pdf/                       P0：输入 / 模型锁、真实解析 / 资源记录与离线布局检查
evals/                       规划：跨网页 / PDF / LaTeX 的翻译语义评测
examples/                    已实现：SDK 的 Node 消费示例
scripts/                     已实现：读取本地配置的真实 SDK 联调（不进入扩展）
tests/package/               已实现：仓库外安装 SDK tarball 的验证
deploy/                      规划：Compose、镜像、持久卷、迁移 / 备份说明
docs/                        产品规格、审阅记录、未来 LaTeX 草案
```

只有包含 `package.json` 的 JavaScript / TypeScript 项目注册为 npm workspace。目前有 `@pagelingo/extension`、`@pagelingo/translation-core`、`@pagelingo/assistant-core`；网站 / 服务目录仍为规划。Python 已有独立 `pyproject.toml` / `uv.lock` 与按候选隔离的环境，不加入 npm 默认依赖安装链。

根目录保留 `package-lock.json`、通用 TypeScript 选项和调度命令。各应用声明自己的直接依赖与构建 / 测试配置，SDK 保留独立构建配置和 ESM 导出，不从应用内部导入文件。

## 3. 执行关系

```text
扩展 content script → 扩展后台 → translation-core → 配置的 LLM
                               （M2 已接入；持久化任务与缓存，Port 回传校验后的译文）

扩展 content script → 受信任后台投递正文 / 引用 → 原生侧栏
                                                   └→ assistant-core → 配置的 LLM
                                                      （Pi runtime；历史由扩展 IndexedDB 适配）

网站 → document-service API → 持久化任务 / worker
                                  ├→ Python parser → Reader IR + assets
                                  └→ translation-core → 配置的 LLM
网站阅读助手 → document-service API → assistant-core → 配置的 LLM
API / worker → PostgreSQL：文档、运行、任务、译文、缓存、对话、阅读进度
API / worker → ObjectStore：PDF、解析 IR、图表资产与 manifest
```

扩展不依赖网站服务上线，网站也不加载扩展代码。同仓库各自构建、发布；升级 SDK 后分别重建消费应用。

网站后端采用 TypeScript 作为任务和翻译编排层，Python 负责解析与重建。这样直接运行已有 SDK，避免重新实现 Python prompt / glossary / validator / cache。若以后另有 Python 应用，它通过版本化的 Node CLI / 本地 API 调用 SDK；仅共享提示词文件不足以保证行为一致。

先在一个 `document-service` 包内区分 API 与 worker 入口，部署可同机。解析运行在独立进程，资源预算、退出、超时与取消由任务层管理；暂不引入 Redis / Celery 或多个互相转发的 API 服务。

本机和服务器统一使用 PostgreSQL。首版 ObjectStore adapter 把逻辑 key 映射到可配置的持久化目录；后续对象存储 adapter 遵守同一读写 / checksum 合同。业务 repository、缓存 / ConversationStore 适配和资产访问集中在 document-service，数据库驱动与磁盘路径不进入 SDK 或 Reader 公共协议。完整存储、提交、备份与部署约束见 [PDF §84–97](pdf-spec.md#84-storage)。

## 4. 共享数据模型

| 模型 | 所属 | 内容 |
| --- | --- | --- |
| TranslationDocument | translation-core | 有序翻译块、章节路径、自然语言、格式与保护对象 |
| ReadingDocument | assistant-core | 原文、章节、代码 / 公式文本、引用块 ID、稳定文档键和内容版本 |
| ReaderDocument | document-contracts（规划） | 文档结构、图表 / 公式资产、来源引用、解析版本、翻译运行与展示状态 |

Reader IR 通过适配器投影到 SDK 模型，结果按块 ID / 行内对象 ID 绑定回来。图像、参考文献、独立公式和不可靠结构可保留原样，无需伪装成可翻译段落。表格按可靠的单元格映射，保留表格自身的行列与合并信息。

阅读助手通过另一个纯数据投影读取 Reader IR 原文，不通过翻译 DOM 反向获取内容。网页使用 URL 身份，未来 PDF / LaTeX 使用持久化文档 ID；格式变化只修改适配器。摘要和对话策略在 `assistant-core`，浏览器权限、存储及 UI 在应用内，Pi 类型不进入公共接口。

来源使用可区分的联合类型，例如 `pdf: pageIndex + bbox + coordinateSpace` 与 `latex: fileId + byteRange + sourceHash`。PDF 坐标、源码文件位置、下载路径、任务 ID 和展示状态不进入 SDK 的内容模型或翻译缓存身份。

P0 已有单份评测 JSON Schema，Python 实际校验；它不是正式 Reader IR。P1 冻结公共 schema 后，TypeScript 与 Python 使用同一规范和共同 fixtures。不要维护两套手写、含义逐渐偏离的协议。当前 SDK 模型并不等于完整的 Reader IR，也不宣称已有跨语言服务。

## 5. 依赖和测试边界

- `translation-core` 不依赖任何 app、浏览器权限、数据库或格式解析器。
- `assistant-core` 同样不依赖 app、DOM 或持久化实现；提供 Provider / ConversationStore 接口，内部使用 Pi 运行层。
- `extension` 保留 DOM 提取 / 渲染、用户设置和后台任务；只消费 SDK 的公开入口。
- `web` 消费 Reader / API 协议，展示结构化数据，不直接执行服务器解析器或持有服务器密钥。
- `document-service` 消费 SDK 和文档协议，拥有 PostgreSQL repository / 迁移、ObjectStore、作业记录、缓存与对话存储适配和资产访问控制。
- `document-parser` 只接收解析任务和受限输入输出位置，不接收翻译 API Key；输出结构数据、资产 manifest、明确的警告与错误。
- SDK 变化检查 SDK、扩展和独立包消费；未来 Reader / parser 变化检查对应协议与 golden fixtures。产品尚未实现时，不用 stub 的通过状态替代验收。

解析器升级、翻译策略升级和 UI 部署各自记录版本。解析缓存与翻译缓存分开，内容相同也只有在模型、上下文、保护协议和术语等实际依赖一致时才复用译文。

## 6. 命令与产物

从仓库根目录运行：

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 安装当前 TypeScript workspaces；不安装 Python / PDF / TeX |
| `npm run dev` | 开发浏览器扩展 |
| `npm run dev:sdk` | 另一个终端持续编译 SDK |
| `npm run build` | 构建 SDK 和浏览器扩展 |
| `npm run build:sdk` | 只构建 SDK |
| `npm run typecheck` | 检查 SDK、测试和扩展 |
| `npm test` | 各 workspace 的单元测试 |
| `npm run test:sdk` / `npm run test:extension` | 单独验证一个 workspace |
| `npm run build:assistant` / `npm run test:assistant` | 单独构建 / 验证助手 SDK |
| `npm run test:package` | 在临时外部项目安装并消费 SDK |
| `npm run test:e2e` | 构建并运行 Chromium 扩展测试 |
| `npm run check` | 当前插件与 SDK 的必要检查，不触发 PDF 环境 / 下载 |
| `npm run pdf:setup` / `pdf:cli` | 显式准备 / 运行 Python 评测，候选和模型另行安装 |
| `npm run pdf:lint` / `pdf:test` | 独立 parser 静态检查与测试 |
| `npm run test:llm` | 主动读取本地配置，用真实模型验证三段固定文本 |
| `npm run test:llm:extension` | 主动用真实模型翻译线上技术文档（可传 URL） |

默认检查不读取 `.env.local` 或调用付费模型。两个 `test:llm*` 命令为独立联调入口，会产生真实请求；密钥不会传给 Vite 构建或写入测试截图 / trace。

扩展加载路径现在为 `apps/extension/dist/`，SDK 构建产物为 `packages/translation-core/dist/`。根目录不再产出扩展 `dist/`。浏览器测试产物在 `apps/extension/test-results/`。

各应用的测试根据自身文件位置定位 fixtures / dist，不依赖偶然的根目录工作路径。SDK 独立安装验证保留在根 `tests/package`，确保 monorepo 没有掩盖包缺失依赖或导出的问题。

## 7. 规格关系

- [web-spec.md](web-spec.md)：网页翻译浏览器插件，文件名中的 web 不指新网站。
- [pdf-spec.md](pdf-spec.md)：后续 PDF 网站，HTML 阅读优先。
- [latex-spec.md](latex-spec.md)：后续 LaTeX 源码输入草案，复用网站。
- [assistant-spec.md](assistant-spec.md)：网页先接入的通用文档阅读助手。
- [spec-review.md](spec-review.md)：本轮审阅发现与修订依据。

当前使用 npm workspaces 管理本地包及命令，无须额外引入 monorepo 框架。后续构建依赖图复杂或 CI 开销明显增长时再评估任务缓存工具。[npm 官方说明](https://docs.npmjs.com/cli/v11/using-npm/workspaces/)

## 8. 本机与服务器部署

P1 起落实本机与服务器共用的运行配置、数据库迁移和存储接口。规划的 Compose 服务为 web / 反向代理、API、worker 和 PostgreSQL；API / worker 是同一 TypeScript 工程的不同入口，Python parser 运行在 worker 管理的独立进程中。开发可直接启动应用进程，使用容器数据库；生产镜像和持久卷分别管理。P5 完成真实 Compose、数据保留与恢复验收。

| 数据 | 保存位置 |
| --- | --- |
| 文档、解析 / 翻译运行、任务 / 检查点、按块译文 / 缓存、对话、阅读进度、术语 | PostgreSQL |
| 源 PDF、raw 输出、完整 source IR、图表 / 公式资产、manifest | 不可变 ObjectStore；首版为持久化磁盘目录 |
| 任务工作目录、可重新获取的模型权重 | 独立临时目录 / 模型缓存 |
| 数据库与 LLM 等凭据 | 后端运行环境 / 受控 secret 文件，排除普通 settings、运行快照及前端构建 |

数据库连接用 `DATABASE_URL`，本地对象根目录用 `PAGELINGO_DATA_DIR` 配置；文档身份和存储 key 不依赖这些值。对象写入校验完成后，数据库再提交引用、状态和事件；孤立对象与迟到 worker 结果由恢复 / 清理及 lease 版本控制处理。

服务器应用入口使用 HTTPS 和单用户认证，数据库端口留在内部网络；原 PDF / 资产不成为公开静态目录。备份包含数据库、被引用对象及恢复所需的配置；完整恢复到空环境和另一台主机属于首版交付验收。首版对象目录的迁移与未来 S3 backend 切换均需校验实际对象，不只修改地址。

# 文档解析进程：PDF P0

已实现本地 CPU 评测入口、Docling / MinerU 适配器、原始输出留存、来源映射和离线布局检查。使用 Python 3.12.2、独立虚拟环境与 `uv.lock`，不进入 npm workspaces。`pagelingo-parse/0.1` 是 **P0 评测格式**；正式 Reader IR、语义重建、翻译、数据库与 worker 接入尚未实现。

仓库根目录安装基础环境、运行检查：

```bash
nvm use
npm run pdf:setup
npm run pdf:lint
npm run pdf:test
npm run pdf:cli -- --help
```

仓库的 `.nvmrc` 固定 Node 24。`uv` 使用复制安装依赖，避免项目虚拟环境与共享缓存
通过硬链接互相影响。环境损坏时保留旧目录，使用 `uv sync --locked --no-cache` 重新下载；
不要把已有的损坏缓存当作恢复来源。原 PDF、模型权重和解析运行无需随环境重装而删除。

候选环境分别安装；基础安装不带 ML 依赖：

```bash
cd services/document-parser
UV_PROJECT_ENVIRONMENT=.venv-docling uv sync --locked --extra docling --no-default-groups
UV_PROJECT_ENVIRONMENT=.venv-mineru uv sync --locked --extra mineru --no-default-groups
```

回到仓库根目录显式下载约 1.2 GB 的模型，默认存放于 `data/models`。仓库 commit、文件大小及 LFS SHA-256 / Git blob ID 由 [模型锁](../../benchmarks/pdf/models.lock.json) 固定，解析前校验已准备的文件：

```bash
npm run pdf:cli -- prepare-models --parser docling
npm run pdf:cli -- prepare-models --parser mineru
npm run pdf:cli -- parse ../../docs/pdfs/'The Little Book of Reinforcement Learning.pdf' \
  --parser docling --pages all \
  --output ../../benchmarks/pdf/runs/my-rl-full --timeout 1800
```

`pdf:cli` 的工作目录是本目录，以上输入 / 输出相对这里解析，也可使用绝对路径。输出目录必须不存在。`--pages all` 为默认值；`--pages 1,3-5` 显式抽样，产物映射回原文件页号。`complete` 表示所请求的页面已输出、解析器报告成功，且未检测到原页有原生文字却无内容块；不代表结构质量通过验收。缺页或 `source_text_without_blocks` 会标记 partial 并返回非零退出状态，原件、raw 与日志保留；真正空白页不判失败。

产物：`raw.json`、`raw.md`、`normalized.json`、`source-inspection.json`、`debug.html`、原 PDF、页面 / 区域截图、`run.json` 和 checksum manifest。失败 / 超时保留日志及已有 raw 输出。直接在浏览器打开 `debug.html`，点击原页框选编号查看文本块，无须 Web 服务。

`debug.html` 展示普通文本投影，没有正式公式 / 表格 / 章节排版，图内子项也会展开。用于比较渲染效果的 [静态原文预览](../../benchmarks/pdf/tools/README.md) 复用已保存 raw，包含离线图片 / 字体 / 预排版公式；没有重新解析或翻译。后续优先增强解析质量，并支持当前机器处理、服务器保存阅读，见 [处理设计](../../docs/pdf-processing.md)。

仅修改归一化时可以复用已留存的 raw，原运行保持不变：

```bash
npm run pdf:cli -- reproject ../../benchmarks/pdf/runs/my-rl-full \
  --output ../../benchmarks/pdf/runs/my-rl-reprojected
```

重投影先校验原 manifest，记录原 run ID 与当前投影代码 / schema 指纹，单独计算投影耗时。`resources` 与 parser 耗时明确继承原运行，不作为重新解析的测量值。图内标签与图注保留父子关系，不因为检查页面展开它们就把它们当成正文。

[P0 JSON Schema](../../packages/document-contracts/schemas/parser-evaluation.schema.json) 由 Python 实际校验。`payload` 保留上游结构和行内内容，`text` 只是检查 / 搜索投影，不能直接作为翻译请求。未知类型、页眉页脚、嵌套关系与孤立块均保留；定位不可靠时使用页级来源并警告，confidence 缺失时为 `null`。坐标为旋转后的 CropBox、左上原点、0–1；Docling 非零 CropBox 原点暂降级为页级，尚未做 backend 校准。

子进程强制 HF 离线模式、MinerU local 模型来源与 CPU；不继承 `.env.local`、数据库连接、LLM 密钥或 HF token，不启用远程 VLM / LLM，也没有失败后上传 PDF 的回退。默认 npm 安装 / 插件检查不触发 Python、模型或论文下载。

当前验证 Linux / WSL2 CPU；GPU、其他平台、扫描件、Docling 公式增强、MinerU standard / advanced 尚未评测。实际旋转挑战发现 MinerU 当前配置对 90 / 270 度页面漏内容，已检测为 partial，尚未修复识别；主评测范围是正常方向的 born-digital 文档。每 200 ms 采样候选进程树 RSS 总和，共享内存可能重复计数；该指标不包含控制器的原页渲染。缓存口径为权重已落盘、每次新起进程，不是权重下载时间或操作系统完全冷缓存。

参见 [首轮实测报告](../../benchmarks/pdf/first-run-report.md)、[评测说明](../../benchmarks/pdf/README.md)、[服务边界](../../docs/monorepo.md)。P1 起接入 PostgreSQL / ObjectStore 与正式 worker，解析器不维护第二套翻译 engine。LaTeX 后续复用 Reader 协议，转换器是否放在此进程由其工具评测决定。

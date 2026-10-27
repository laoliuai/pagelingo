# 本地 PDF 离线阅读包

本地处理要求 **Linux、可访问的 `/proc/self/fd`、Node.js 24+**；翻译还要求
**`/usr/bin/flock`（util-linux）**。文件源通过 Linux 文件描述符固定目录，其他操作系统
没有处理兼容保证。导出的 ZIP 和 `file://` 阅读入口可移至其他平台阅读。
CLI 不自动安装 Python、下载模型、准备旧 KaTeX，也不读取站点 `.env.local` 或站点 Key。

先在仓库根目录执行 `npm ci`。以下四步可分别执行；将尖括号占位符替换为实际路径或值。
所有新 run、输出目录和 ZIP 必须不存在，并位于原 P0、preview、处理 run 之外。
`pdf:*` 入口先按 SDK → contracts → renderer → bundle → CLI 顺序构建。

```sh
npm run pdf:process -- --source <pdf> --run-dir <new-run> --p0-run <existing-run> [--preview <existing-preview>]
npm run pdf:translate -- --run <run> --base-url <url> --model <model> --selection auto --resume
npm run pdf:bundle -- --run <run> --output <new-dir> --archive <new.zip>
npm run pdf:verify -- <zip>
```

第一步仍需准备可运行 `reader_inspection.py` 的 Python 3.12 环境；通过 `--python`
指定解释器，默认使用 `services/document-parser/.venv-mineru/bin/python`。
复用完整 P0 和 preview 时不重新运行模型；preview 省略时会从已有 raw 显式生成新 preview。
正式支持 MinerU P0 和经过验证的 0.5/0.6 原文 preview。Docling 和已翻译的旧 preview
返回不支持。局部解析会保留缺页、coverage 和警告，无法可靠定位的内容仅定位到原页。

## Python、模型与旧预览的显式准备

已有可用环境和模型时直接复用。需要新建环境时，由用户分别执行：

```sh
npm run pdf:setup
cd services/document-parser
UV_PROJECT_ENVIRONMENT=.venv-mineru uv sync --locked --extra mineru --no-default-groups
cd ../..
# 以下命令显式下载锁定模型；只在尚未准备模型时运行。
npm run pdf:cli -- prepare-models --parser mineru
```

详见 [parser 环境说明](../services/document-parser/README.md)。不提供 `--p0-run` 的新解析
必须指定已准备好的 `--model-dir`；`--pages all` 或 `--pages 1,3-5` 使用从 1 起的原始页号。
不会在解析失败后调用在线模型服务。

旧 preview exporter 使用单独锁定的 **KaTeX 0.19.0**，与阅读包内受信任的 KaTeX 0.19.1
分开。没有已有 preview 时，先显式执行现有准备工具（该命令联网下载并验证完整性；输出目录必须新建）：

```sh
python3 benchmarks/pdf/tools/prepare-preview-renderer.py --output data/pdf-p0/render-deps/katex-0.19.0
npm run pdf:process -- --source /path/book.pdf --run-dir /path/new-run \
  --python /path/prepared/python --model-dir /path/prepared/models \
  --katex-dir data/pdf-p0/render-deps/katex-0.19.0/package --pages all
```

复用已有 P0 而生成新 preview 的例子：

```sh
npm run pdf:process -- --source /path/book.pdf --run-dir /path/new-run \
  --p0-run /path/p0 --python /path/prepared/python \
  --katex-dir /path/prepared/katex-0.19.0/package
```

## 翻译、手工选择与恢复

将 Key 放在本地 shell / secret manager 中，默认为 `PAGELINGO_LLM_API_KEY`。
`--api-key-env NAME` 可更换变量名；没有 `--api-key` 参数。
[`.env.pdf.example`](../.env.pdf.example) 仅列假值模板，CLI 不自动加载它。
URL 和模型必须由 `--base-url`、`--model` 明确指定。远端使用 HTTPS，本机 localhost / loopback
可使用 HTTP；URL 中禁止凭据、query 和 fragment。

`auto` 只选英语和继承文档英语判断的短标题；中文和没有自然语言的块保留原文。
mixed / und 内容维持 pending，提示 `MANUAL_SELECTION_REQUIRED`。需手工覆盖时，显式选择
全部文本并覆盖源语言；原 IR 语言判断保持不变：

```sh
npm run pdf:translate -- --run /path/run --base-url https://provider.example.invalid/v1 \
  --model YOUR_MODEL --selection all --source-language en --new-job
```

首次运行可直接带 `--resume`。中断、取消或磁盘故障后，使用相同配置和 `--resume`
继续；SDK 重验已完成块 / 单元和缓存，只处理未完成工作，保留重试次数和 429 冷却。
更换模型、术语、预算或选择需 `--new-job`，与 `--resume` 互斥；耗尽重试的失败单元
也需新 job 才有新尝试预算。原 run 的 `config.json.translationStatus` 是初始状态，
当前翻译状态来自已验证的不可变快照。

无需翻译时直接跳过第二步导出，不需要 provider 配置或 Key。英语包标记 pending 并列出
未译单元；中文包是 not-required；部分译文是 partial。解析 coverage 与翻译状态分开，
completed 不表示缺页已补齐或图片内文字已翻译。测试 provider 的结果明确标记 mock，
不代表语义翻译质量。

## 导出、校验与阅读

导出重新验证 source PDF、IR、provenance、图片、已发布译文快照和 SDK 绑定；
要求处理状态 ready / complete 或 partial、`exportReady: true`、无 exportBlockers。
缺图、输入 hash 变化、未知运行元数据路径 / 敏感配置均阻止完整导出。
正文中的合法 `/usr/bin/...` 示例保持原样，opaque raw 保留来源证据；工具不声称能识别任意原文中的秘密。
已知 debug 路径投影为 null，新的 provenance ledger 只保留其原值 hash 和 pointer。
含旧式原绝对运行路径 ledger 的历史 run 会拒绝导出；请用原始输入生成新 run，旧产物不原地修补。

每次导出使用新的 packageId 和 translation.id，不修改原快照或 source IR。
只导出正式译文允许的字段，SDK raw protected text 用于重验；可变原始 checkpoint、
job/config 整体、缓存、日志、Key、原始 provider URL 均不导出。
完整快照和缓存保留在本地 run，显式恢复可能增加快照；没有自动 GC，长期使用会增加磁盘占用。

包中包含 `manifest.json`、逐字节原件 `source.pdf`、`source-ir.json`、`translation.json`、
`render/index.html`、`render/data/`、`assets/`（图片、runtime、CSS、字体）、
`provenance/` 和 `licenses/`。manifest 覆盖自身以外的全部普通文件，绑定源、解析、译文和
renderer 版本与 hash；实际文件 hash 与 canonical manifest 身份分别计算。
共享静态模板、runtime / CSS / 字体必须匹配安装的可信目录；伪造 manifest hash 不能授权篡改的脚本或数据。

ZIP 发布前运行完整 `validateBundle` 自检，归档阶段再次验证并逐文件重验字节，
最终原子创建新 ZIP。已存在的目录和 ZIP 永不覆盖；失败不发布成功 ZIP，可能保留新建的
调试目录及固定错误码 `export-failure.json`，应换新输出路径重试。原输入始终保留。
默认限制为 PDF / ZIP 各 256 MiB、解压总量 1 GiB、10,000 文件、IR / 译文各 32 MiB。
`PAGELINGO_BUNDLE_LIMITS_JSON` 可指定 strict 部分覆盖，结构上限只能收紧；PDF 字节
仅由 `PAGELINGO_MAX_PDF_BYTES` 配置。超限明确失败。

在系统归档工具中解压校验成功的 ZIP，浏览器打开 **`render/index.html`**。
本地 classic data scripts 直接注册，无服务、fetch、module CORS 或 CDN 依赖。
图片、KaTeX 公式、所有字体和原 PDF 都来自包内；最多保留当前与相邻共三片。
可切换原文 / 译文、目录跳转、PDF 对照和原件下载。正文来源超链接仅在主动点击时离开本地包。

普通 Node 测试：`npm run test --workspace @pagelingo/pdf-cli`。
独立浏览器验收：`npm run test:pdf:offline`，需事先准备 Playwright Chromium。
该验收使用 Node 生成的 PDF 和自有 fixture，通过真实 ZIP 解压后在 `file://` 中遍历首、中、末片，
检查实际图片 / 字体 / 公式加载、原件链接和三片窗口，并阻断全部 HTTP(S)。不使用 Python、模型或真实 API。

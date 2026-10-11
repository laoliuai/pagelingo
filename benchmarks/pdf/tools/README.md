# P0 原文静态预览工具

从现有 MinerU 4.0.10 / DocVortex 0.5.10 raw 生成单栏原文 HTML，不重新解析或调用 LLM。使用上游语义 renderer、KaTeX 0.19.0 预排版公式，每个原 PDF 页独立 HTML，CSS / 字体共享，只运行本地导航脚本。解压 ZIP 后直接打开 `index.html`，再选择开始阅读或目录。

2026-10-07 根据长书偶发 hang 和表格 / 图表失真的反馈，改为分页加载，提供上一页 / 下一页、左右方向键、PDF 页码跳转、目录与原 PDF 页入口。浏览器只挂载当前页的正文和公式，不使用隐藏整个文档的方式模拟分页。图、表、图表主体均改为原 PDF 的 216 dpi PNG 区域图，保留颜色、线条、文字和布局；点击可放大。图注 / 表注独立保留，区域图内部暂不翻译或选字。识别区域可能不准确，不能据此保证原件中的所有标注都被完整裁入。

2026-10-10，RL 新版增加原 PDF 绘制区域的强调框投影、算法原件图与异常文字 / 数学符号的来源回退。30 个确认的强调框用 HTML 保留背景、边框、标题条和可选文字；7 个算法保留原图的浮动标题、行号和缩进。书内 49 页的条件期望原先被分入 text，带控制字符，另一个问号被识别成数学下标；两处均保留原件，PPO 的异常字形也随算法原图保留。导航同时显示 PDF 页码和书内印刷页码。没有新解析 / LLM 请求。

强调框检测仅处理直接页面、不透明、轴对齐的矩形 / 圆角填充路径，排除图表区域；嵌套 Form、扫描 / 图片背景、透明和倾斜装饰仍不支持。问号下标是“不确定，显示原件”的保守规则，合法的此类数学标记也可能使用回退。混合了异常公式和正文的块暂整体保留原件图，里面的正文也暂不可直接选字或翻译，原始结构文本仍在 retained raw。

这是 P0 展示实验，不是正式 Reader、增强解析或翻译产物。它能帮助区分结构解析与 `debug.html` 的普通文本展示问题。公式排版成功不证明识别正确；排版失败保留 LaTeX，数量在页面顶部和 `preview.json` 中显示，原 PDF 随包保留。

需要已安装的 `.venv-mineru` 和 Node.js。仓库根目录显式准备固定 renderer，目录须不存在：

```bash
services/document-parser/.venv/bin/python benchmarks/pdf/tools/prepare-preview-renderer.py \
  --output data/pdf-p0/render-deps/katex-0.19.0
```

下载由 [renderer lock](preview-renderer.lock.json) 的 SHA-512 校验，不影响 npm 默认依赖。已准备时不重复此命令。导出目录与 ZIP 须不存在：

```bash
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/export-mineru-preview.py \
  benchmarks/pdf/runs/2026-10-07/mineru-full/mineru-llm-foundations \
  --output data/pdf-p0/static-previews/my-llm \
  --katex data/pdf-p0/render-deps/katex-0.19.0/package \
  --archive releases/pdf-previews/my-llm.zip
```

`--visual-scale` 默认 3，对应 216 dpi，可在 1–4 中选择；边缘增加 2 PDF pt 留白，降低定位舍入导致的细线截断。已旋转 CropBox 坐标不再旋转，抽页按运行的请求页映射回原文件。区域参数与 checksum 保存在 `preview.json`，原图主体的识别文字不再用于构造 HTML 表格。

工具先校验原运行 manifest，原始产物不覆盖。包内有 `index.html`、`pages/`、原 PDF、原件区域图 / 实际使用图片、共享 CSS / 字体、导航脚本、第三方许可、原运行 / 配置来源、公式 fallback 列表和全部输出的 SHA-256 manifest。`preview.json` 的 `reparsed=false` / `translated=false` 明确标注处理范围。页面没有可读块时提供原 PDF 入口，不宣称页面一定空白；FULL 渲染保留各源页边界，不跨页吸收下一页段落。

新版下载：

- [LLM Foundations 分页包](../../../releases/pdf-previews/llm-foundations-basic-paged-v2.zip)：317 页，155 个原件图 / 表区域，最大页面 HTML 148281 B / 3608 个 DOM 元素。
- [RL Little Book 新版分页包](../../../releases/pdf-previews/rl-little-book-basic-paged-v4.zip)：154 页，30 个强调框，60 个图 / 表区域、7 个算法原件图和 2 个不确定区域回退，最大页面 HTML 59442 B / 1451 个 DOM 元素。

共享 CSS 含离线字体，约 1.47 MB，仅随包保存一份；以上页面大小不包含它。LLM v2 预排版 1611 个公式、5 个 fallback。RL 最新版预排版 427 个公式、KaTeX fallback 为 0；算法、图表和受保护块内部公式随原件图片保留，不再计入 KaTeX 数量。这些数字不代表识别准确率，也不能证明所有公式均被分类为公式。

旧版整本单页包保持不变，其记录见 [旧版离线验证](../static-preview-validation.json)。新版 ZIP / 原件像素与链接检查见 [包验证](../paged-preview-package-validation.json)，断网逐页打开和翻页 / 跳转 / 滚动 smoke test 见 [浏览器验证](../paged-preview-browser-validation.json)。两份包的所有 215 个图表区域均与原 PDF 按记录参数重新渲染的像素一致，但这不证明 parser 的 bbox 语义边界正确。

以上为 2026-10-07 的 v2 包记录。2026-10-10 RL 更新记录见 [包验证](../rl-preview-package-validation-2026-10-10.json) 与 [浏览器验证](../rl-preview-browser-validation-2026-10-10-final.json)，旧包不覆盖。

仓库根目录可复现不调用模型的裁剪回归和离线浏览器检查（先自行解压到新目录）：

```bash
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-crops.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-source.py
node benchmarks/pdf/tools/check-paged-preview.mjs data/pdf-p0/my-browser-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v2 \
  data/pdf-p0/preview-zip-check/rl-little-book-basic-paged-v4
```

分页包是 P0 展示实验。正式版本从共同 Reader IR 实现章节导航、有限 DOM 窗口、来源跳转、翻译和助手，不扩展为依赖 MinerU raw 的第二套产品阅读器。详见 [本机处理与静态产物](../../../docs/pdf-processing.md)。

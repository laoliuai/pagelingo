# P0 原文静态预览工具

从现有 MinerU 4.0.10 / DocVortex 0.5.10 raw 生成单栏原文 HTML，不重新解析或调用 LLM。使用上游语义 renderer、KaTeX 0.19.0 预排版公式，每个原 PDF 页独立 HTML，CSS / 字体共享，只运行本地导航脚本。解压 ZIP 后直接打开 `index.html`，再选择开始阅读或目录。

2026-10-07 根据长书偶发 hang 和表格 / 图表失真的反馈，改为分页加载，提供上一页 / 下一页、左右方向键、PDF 页码跳转、目录与原 PDF 页入口。浏览器只挂载当前页的正文和公式，不使用隐藏整个文档的方式模拟分页。图、表、图表主体均改为原 PDF 的 216 dpi PNG 区域图，保留颜色、线条、文字和布局；点击可放大。图注 / 表注独立保留，区域图内部暂不翻译或选字。识别区域可能不准确，不能据此保证原件中的所有标注都被完整裁入。

2026-10-10，RL 新版增加原 PDF 绘制区域的强调框投影、算法原件图与异常文字 / 数学符号的来源回退。30 个确认的强调框用 HTML 保留背景、边框、标题条和可选文字；7 个算法保留原图的浮动标题、行号和缩进。书内 49 页的条件期望原先被分入 text，带控制字符，另一个问号被识别成数学下标；两处均保留原件，PPO 的异常字形也随算法原图保留。导航同时显示 PDF 页码和书内印刷页码。没有新解析 / LLM 请求。

2026-10-12，增加原生 PDF 视觉行、基线和局部正文边界的缩进恢复，区分首行、整段、列表
层级和框内缩进。列表项包含中间的说明 / 示例 / 公式 / 强调框，支持字母编号与子列表；
避免说明重复缩进。LLM 书内 25 页（PDF 第 34 页）的六行 Original / Unchanged Token、
Sequence / Label 示例按标签和值重组，同组共享列宽，标签在桌面保持一行，下划线与
红色文字保留。布局补充文件独立保存，重组前验证原 DOM 文字完整覆盖；匹配不可靠时
保留原节点。原始 source / raw / manifest 和旧包均保留。

之前的术语分行、目录层级、空白补全线、局部颜色及原生脚注修复也包含在新版中。
列表、缩进与容器仍是基于样本的保守规则；跨页续接、复杂多栏、扫描件、旋转文字和
表格的结构化重建未完成。插件 0.4.4 / translation-core 0.4.0 已支持局部颜色、背景高亮、
下划线、提示变量和答题线的保护与回填；具体样式在本地绑定，不发送 CSS 给模型。

LLM Foundations v5 恢复 49 个确认的提示框，包括误判的 code / table 候选。
按原生视觉行区分逻辑正文、变量独立行和答题线；灰色 SYSTEM / USER / DEMO 角色
保留为独立列，示例映射保持原样。PDF 108 页的 premise 从原生文字恢复，109 页的
Q/A 放回引导段落之后；110 页的续段不会被上游并入提示框后覆盖，112 页按角色与
示例对齐，114 页的指令 / 变量 / 空白保持三行。明确的编程语言、算法及真正公式
不进入提示框重建。连续下划线路径先合并，避免把下划线正文的间隔误作填空。

LLM Foundations v6 增加单行文字高亮的原生填充路径投影，PDF 117 页两处绿色指令
与下划线回答保持可翻译；译文背景色通过插件 0.4.4 的本地样式绑定回填。PDF 120 页
的三句指令使用原生共同左边界，避免第三句被误判居中。PDF 124 页的 DEMO / USER
框原解析漏掉中间文字；仅在角色共享一列、存在多组 Q/A、已有解析片段精确匹配且
没有外部块争用这些字符时，从 PDF 文字层补回完整内容。补充文件另存原 bbox、导出
bbox 和恢复字符区间；没有重新解析、模型补写或改写原 raw。

2026-10-13，LLM Foundations v7 修复 PDF 125 页的斜体示例误判为标题。只对原生
文字精确匹配、与正文同字号、字体明确为普通字重斜体的单行示例恢复正文语义，
保留真实编号标题；字体名、标志、字重、字号和来源字符范围留在补充记录中。
125、145、154 页共 3 个示例恢复居中斜体。131 页识别 TASK，按 TASK / DEMO / USER
分配任务说明、两组问答和用户问答；无角色的前置说明跨整组列，避免长文字撑大角色列。
角色词仍使用明确的原生标签匹配，没有把其他表格改成正文。继续使用插件 0.4.4。

2026-10-15，LLM Foundations v8 将文字背景高亮接入普通段落路径，不再依赖提示框 / 角色
识别。PDF 132 页的 12 处蓝、橙、红色问题与答案保持背景，可随中文译文回填。规则使用
原生文字行与不透明彩色矩形的对应关系，支持框内、框外正文；标准化后须完整匹配原文，
匹配失败记录 `text-mismatch`，不根据局部相似片段猜测位置。逐词背景之间只连接同色空白，
保留链接、斜体和连字映射。生产规则不按书名或固定页码分支；页码仅用于真实样本回归。

同日的 v9 增加原生字体和整行下划线校对。无效嵌入字重（如 0 / 1472）不作为加粗证据，
修正 PDF 135 / 136 页的零散中文黑体；136 页 Refinement 的全部正文保留下划线，154 页
普通说明恢复正文语义，162 页的原生斜体保留。颜色绑定同时支持灰色文字。
139 页的空答题位按底线与彩色矩形共同定位，保留红 / 蓝色背景和 literal 保护。
140 页合并的模板块按三个互不相交的原生背景拆成三个逻辑片段，每框三行；不重编号原
parser block，记录片段字符范围及原类别 / 原文字 / 原 bbox。

未映射的数学扩展字体可能把求和或定界符编码成普通字母。较窄的独立脚注公式采用
原 PDF 区域，143 页保留求和符号；不把包含局部公式的宽幅脚注正文整段转图。
有唯一共同图注、行列对齐且没有正文交叠的组合图整体裁剪，子图标签留在图内，主图注
单独可翻译；160 页的 2×2、226 页的 4×2、239 页的 3×2 图组保留原件布局。

同日的 v10 补充带独立标签的单列正文框覆盖检查。现有段落须与原生文字精确匹配，
仅允许较长段落缺少一个行首字；框内漏掉的完整行必须是独立冒号标签，且不与其他块
争用字符。135 页补回 `Chinese:`、`English:` 和“一”，136 页同样补回“一”。保留
原 parser 索引，按成员分别记录原 / 导出 bbox 与恢复字符区间；中文换行不额外拆开词语。
灰色字段列只有在共同对齐、至少两个完整占位变量和指令正文均与原解析匹配时，才按
模板角色处理。172 页原本存在的示例从页首放回引导段落后，并保留输出变量的下划线。

同日的 v11 恢复原生文字中存在、但解析漏掉的圆点列表符号。正文必须完整匹配且有
悬挂缩进，不凭段落位置补圆点；171 页与其他 6 项同类漏符号一起修复，来源索引和
原解析文字记录在列表项的 `nativeMarkerRepair`。组合图允许完整行之后的居中末图，
182 页保留 `ab / cd / e`。单列图组额外核对原生 `(a)`、`(b)` 等连续说明，184 页两张
子图及其小图说明整体保留原版居中和字重，公共主图注继续可翻译。

密集公式脚注若缺少结构化公式，且同时存在分割线、多个重叠碎块和未映射数学字体，
整段保留为原 PDF 区域。194 页的公式、上下标和相邻说明不再拼成普通文字；正文公式
保持原有排版。该保护区域中的文字暂不翻译，可点击查看高清图；原碎块保存在
`originalVisuals[].protection.originalBlocks`，不覆盖原 raw。

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

`source-layout.json` / `source-layout.schema.json` 是经过校验的实验性来源补充，包含源运行和
hash、带索引空间声明的半开字符区间、视觉行、原解析阅读顺序、匹配歧义、段落 / 列表 /
标签行和容器引用。v5 至 v11 使用版本 2，另存提示框的原解析类别 / 文字、角色和行内样式、
占位线来源、暂不合并的续段及局部阅读顺序修复 before / after；原 raw 索引不变。
叶节点互斥拥有原生字符，容器只引用成员；几何归属不是置信度。
PDFium 字符索引不等于 PDF 内容流 glyph ID，文件不等于正式 Reader IR。标签行覆盖
对应段落缩进规则时，记录 `superseded-by-label-rows`；失败或受保护规则也记录原因。

新版下载：

- [LLM Foundations v11](../../../releases/pdf-previews/llm-foundations-basic-paged-v11.zip)：317 页，98 个强调框，其中 67 个恢复为结构化提示框，包含 21 个角色标签、44 个文字高亮绑定、3 个居中斜体示例和 3 个原生文字覆盖恢复框；113 个图 / 表原件区域（含 14 个组合图）、23 个术语符号图和 5 个保护区域（2 个算法、3 个公式 / 文字区域）。95 组共 232 项列表，7 组共 15 行标签 / 值示例，59 个补全线。最大页面 HTML 149759 B / 3612 个 DOM 元素。
- [RL Little Book v6](../../../releases/pdf-previews/rl-little-book-basic-paged-v6.zip)：154 页，30 个强调框，60 个图 / 表区域、7 个算法原件图和 2 个不确定区域回退；33 组列表、22 个缩进文本块。最大页面 HTML 60188 B / 1451 个 DOM 元素。

共享 CSS 含离线字体，约 1.47 MB，仅随包保存一份；以上页面大小不包含它。LLM v11 预排版 1589 个公式、4 个 fallback。RL v6 预排版 427 个公式、KaTeX fallback 为 0；算法、图表和受保护块内部公式随原件图片保留，不再计入 KaTeX 数量。这些数字不代表识别准确率，也不能证明所有公式均被分类为公式。旧版解析、manifest 和已经存在的旧包不覆盖。

旧版整本单页包保持不变，其记录见 [旧版离线验证](../static-preview-validation.json)。新版 ZIP / 原件像素与链接检查见 [包验证](../paged-preview-package-validation.json)，断网逐页打开和翻页 / 跳转 / 滚动 smoke test 见 [浏览器验证](../paged-preview-browser-validation.json)。两份包的所有 215 个图表区域均与原 PDF 按记录参数重新渲染的像素一致，但这不证明 parser 的 bbox 语义边界正确。

前述两份旧验证为 2026-10-07 的 v2 包记录。2026-10-10 RL 更新记录见 [包验证](../rl-preview-package-validation-2026-10-10.json) 与 [浏览器验证](../rl-preview-browser-validation-2026-10-10-final.json)，旧包不覆盖。

2026-10-12 最终包的验证见 [整包 / 来源像素](../paged-preview-package-validation-2026-10-12-final.json)、
[断网逐页浏览器](../paged-preview-browser-validation-2026-10-12-final.json) 和
[插件结构回归](../preview-structure-validation-2026-10-12-final.json)。来源像素检查重新渲染
包内原 PDF，逐个比较区域图；插件检查使用实际 DOM 提取 / 回填代码和模拟译文，验证
标签、列表、术语分行、模式切换和原文精确恢复，不调用 LLM，也不评价实际翻译质量。

LLM v5 的更新验证见 [整包 / 来源像素](../llm-prompt-package-validation-2026-10-12-final.json)、
[317 页断网加载](../llm-prompt-browser-validation-2026-10-12-final.json)、
[提示框 / 插件回填](../llm-prompt-structure-validation-2026-10-12-final.json) 和
[既有布局回归](../preview-structure-validation-2026-10-12-prompts-final.json)。
提示框检查包含 PDF 17、108、109、110、111、112、114 页与窄屏布局；验证可见答题线、
变量、灰色角色列、同组缩进、缺失保护对象拒绝回填以及原文精确恢复。译文使用 Mock，
图片中的“测试译文”不代表实际翻译。更新插件后再使用新包，详情见
[安装指南](../../../docs/install-m2.md)。原文预览支持 `file://` 离线阅读；插件当前只支持
HTTP/HTTPS，翻译时需通过本地或已有静态 HTTP 服务打开阅读包。

LLM v6 的最终包验证见 [整包 / 来源像素](../llm-highlight-package-validation-2026-10-12-final.json)、
[317 页断网加载](../llm-highlight-browser-validation-2026-10-12-final.json)、
[16 页提示框 / 插件回填](../llm-highlight-structure-validation-2026-10-12-final.json) 与
[既有布局回归](../preview-structure-validation-2026-10-12-highlights-final.json)。新增检查
包含 PDF 117 页的真正中文模拟译文背景和回答下划线、120 页翻译后同组对齐、
124 页六段 Q/A 的完整回填，以及其他因高亮而恢复的提示框；窄屏检查含这三页。
译文均为固定 Mock，不请求真实 LLM。

LLM v7 的验证见 [整包 / 来源像素](../llm-role-package-validation-2026-10-13-final.json)、
[317 页断网加载](../llm-role-browser-validation-2026-10-13-final.json)、
[20 页提示框 / 插件回填](../llm-role-structure-validation-2026-10-13-final.json) 与
[既有布局回归](../preview-structure-validation-2026-10-13-roles-final.json)。实际插件 DOM
适配器验证中文模拟译文的居中、斜体、与正文同字号 / 字重，以及三个灰色角色、
任务说明和完整问答的列宽、位置与可见性；另测无标签前置说明和 390 px 窄屏。
这些结构检查不调用 LLM，也不评价真实翻译语义质量。

LLM v8 的验证见 [整包 / 来源像素](../llm-inline-highlight-package-validation-2026-10-15-final.json)、
[317 页断网加载](../llm-inline-highlight-browser-validation-2026-10-15-final.json)、
[21 页插件回填](../llm-inline-highlight-structure-validation-2026-10-15-final.json)、
[既有布局回归](../preview-structure-validation-2026-10-15-inline-highlights-final.json) 和
[新旧逐页对比](../llm-inline-highlight-diff-validation-2026-10-15-final.json)。PDF 132 页验证
原文和模拟中文问题及数字答案的背景色，包含 390 px 窄屏；自造 PDF 回归还覆盖无框正文、
重复词不串色、跨链接 / 斜体、连字展开与不匹配时跳过。报告和截图为本地产物，不纳入 Git。

LLM v9 的最终验证见 [整包 / 原件像素](../llm-layout-batch-package-validation-2026-10-15-final.json)、
[317 页断网浏览](../llm-layout-batch-browser-validation-2026-10-15-final.json)、
[本轮 8 页插件回填](../llm-layout-batch-plugin-validation-2026-10-15-final.json)、
[既有 21 页回填](../llm-layout-batch-prompt-validation-2026-10-15-final.json)、
[既有布局回归](../preview-structure-validation-2026-10-15-layout-batch-reviewed-final.json) 和
[最终包核对](../llm-layout-batch-release-validation-2026-10-15-final.json)。41 项 Python 回归通过，
166 个原件区域逐像素一致。除补全线及改用原图的数学 / 子图标签外，逐页正文与列表数量
保持不变。所有译文验证使用 Mock，不调用 LLM；原始 raw、原 PDF、manifest 和旧包保留。

LLM v10 的验证见 [整包 / 原件像素 / 原生文字覆盖](../llm-native-coverage-package-validation-2026-10-15-candidate-2.json)、
[317 页断网浏览](../llm-native-coverage-browser-validation-2026-10-15-candidate-2.json)、
[9 页插件回填](../llm-native-coverage-plugin-validation-2026-10-15-candidate-2.json)、
[既有 21 页回填](../llm-native-coverage-prompt-validation-2026-10-15-candidate-2.json)、
[既有布局回归](../preview-structure-validation-2026-10-15-native-coverage-candidate-2.json) 和
[最终包核对](../llm-native-coverage-release-validation-2026-10-15-final.json)。50 项 Python 回归
包含缺行 / 行首字、中文换行、字段模板排序，以及不匹配、双列、争用字符和真实代码的拒绝路径。
整包验证直接从原 PDF 提取全部 67 个提示框的文字，与最终 HTML 比较，不使用投影行作为
正确答案。相对 v9 仅 135、136、172 页 HTML 改变；166 个原件区域逐像素一致。
候选包 2 与最终 ZIP 字节完全一致，报告与截图仅本地保存，译文验证仍使用固定 Mock。

LLM v11 的验证见 [整包 / 来源像素](../llm-figures-footnotes-package-validation-2026-10-15-candidate-1.json)、
[317 页断网浏览](../llm-figures-footnotes-browser-validation-2026-10-15-candidate-1.json)、
[13 页插件回填](../llm-figures-footnotes-plugin-validation-2026-10-15-candidate-1.json)、
[既有 21 页回填](../llm-figures-footnotes-prompt-validation-2026-10-15-candidate-1.json)、
[既有布局回归](../preview-structure-validation-2026-10-15-figures-footnotes-candidate-1.json)、
[逐页变化及原生标记核对](../llm-figures-footnotes-diff-validation-2026-10-15-candidate-1.json) 和
[最终包核对](../llm-figures-footnotes-release-validation-2026-10-15-final.json)。60 项 Python 回归
通过，包含缺符号时的完整文字校验、非居中末图 / 不连续子图标签的拒绝，以及有结构化
公式、缺少分割线或与正文重叠时不整段转图。全部 141 个原件区域逐像素一致，67 个提示框
原生文字一致；新旧 317 页对比仅 18 页应用上述修复。原文 DOM 精确恢复，译文使用 Mock。

仓库根目录可复现不调用模型的裁剪回归和离线浏览器检查（先自行解压到新目录）：

```bash
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-crops.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-source.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-layout.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test-preview-prompts.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_typography.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_panel_fragments.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_figures.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_panel_coverage.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_native_lists.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/test_preview_footnote_bands.py
services/document-parser/.venv-mineru/bin/python benchmarks/pdf/tools/check-preview-package.py \
  data/pdf-p0/my-package-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v11-final \
  data/pdf-p0/preview-zip-check/rl-little-book-basic-paged-v6-final
node benchmarks/pdf/tools/check-paged-preview.mjs data/pdf-p0/my-browser-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v11-final \
  data/pdf-p0/preview-zip-check/rl-little-book-basic-paged-v6-final
node benchmarks/pdf/tools/check-preview-structure.mjs data/pdf-p0/my-structure-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v11-final \
  data/pdf-p0/preview-zip-check/rl-little-book-basic-paged-v6-final
node benchmarks/pdf/tools/check-preview-prompts.mjs data/pdf-p0/my-prompt-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v11-final
node benchmarks/pdf/tools/check-preview-layout-batch.mjs data/pdf-p0/my-batch-check.json \
  data/pdf-p0/preview-zip-check/llm-foundations-basic-paged-v11-final
```

分页包是 P0 展示实验。正式版本从共同 Reader IR 实现章节导航、有限 DOM 窗口、来源跳转、翻译和助手，不扩展为依赖 MinerU raw 的第二套产品阅读器。详见 [本机处理与静态产物](../../../docs/pdf-processing.md)。

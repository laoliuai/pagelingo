# HJFY 0.1.5：LaTeX、PDF 与保真翻译架构

调查日期：2026-10-11。对象：本地 macOS x86-64 DMG 的解包内容。

## 核心答案

PDFRuntime 集成 ONNX，是因为 PDF 并不天然包含“段落、公式、表格”这样的语义结构。程序需要先识别页面内容，再决定什么翻译、什么保持原样。模型负责文档视觉分析及图像处理，翻译由另一个可配置 LLM 接口承担。

当前证据支持的架构是 **Swift 桌面界面 + Rust 文档引擎 + 本地视觉模型 + 外部 LLM + 自有排版/校验代码**，不是让 LLM 直接接管整份 PDF，也不是先把所有公式转成 LaTeX。

| 组件 | 分工与证据 |
| --- | --- |
| `Contents/MacOS/HJFY` | Swift GUI；模型、语言、文档和任务设置；已有字符串支持引擎路径及 CLI 参数 |
| `OfficeRuntime/bin/hjfy-office` | Rust 引擎；LaTeX 分段、语法树、不可变片段保护、译后校验与工程编译；详见前一报告 |
| `PDFRuntime/bin/hjfy-pdf` | Rust 引擎；PDF 内容解释、页面布局、OCR、公式分组、翻译单元、排版及输出 |
| `libpdfium.dylib` | PDF 渲染能力；包内资源声明版本 `147.0.7713.0`，代码包含 PDFium 绑定 |
| `libonnxruntime.1.23.2.dylib` | 本地 ONNX 推理运行库；布局函数直接调用 `ort::Session::run_inner` |
| PDFRuntime 字体 | 为译文提供语言覆盖、粗体/斜体及不同内容角色的字体；不能保证与原字体完全相同 |

PDF 引擎 SHA-256：`0edf170b92e65931dc9878846904cf628c18326a7290e0b4bffaf238afcca50a`。实际文件与包内 manifest 一致；六个模型的实际哈希也与 manifest 一致。manifest 自身明确标记 `build_provenance=not_attested`、`usage=development_only`、`release_ready=false`、`self_check=not_run`，不应把包内声明当作已认证来源或质量保证。

## 为什么带这些 ONNX 文件

ONNX 是神经网络计算图及权重的交换格式。此次直接解析 protobuf 元数据、输入输出及操作类型，没有加载推理引擎或执行模型。

| 模型 | 实测大小 | 模型结构与用途 |
| --- | --- | --- |
| `pp_doc_layoutv3.onnx` | 130.50 MB | 输入 `image=[N,3,800,800]`、`im_shape`、`scale_factor`；输出动态七列数据及两个整数输出；内嵌 25 类区域标签。用于布局识别，代码调用可核实 |
| `pp-ocrv6_tiny_det.onnx` | 1.78 MB | RGB 图像输入，单通道空间输出，ConvTranspose + Sigmoid；与 OCR 文本区域检测相符 |
| `pp-ocrv6_tiny_rec.onnx` | 4.46 MB | 输入高 48 的文字图像，动态宽度；输出序列最后一维 6906。配套 tiny 字典，用于字符识别 |
| `pp-ocrv6_small_det.onnx` | 9.88 MB | 同类检测输出；包内更大的检测选项 |
| `pp-ocrv6_small_rec.onnx` | 21.16 MB | 高 48 的文字图像输入，输出序列最后一维 18710；配套较大字典 |
| `inpainting/aot-manga-fp32.onnx` | 23.06 MB | `image=[1,3,512,512]`、`mask=[1,1,512,512]`，输出 RGB 图像；producer 为 PyTorch `2.2.2`。用于掩膜图像修补的证据很强 |

OCR 输出维度不是“精确支持多少语言”的证明，字符类别通常还包含解码特殊项。tiny/small 是可选资源，不代表每次任务两套都运行；默认选择与性能差异未验证。

布局模型的 25 类原始元数据：

```text
abstract, algorithm, aside_text, chart, content, display_formula,
doc_title, figure_title, footer, footer_image, footnote, formula_number,
header, header_image, image, inline_formula, number, paragraph_title,
reference, reference_content, seal, table, text, vertical_text, vision_footnote
```

这说明为什么普通 PDF 论文也需要视觉模型：可以把文字坐标与“正文/图注/公式/表格”的视觉区域结合，降低公式和页眉混入正文的风险。模型标签不等于每类都识别准确；七列输出的完整语义和所有后处理阈值尚未逐项恢复。

### 图像修补模型为什么不是多余的

扫描件里的文字是像素，不能像原生 PDF 一样删除文字绘制指令。若直接写译文，会叠在原文上；若用白色矩形遮盖，会破坏有色背景或纹理。修补模型接收原图和文字掩膜，估计被遮区域的背景，再让程序写入译文。

代码存在 `raster::restore::Restorer::prepare`、`source_masks`、`clear_background`、`acceptable_boundary`，配置有 `raster-background`、`raster-inpaint-model=aot/lama`。AOT 包内自带；LaMa 有外部模型文件配置入口，此包未发现 LaMa 权重。

已反编译的 `Restorer::prepare @ 0x10062bad0` 可见 RGB/灰度图缩放、512 尺度处理和 ONNX Session 构建。完整推理调用及顶层选择路由尚未恢复，所以不能断言所有扫描 PDF 都走 AOT，更不能断言普通原生文字 PDF 需要修补模型。`raster` 也包含图片及图片归档任务代码。

修补会生成估计像素，**不适合承诺科技图表和细线区域的像素级无损**。是否主动避让图表、修补失败如何保留原文，需要专项样例验证。

## LaTeX 怎么处理

LaTeX 有源码结构，可靠路线是“改可译文本，保留结构，重新编译”：

```text
源码 / 工程
 -> 收集自定义宏
 -> 段落、标题、宏、环境分段
 -> AST 保护公式和不可变片段，替换为 \cmd数字
 -> 文本 + 专用提示词 + 术语 -> LLM
 -> 修复、结构检查、占位符还原、再次检查
 -> 回填 .tex
 -> 工程模式用 TeX / 文献工具编译与诊断修复
```

前一轮已有 12 个关键函数的定向伪代码及完整 LaTeX 提示词，参见 `HJFY-0.1.5-逆向初步报告.md` 和 `HJFY-0.1.5-static-evidence.json`。

保真对象主要是公式源码、命令、环境、图像引用和文档结构，而非原 PDF 的每个像素。有 `\includegraphics` 时，合理设计是保留原图片引用，翻译图注；具体保留规则未逐一恢复。翻译改变文字长度，TeX 重编译可能改变断行、浮动图表位置和分页，“结构不变”不等于“页码不变”。

## PDF 怎么处理

PDF 更像已经绘制好的页面，可能只有字形、坐标、图片和路径，没有完整的段落和阅读顺序。包内代码同时有原生内容解释与视觉处理两类能力。

下面是跨模块证据支持的阶段图，不是已验证的完整顶层执行轨迹：

```text
PDF / 选定页面
 -> 读取内容流、字体和字形、坐标、图片、图形、Form XObject
 -> PDFium 渲染页面 + ONNX 布局检测
 -> 布局区域与原生显示对象匹配
 -> 必要时 OCR 补足缺失文字
 -> 阅读顺序、段落和公式分组，表格专门处理
 -> 构造文字 / 受限 HTML / 样式 / 不可变 atom
 -> LLM 翻译 + 标记和样式校验
 -> 字体塑形、断行、字号与空间约束，碰撞检查
 -> 局部修改原 PDF 内容流，保留/重放不可变对象
 -> 输出校验；可选 DOCX 路径有图片提取及裁剪
```

### 1. 原生内容与 OCR 不是同一件事

结构字段包括 `Glyph` 的 Unicode、原始编码、来源操作范围、基线、字体、字号、颜色、透明度、裁剪和字形边界；还有 `ImageItem`、`GraphicItem`、`FormItem`。这是深入解释页面内容的证据，不只是调用 OCR 返回纯文本。

`page_needs_auto_ocr @ 0x100bd69f0` 直接调用 `missing_text_region_indices @ 0x100bd7550`，并比较视觉区域/原生对象覆盖相关的面积。可以确认自动 OCR 与页面缺失文字区域相关，不能将它简化成固定“字符少于 N 个就 OCR”；阈值和退化情形没有完整恢复。

OCR 的检测与识别由 `OarOcrEngine` 包装；符号表包含 `oar_ocr`、DB 检测、CRNN/CTC 解码等实现。没有证据表明该模型能把复杂公式可靠识别成可编辑 LaTeX。

### 2. 公式通过不可变对象隔离，而非交给翻译模型改写

PDF 翻译单元含 `styles`、`atoms`、`links`、`source_html` 和邻段上下文。atom 类型包括 `Formula`、`Code`、`Image`、`Graphic`；公式分组含原字形范围、叠加图形和边界证据。

二进制提示词明确要求：

> “Every {{KEEP_N}} marker is immutable layout data: copy each marker exactly once, in the original order … ATOM_HINTS explains what each opaque marker displays … never copy hints into the output or alter marker order.”

还要求保持每个 HTML 标签、`data-style` 属性及样式 span 的数量和顺序；不能因样式相同合并相邻 span。代码存在对应 HTML 及标记校验函数，本轮定向分析了 `validate_translation_html_with @ 0x100cf0780`。

这条设计让模型翻译“公式周围的文字”，程序自己管理公式的原始显示。行内公式可作为不可分割排版 atom 随译文布局；因此保留原外观不意味着绝对坐标一毫米不动。

### 3. 排版不是仅凭提示词维持

符号与配置支持：

- `typesetting::linebreak::break_lines_with_first_width`；
- `fit::typeset_with_constraint`、`layout_at_scale` 和 greedy 路径；
- 多字体 fallback、字形塑形、CID 字体嵌入；
- 最小字号、最小缩放、行高、CJK 字距、首行缩进；
- 区域加宽、页内/跨页文本流、阅读顺序 `XyCutPlusPlusReadingOrder`；
- 保留图形与译文的边界、相交和碰撞检查。

支持“自有约束排版算法”这一宏观结论，但尚未反编译断行器验证是否确为 Knuth–Plass，也不能仅凭网站“实现了 LaTeX 排版算法”的表述认定等同 TeX。

本轮反编译 `patch_content_stream_operations_with_index @ 0x1006d58a0`；结合原操作来源字段、内容流补丁与对象资源检查，支持“局部替换内容流”的实现。存在 `preserve_failed_translation` 和 `on-page-error=fail/keep-original`，但未确认所有失败是否都能回退，以及默认策略。

### 4. 表格、图表和截图

| 内容 | 当前证据支持的方式 | 不能保证的部分 |
| --- | --- | --- |
| 原生公式 | 原字形/图形分组为不可变 atom，保留或重放 | 不保证任意复杂公式都分组正确，亦非自动恢复可编辑公式源码 |
| 图表、图片 | 原图像/绘图对象可保留；文字区域和图注另行处理 | 不保证图内所有标签会翻译，或所有科技图形无损 |
| 表格 | `translate-tables` 配置；`enable_table_translation` 调用 `detect_region_table`；有 cell context 和 unsupported sibling 保留模块 | 未核实默认开关、合并单元格、无框线或扫描表格完整支持 |
| DOCX 中公式/复杂图形 | `docx::assets` 有 `replay_atom`、`isolated_atom`、`single_page_template`、`extract_image`、`crop`、`png`；有浮动公式图像统计字段 | 支持局部图像化能力的推断，但完整调用路线未恢复；不能保证输出 Word 原生可编辑公式 |
| 扫描页面 | OCR 和背景处理资源、配置与代码存在 | 未证明每张扫描 PDF 都采用图像修补或保留原像素 |

`docx_replay_atom @ 0x10063a850` 可见创建单页模板、构建 text paint 和 PDF stream，对 atom 做隔离重放；与 PNG/crop 模块共同支持“公式/图形可以转局部图像”的设计判断。该函数有未恢复跳转表，不能声称已经观察了最终截图结果。

用户提出的“复杂图表/表格截图保留”是合理保真策略，但应区分原产品已有路径与我们自己设计的保守 fallback。截图保留外观的代价是失去可编辑性、文字检索和缩放清晰度；若能重放矢量对象，通常优先保留矢量。

### 5. 校验比“保留排版”宣传更有实质意义

`validate_page_render_diff @ 0x100a5d5b0` 比较输入 RGB 图像，排除指定矩形内像素，统计其他像素的颜色差异并与阈值比较。这支持“允许译文区域变化、检查其他区域是否意外变化”的视觉保真检查设计。

字段及诊断还有 `PreservedGlyphChanged`、内容流不一致、字体映射缺失、预期文本不符、裁剪不包含译文、译文碰撞原始保留内容、table transaction 等。函数存在不是每次输出都会启用所有校验的证明；未恢复顶层启用策略和实际容差。

## 什么能不变，什么很难不变

| 保真层级 | 可行性 |
| --- | --- |
| 公式/数字/引用等内容不被模型修改 | 占位符和结构验证可以强约束；仍依赖识别与映射正确 |
| 原图像、表格线和矢量图形保留 | 原生对象保留比截图更有利；复杂 PDF 仍有透明度、裁剪及叠加风险 |
| 字体风格、颜色、章节和双栏结构近似保留 | 有专门样式与排版代码，原字体不支持目标语言时需替换 |
| 每个字位置、断行和分页完全相同 | 翻译长度改变，通常不能同时保证自然译文、原字号与原边界 |
| 扫描件背景像素级无损 | OCR 与修补属于识别/估计过程，不能普遍保证 |
| 导出 Word 后所有公式表格可编辑 | 图像 fallback 保外观但不可编辑；需分别测试 |

对于科技文档，优先级应当是：公式/数字不变、图表数据不变、阅读顺序正确、术语一致，然后才是尽量保持版面。把模型误读的公式排得很漂亮，仍然是错误结果。

## 官方描述与静态事实

公开页面描述“公式保持原样显示”“自动使用 OCR 识别扫描类文档”“字体风格、颜色等都保留”“可生成 Word，便于二次编辑”。关于页的“完美保留布局、公式、图表及引用”明确处于 arXiv/LaTeX 源码翻译语境。

这些是官方宣传，不是本轮运行验证；不能据此承诺任意 PDF 都无损。参考：

- https://app.hjfy.top/
- https://hjfy.top/about
- https://hjfy.top/
- https://zhuanlan.zhihu.com/p/1905569596599169419

## 证据与完成度

配套 `HJFY-0.1.5-PDF-architecture-evidence.json` 保存六个模型的实际哈希、protobuf 元数据、相关原始符号与地址、关键字符串偏移、八个函数伪代码与直接调用映射，以及完整运行/字体清单。是本地调查证据，不是 REA MCP Evidence ID。

| 调查问题 | 状态 |
| --- | --- |
| ONNX 是否是翻译模型、为何打包 | 已回答：布局/OCR/图像修补；本地视觉推理与 LLM 翻译分工 |
| 布局模型识别哪些内容 | 已回答：模型内嵌 25 类标签；准确性未验证 |
| 程序宏观处理 LaTeX 与 PDF 的区别 | 已回答阶段和模块；完整运行调用轨迹未恢复 |
| PDF 是否仅整页截图重画 | 证据反对该单一路径：存在原生内容流解释和局部补丁 |
| 扫描 PDF 是否全部走 AOT | 部分回答：能力和配置存在，完整路由未验证 |
| 表格、公式与 DOCX 截图策略 | 部分回答：模块/关键调用支持，复杂样例和默认策略未知 |
| 排版与视觉保真效果 | 未运行验证；静态证据不能代替样例输出 |

Ghidra 在 Windows 直接导入 Mach-O，`-noanalysis` 后对八个函数定向反汇编/反编译，进程成功退出。仍有符号标注不完整、Rust 类型传播、跳转表和外部 macOS 库未加载的限制。模型只解析元数据，不执行推理；程序不执行，不上传文档，不调用付费或翻译接口，不修改原 DMG 或此前报告。

## 建议的验证样例

后续有 Mac 运行条件时，使用自制文档和本地 mock LLM，分别验证：

1. 原生双栏 PDF：正文、行内公式、独立公式与图注的阅读顺序。
2. 表格：有框/无框、合并单元格、含公式与数字，分别开关翻译。
3. 扫描件：白底、有色底、细线图表，检验 OCR 和背景修补的误损。
4. 译文膨胀：两倍文本长度，检验缩字号、加宽、碰撞和失败保留。
5. PDF/DOCX 对照：公式是原生字形、矢量还是图片，表格是否可编辑。
6. 非翻译区域渲染差分、公式/数字一致性、链接及复制文本检查。

这些测试才能把“包里存在功能”提升为“真实文档上行为和质量已验证”。

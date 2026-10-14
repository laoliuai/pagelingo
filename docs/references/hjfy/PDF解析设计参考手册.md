# PDF 解析设计参考手册

更新：2026-10-11。对象：HJFY 0.1.5 macOS x86-64 的 PDFRuntime。

## 1. 目标与结论边界

这份手册服务于你已有的 **PDF → 自定义中间格式 → HTML**，不是复刻 HJFY 的 GUI、PDF 写回、Word 输出或翻译效果。文中：

- **观察**：原二进制明确分支、调用、字段字符串或 ONNX 元数据。
- **推断**：结合上述证据解释结构；仍可能受 Rust 类型恢复不完整影响。
- **建议**：我们独立设计的解析器方案，不宣称是原源码。
- **未知**：尚未恢复、未运行验证或证据不足。

目标 executable SHA-256：
`0edf170b92e65931dc9878846904cf628c18326a7290e0b4bffaf238afcca50a`。

深度证据保存了 94 条分析记录、93 个唯一地址，其中包含辅助函数和一次重复地址重试，**不等于恢复了 93 个完整算法**。三条失败记录涉及两个地址：总段落构造两次超时；翻译单元总构造失败。其余伪代码也不是原 Rust 源码，有类型猜测、尾部混入邻函数、跳转表及外部库缺失等限制。没有运行 HJFY、ONNX 或翻译 API。

核心借鉴点是：**原生对象提供内容和来源，视觉模型提供区域提示，规则恢复结构，所有权与失败保留约束修改范围。**

## 2. 实现地图

以下是证据支持的处理关系，不是一次运行的完整调用轨迹：

```text
PDF 对象 / 内容流                     PDFium 页面渲染
        |                                   |
原生 glyph、text run、image、graphic       ONNX layout
        |                                   |
        +-------- 统一坐标 / 区域匹配 --------+
                            |
                缺失文字区域 → 局部 OCR
                            |
          行 / 段落 / 阅读顺序 / 公式 / 表格
                            |
            文本 + 样式 + 不可变 atom / 来源
                            |
       翻译交换片段与验证       保留原对象 / 失败原因
                            |
      HJFY：排版与 PDF 补丁；你的目标：IR 与 HTML
```

不应把模型框直接当最终段落，也不应把整个 PDF 先 OCR 成字符串再补结构。

## 3. ONNX：各模型为什么存在

### 3.1 模型资源与接口

模型哈希和 protobuf 元数据见 `HJFY-0.1.5-PDF-architecture-evidence.json`。

| 资源 | 观察到的作用与接口 |
| --- | --- |
| `pp_doc_layoutv3.onnx` | 文档区域分类。float32 `image [N,3,800,800]`、`im_shape [N,2]`、`scale_factor [N,2]`；输出 float32 `[N,7]`、int32 `[N]`、int32 `[N,200,200]` |
| `pp-ocrv6_small_det.onnx` / `tiny_det` | 文字检测。输入 `[N,3,H,W]`，输出 `[N,1,H',W']` |
| `pp-ocrv6_small_rec.onnx` / `tiny_rec` | 文字识别，输入高度 48；输出分类维度分别 18710 / 6906，不等于已核实的字符数或词典行数 |
| `aot-manga-fp32.onnx` | 背景修补。image `[1,3,512,512]`、mask `[1,1,512,512]` |

这些是视觉模型，不是翻译 LLM。安装包采用 ONNX Runtime 1.23.2；翻译另走外部可配置模型接口。

布局模型内嵌 25 类：

```text
abstract algorithm aside_text chart content display_formula
doc_title figure_title footer footer_image footnote formula_number
header header_image image inline_formula number paragraph_title
reference reference_content seal table text vertical_text vision_footnote
```

标签存在不证明每类识别准确，也不证明扫描表格结构、公式语义或跨页关系能由该模型解决。

### 3.2 布局前处理与后处理

**观察，`layout_detect_timed @ 0x10190e490`：**

- 零尺寸输入拒绝。
- 整幅图直接缩放到 800×800，**不是等比例 letterbox**。
- RGB8 输入写入 BGR 通道，除以 255；未见此路径的 mean/std 归一化。
- `im_shape=[800,800]`；`scale_factor=[800/H,800/W]`。
- 读取前两个输出，未恢复使用第三输出的证据。
- 每行按 `[class,score,x1,y1,x2,y2,extra]` 解读；合法类别小于 25，score 严格大于调用传入阈值。默认 score 阈值未核实。
- 模型第二输出元数据为 int32，代码提取符号似 i64；这是未运行消除的接口疑点，不能照抄后假设可用。

**观察，`layout_postprocess @ 0x10190d870`：**

- 第一阶段用 IoU，面积计算包含端点 `+1`；不同类别条件采用不同阈值，常量为 0.98 / 0.6。
- 坐标裁剪到图像范围，删除非正宽高及后续宽或高小于 6 的框。
- 后续阶段使用 `intersection / min(areaA, areaB)`，**不是 IoU**，不加 1。
- `inline_formula`、`image` 有特殊例外；排序优先级和全部闭包未恢复。

**建议：**模型 adapter 应独立保存预处理版本、通道、缩放矩阵、输出 dtype、阈值和标签映射，并用小样本实测。不要把这里的参数当作任意模型的通用参数。

## 4. 坐标与对象来源

### 4.1 一份明确的页面空间合同

**观察：**`layout_transform @ 0x10051ed30`、`layout_rect_to_pdf @ 0x100531bd0`、`pdf_rect_to_layout @ 0x100531e20`、`VisualPageSpace::new @ 0x10051f740`、`pdf_rect_to_visual @ 0x10051ef00` 说明 PDF、视觉/布局坐标之间有专用变换。

**建议：**IR 固定一个视觉空间，例如 CropBox 左上为原点、向右/下为正、单位为规范化 PDF 点；同时保存 PDF user space、渲染像素和模型输入空间的可逆变换。处理 CropBox 非零起点、页面旋转和 UserUnit；局部 TextMatrix / CTM 不再重复应用页面旋转。

矩形需变换四个角后取包围框；斜排、旋转文字应保留方向与 quad，不能只剩轴对齐框。有限性、可逆性、退化框和 epsilon 必须按空间定义。**这些合同是建议，不是已完整恢复的 HJFY 矩阵代码。**

### 4.2 原生内容不是一个字符串

`interpreter_apply @ 0x1005283b0`、`emit_text @ 0x10052c770`、`safe_local_scope @ 0x100535610`、`extended_graphics_state @ 0x1005255e0` 与来源字段支持原生内容流解释的路线；apply 存在 constructor pcode 警告，未恢复完整解释器。

**建议：**每个 glyph 保存原 code、Unicode 映射状态、字形范围、字体、位置、基线、样式和 operation 来源。没有 ToUnicode 时不能伪造可检索文字。保留 ligature 多码点、combining mark、variation selector、非 BMP 字符；Unicode 与原 glyph 不是一对一。

对象来源至少区分 page、stream、operation、Form invocation 和 glyph range。同一个 Form 被调用两次，不能因对象 ID 相同去重成一次。资源字典作用域、`q/Q`、裁剪、透明度及软蒙版需保留或明确降级。

## 5. 模型框如何归属原生对象

**观察，真正的匹配闭包 `assignment_fold @ 0x10085dcb0`：**

1. 把每个显示对象框转换到 layout 空间。
2. 对每个候选区域计算交集；正面积时使用两种覆盖比例。
3. 分数主体为：

```text
score = 0.55 * intersection / objectArea
      + 0.25 * intersection / regionArea
      + 0.15 * centerInsideRegion
      + labelBias
```

类别偏置默认 0.05；bitset `0x106208` 命中的部分类别为 0；类别数值 `0x15` 为 0.0125。数值来自原二进制常量。分类条件限定范围，不应随意外推。

只接受达到调用方阈值的候选，再选最优；同分还按类别优先级、区域字段和 ID 决胜。完整类别语义和所有比较方向未逐项恢复。没有合格区域时保留未分配结果；记录包括 item index、layout bbox、region、label、assignment score、translate 标记。

**建议：**

- 保存候选和最终匹配原因，允许区域未分配，不用最高分强行归属。
- 原生 run 跨两栏、跨公式边界时可按 glyph 范围拆分，但不复制同一来源 glyph。
- 模型检测置信度与对象归属分数是两件事。
- 表、公式、正文之间通过来源所有权排他，不能只做 bbox 去重。

## 6. 自动 OCR 与扫描混合页

### 6.1 已恢复的区域判据

**观察，`missing_text_predicate @ 0x100be35c0`：**

- 只处理 bitset `0x1c204d5` 的文字型标签：abstract、aside_text、content、doc_title、figure_title、footnote、paragraph_title、text、vertical_text、vision_footnote。
- 框两轴长度绝对值至少 8，才继续。
- 若已有同 region ID 的记录且状态字节为 `0xff`，不列为缺失；该记录完整类型和状态枚举名未恢复，不能直接称为“有一个字就不用 OCR”。
- 排除同 ID；其他区域若类别命中 bitset `0x20c02a`，且交集面积 / 候选面积严格大于 0.01，也拒绝该候选。类别完整语义未闭合。

`page_needs_auto_ocr @ 0x100bd69f0` 在候选为空时返回 false。原生文字交集覆盖使用面积求和，**不是几何并集**；一个覆盖判断常量为 float 0.6。最终可见面积变量严格比较 `A_missing < A_covered`，变量对应的业务语义仍不够可靠。不要把它改写为“缺失面积占比超过 60% 就 OCR”。

### 6.2 真正执行 OCR 的边界

**观察，`append_ocr @ 0x100d02ea0` / `observe_regions @ 0x100bd48b0`：**

- auto 路径校验坐标、90°整数倍旋转，并使用自动判据。
- 另一 mode 可跳过 auto 判据，但仍使用候选区域；**force 不是无条件整页 OCR**。
- DOCX 文字候选可补充，排序、去重；无候选不初始化 OCR。
- 有候选才检查模型和字典、创建引擎。
- crop 按 floor/ceil 扩 6 个渲染像素后裁剪；高度小于 96 的 crop 放大。
- 与保护区域相交存在拒绝诊断。行转换、CTC 解码、置信度及完整合并策略未恢复。

**建议：**按区域分析 native completeness、Unicode 质量和扫描证据；补 OCR 时保留 native / OCR 双来源与冲突诊断，优先有效原生文字，防止隐藏 OCR 层重复。状态每页独立。模型缺失或失败时输出“未识别区域”与原图，不能把扫描页视为空页。

## 7. 阅读顺序、行与段落

### 7.1 递归 XY 切分

**观察，`recursive_xy_order @ 0x100bde1c0`：**

- 按 x0 排序，找相邻框 `next.x0 - previous.x1` 最大正间隙。
- 横向 gap 至少 `0.05 * max(上中位框宽,1)` 时递归左右，先输出左组。
- 否则按 y0 排序，存在正间隙即可上下递归；没有同样的比例阈值。
- 同 gap 时取后出现的切点；无纵向正间隙时输出 y0 排序结果。
- **只比较相邻框，不维护前面全部框的最大右边界。** 宽框跨栏覆盖时可能制造假空隙。

`reading_order_resolve @ 0x100be1b00` 按区域顺序收集段落，再分别排序串接；完整区域过滤和区内比较器未恢复。

**建议：**跨栏标题先剥离成 spanning block；切割必须验证投影上的真正空白，而不是仅相邻 bbox。保留阅读顺序图和置信度；侧栏、图注、脚注作为独立流。对 RTL、竖排采用方向策略，不照搬左组先输出。

### 7.2 行、空格和异常密度

**观察：**

- `build_lines @ 0x100c29af0` 的容差为 `0.55 * max(median(abs(itemHeight)),1)`。
- 新项从最新建立的行向前查找，加入首个纵向位置与行均值距离合格者，**不是选择最近行**。普通项使用中心；另一字段推测是基线。
- `rebuild_source_line_text @ 0x100c317a0` 只遍历 `min(索引数,空格标记数)`；非零标记在项前补 ASCII 空格，甚至早于索引有效性检查。
- `make_paragraph @ 0x100c2a510` 对每行裁剪 Unicode 首尾空白，以一个 ASCII 空格连接；这里未见去连字符。
- 水平不可能密度 `0x100c6cd60` 要求 Unicode 字母数 `A>=16`、补空格次数至少 2、高非零，且 `abs(width)<=abs(height)*A*0.12`。数字不计入 A。

总段落构造 `0x100c4bed0` 两次超时，真实分段条件没有完整恢复。不能用 0.55 行容差代替分段阈值。

**建议：**IR 分开 visual line、logical paragraph、显式空格和推断空格；先验证来源再补空格。保存去连字符决策，不能因行末 `-` 自动删除数学减号、范围或专名中的连字符。

### 7.3 跨栏、跨页与语言

**观察：**

- 页内候选按区域中心分组，距离达到页面宽度 0.15 倍时另起组；恰好两组才进入该分支。候选类别限定数值 `0x16`，端点选择依 y0/y1；坐标方向未擅自解释。
- 跨页只看相邻页末段/首段，空页不跳过。
- `english_continuation @ 0x100be0d50`：前段忽略末尾括号/引号后，若末字符是 ASCII `! . ?` 则拒绝；后段第一个字母/数字是小写则接受，否则前段以 `-` 结尾可接受，再否则末个 ASCII 标点后有 1～5 词可接受。
- `connect_flow @ 0x100be1550` 登记双向邻居文本，不拼接。以裁剪后全文为键，相同文本可能复用并覆盖邻接。
- `is_flow_continuation` 的中文分支和语言枚举受 PIC/不可达块恢复影响，未可靠恢复。
- 阿拉伯文字方向恢复可反转 glyph run，再反转连续数字 token；不是完整 Unicode Bidi 实现证明。

**建议：**续段保存为 block ID 边，另做是否合并的策略。不要用全文当身份；不要把短片段规则作为中文/多语言通用规则。

## 8. 公式：保护成员，不猜完整数学源码

### 8.1 已恢复的判断组合

`discover_formula_groups @ 0x1006f1cc0` 与字体、字符、上下标、分数线、源上下文、atom 合并共同支持公式分组。不是“数学字体全部截图”，也没有证明恢复 LaTeX / MathML。

| 判断 | 观察的局部规则，s 为分支参考字号 |
| --- | --- |
| 基线邻居 `0x1006f1580` | same_context；字号差 ≤0.10s，基线差 ≤0.15s，gap/s 从 −0.15 起，上限按调用为 0.12/0.20/0.35/0.60 等 |
| 普通脚标 `0x1006ee1a0` | 字号比 0.55～0.85，gap/s −0.10～0.35，基线位移/s 为 −0.50～−0.10 或 0.20～0.90；另有文本/源序约束 |
| 同字号脚标 | 字号比 0.95～1.05，位移比 −0.50～−0.20 或 0.20～0.50，gap比 −0.10～0.15；额外公式证据，不能用来放宽普通规则 |
| 直立脚标 `0x1006faea0` | 最多8字符，ASCII字母数字及指定正负号/横线；字号比0.55～0.85，位移比−0.55～−0.10或0.20～0.95，右向gap≤0.35s |
| 相邻 atom `0x100ceca30` | 普通路径方向余弦≥0.95，重叠/正gap≤1.5s，基线差通常≤1.5s，特定包容分支≤4s；中间仅Unicode空白 |
| 跨源行 atom `0x100cfaca0` | 联合框宽≤段落宽1.05倍，高≤4×max(中位字号,1)，防合并扩大 |
| 局部分数线 `0x100a5dfd0` | 可信入口厚≤1，宽≥4×厚，包含容差0.01；未污染数学字体路径要求线上下都有相交字形 |

分数线强字符分支存在邻函数污染，不能断言所有路径必定要求上下两侧，也不能宣称任意横线旁数学字符即接受。

### 8.2 误判防护与 IR

- `same_context @ 0x1006ee6d0` 不仅检查框，还核对有效项、上下文 ID、否决条件和跨 run 一致性。
- 特殊跨上下文例外 `0x1006fb710` 要求限定标签、可见文字、有限坐标、正字号、近水平方向及 glyph 来源一致；字段未完整恢复，不建议仿制宽松例外。
- 字体路径 `0x100a5dca0` 去六位大写子集前缀，清理、转小写，再做51项子串匹配，包括 math、symbol、cmmi、cmsy、cmex、stix、xits。字体命中只是证据。
- 强数学字符 `0x100a5e3d0` 包括希腊、箭头、数学运算和数学字母；普通数字、ASCII字母、ASCII `-` 不在该函数强证据集合中。希腊正文仍可能误判。
- 连续4个非特定东亚集合的字母可触发自然语言判断；数字也有邻接、长度与上下文约束。

**建议：**FormulaAtom 保存 anchor、line anchor、`item_index + glyph_range` 成员、overlay 图形、标签和检测证据。强证据建种子，再扩展操作数和括号；不要吞掉整个 TextRun。编号独立保存关联。不能可靠恢复时保持原矢量或 crop 图像，并保留可用文本作为辅助检索；截图不等于可编辑公式。

## 9. 表格：先验收，再替换

### 9.1 规则线和文本网格

**观察，`detect_region_table @ 0x100c1dc80`：**

- 文本候选少于4项：`insufficient_text_items`。
- 优先连通竖线推列，再尝试横线端点，最后文本对齐。
- 竖线主分支至少3个位置；最终3～17个列边界，即2～16列。无充分竖网格的 `text_only_table` 至少3列。
- 行优先合格横线，再锚列；至少3个行边界，即2行。
- 不确定时返回 `ambiguous_columns / ambiguous_rows / unsupported_column_count`，而非强造表格。

| 局部规则 | 已核实阈值，采用对应几何坐标单位 |
| --- | --- |
| 竖线 | 长≥4；横偏≤max(1.5,0.025×长) |
| 连通竖线 | x与组首差≤1.5；y间隙≤2；取最长连通段，不累计所有断线 |
| 连通长度 | 主入口≥区域文字高0.45倍；竖网格验证≥0.5倍；列边界匹配容差2 |
| 横线 | 长≥max(8,0.08×区域宽)；竖偏≤max(1.5,0.025×长)；与横向扩±12区域相交 |
| 同高横线组 | y差≤1；保留原线段。同高不证明中间连续 |
| 文本列对齐 | min(3,max(0.75,0.65×M))，M为中位字号 |
| 锚列视觉行 | 聚类容差0.45M；相邻中心距离≤2.05M归同一行组 |

`rows_from_best_anchor_column @ 0x100c29130` 遍历列窗口，选有效候选中边界最多者，不是固定左列。同分规则未核实。视觉行代表中心不随新增项重算，存在输入顺序敏感性。

### 9.2 单格归属和明确限制

- 文本按 bbox 中心归单一行、列；非空文本水平覆盖不足90%时 `text_crosses_column`。
- 未恢复任意 rowspan/colspan 拓扑。跨行框中心归属不等于支持合并格。
- padding：横向 clamp(0.3M,1.5,4)，纵向 clamp(0.3M,0.75,2)；有效宽≤M或高≤0.7M时 `cell_too_small`。
- `build_cell_paragraph @ 0x100c25080` 保存来源索引、双坐标和补空格标记；间隙>0.18M且两端无空白才补空格。缺失文本 glyph 比例阈值2%，状态枚举名未完整恢复。
- `apply_table_cell_context @ 0x100c27890` 从同列第0行、同行第0列构造 `Column header:` / `Row header:`，是位置上下文，不是语义表头识别。
- `validate_operation_ownership @ 0x100c29360` 检查表外是否共享来源 glyph 身份，发现则 `table_operation_has_external_glyph`；身份不只是 bbox。
- 最终要求 meaningful text 全归属且存在可翻译格。成功后才替换旧表段落；失败保留同 table ID 关联组。

**建议：**先完整构造临时 Grid，再原子验收内容、来源和边界；不支持合并格时保留区域资产或普通块。不要部分删除原文后才发现失败。扫描表、复杂合并格、嵌套表、跨页表的完整支持和成功率仍未知。

## 10. 翻译片段与 HTML 的边界

**观察：**已有 `validate_translation_html_with @ 0x100cf0780` 和本轮 `parse_translation_html @ 0x100cd8250`，配套提示要求受限 HTML、`data-style`、span 数量顺序与 `{{KEEP_N}}`。

验证伪代码包含每个 atom 标记出现一次、未知标记检查和样式相关检查；严格标签/span顺序也是明确提示合同。**不据此宣称所有提示要求均由所有验证模式强制执行。**

总构造 `build_translation_unit_inner @ 0x100ce37a0` 未恢复。翻译交换 HTML 不是最终 HTML 导出功能证明。

**建议：**你的 IR 不依赖翻译器；自然语言、样式、链接和 atom 先结构化。可选翻译层生成 restricted fragment，对 KEEP 序列、style/span序列、链接/email字节、合法标签和转义做本地验证；失败不提交。最终 HTML renderer 使用可信 IR，不直接插入 LLM 返回 HTML。

## 11. AOT 背景修补：对你的目标不是默认步骤

**观察，`Restorer::prepare @ 0x10062bad0` 不只准备输入，主体包含推理路径：**

- mask255；特定标志框扩2像素；透明/纯色背景有快捷返回分支，不是总调用 AOT。
- 上下文 crop 缩至512边界，图像边缘延拓、mask补零；mask非零处RGB置零。
- AOT归一化 `p/127.5-1`，其他分支 `p/255`。
- CPU EP、intra1、inter1、parallel=false；缓存session。
- 检查模型指纹、输出shape、NaN/Inf；缩回并检查边界质量。
- LaMa有外部绝对普通文件配置路径，未发现内置LaMa资源。

这比前期“完整推理未恢复”的限制有了进展，但仍没有运行效果证据。背景修补可用于移除扫描原文再绘译文；**仅提取成HTML通常不需要修改原背景**，使用原图crop与独立文字即可。修补可能损伤细线和图表，不能保证像素无损。

## 12. 面向你的 IR 与实施顺序

以下均是独立建议：

```text
DocumentIR
  PageIR: pageGeometry, transforms, blocks, readingEdges, diagnostics
  SourceRef: stream, operation, formInvocation, glyphRange
  TextRun: glyphs, unicodeStatus, style, direction, nativeOrOcr
  Region: label, modelScore, bbox, assignmentCandidates
  Paragraph: visualLines, logicalText, inferredSpaces, flowId
  FormulaAtom / AssetAtom: anchor, members, overlays, fallback, evidence
  TableIR: rows, columns, cells, boundaryEvidence, transactionStatus
  Link: target, sourceRanges, internalDestination
```

字段需映射到你已有格式，不要求重做全部系统。

1. **先做来源和坐标。**加入稳定ID、变换、诊断和原文资产；明确Unicode缺失，不吞扫描页。
2. **再做原生文字结构。**视觉行、推断空格、阅读顺序图、跨页邻接，与逻辑段落分离。
3. **接布局与区域OCR。**模型adapter可替换，保留归属分数和双来源；先避免漏字/重复。
4. **强化公式保护。**强证据种子、glyph范围、overlay、编号；矢量优先，截图fallback。
5. **保守做表格。**来源验收、边界证据和事务提交；复杂结构降级而非误造。
6. **最后做HTML质量。**语义块、可选页面保真视图、链接、可检索辅助文本、HTML转义；翻译层独立。

不优先移植 PDF 内容流补丁、字体嵌入、译文拟合、背景修补或 Word 排版，它们服务于不同输出目标。

## 13. 验证和停止标准

配套 `PDF解析边界用例.json` 是40项独立设计验收规范，**不是已生成的真实PDF，也不是已运行测试**。每项标注输入构造和结果性质；合成显示列表用于算法单测，真实PDF用于内容流、字体、Form、裁剪和透明度集成测试。

优先计量：有意义原文覆盖率、来源重复率、阅读顺序错误、公式成员完整性、表格归属冲突、降级可见性。截图保留视觉并不提供文本正确率；模型准确率需要独立样本。

当前已达到“主要可借鉴结构与细节提炼”的静态研究阶段，不宣称完整PDF引擎还原。主要剩余未知：总分段算法、部分标签/状态/语言枚举、CTC与OCR完整合并、复杂PDF解释器路径、复杂表结构、默认启用开关、运行准确率与模型许可。没有你的源码，尚未做具体接口接入。

## 14. 证据索引

本地调查记录不是 REA MCP Evidence ID；地址为该 executable 的静态VA。

| 主题 | 主要地址 |
| --- | --- |
| 模型前后处理 | `0x10190e490`、`0x10190d870` |
| 坐标 / 对象归属 | `0x10051ed30`、`0x100531bd0`、`0x100531e20`、`0x10085dcb0` |
| OCR | `0x100bd69f0`、`0x100bd7550`、`0x100be35c0`、`0x100bd48b0`、`0x100d02ea0` |
| 阅读顺序 / 行 | `0x100bde1c0`、`0x100be1b00`、`0x100c29af0`、`0x100c317a0`、`0x100c2a510` |
| 续段 / 密度 | `0x100be0d50`、`0x100be1550`、`0x100c6cd60` |
| 公式 | `0x1006f1cc0`、`0x1006ee1a0`、`0x1006f1580`、`0x100a5dfd0`、`0x100ceca30` |
| 表格 | `0x100c1dc80`、`0x100c28ad0`、`0x100c29130`、`0x100c25080`、`0x100c29360` |
| 翻译保护 / 修补 | `0x100cf0780`、`0x100cd8250`、`0x10062bad0` |
| 未恢复总函数 | `0x100c4bed0`、`0x100ce37a0` |

证据文件：`HJFY-0.1.5-PDF-deep-evidence.json` 与 `HJFY-0.1.5-PDF-architecture-evidence.json`。详细交付入口见 `HJFY-PDF研究索引.md`。

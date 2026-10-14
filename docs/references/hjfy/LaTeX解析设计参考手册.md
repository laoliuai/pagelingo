# LaTeX 解析设计参考手册

## 阅读入口

目标：为自有 **LaTeX -> 中间格式 -> HTML** 提炼设计、核心流程和边界规则。不是重建 HJFY、获得原始 Rust/TS 源码或保证与原程序行为一致。

研究对象为 HJFY 0.1.5 包内 `OfficeRuntime/bin/hjfy-office`，SHA-256：
`8755a32a94c0da846050a34f263dfbde3b0148d66d23f166c723dfd54468e19e`。

本手册区分：

- **观察**：原二进制、静态表、明确比较分支和调用关系支持。
- **推断**：由跨函数数据关系得出，仍可能受反编译类型/控制流恢复影响。
- **建议**：我们独立解析器的设计，不能算作 HJFY 已实现。

配套资料：

| 文件 | 用途 |
| --- | --- |
| `HJFY-0.1.5-LaTeX-deep-evidence.json` | 本轮函数原符号、地址、伪代码、调用映射、常量与失败记录 |
| `HJFY-0.1.5-LaTeX-rules-evidence.json` | 上轮 261 项行内命令、58 项段落边界环境、91 项忽略环境 |
| `HJFY-0.1.5-static-evidence.json` | 占位符、恢复、验证及前期函数证据 |
| `LaTeX解析边界用例.json` | 独立编写的输入与验收性质，不是原程序 golden output |
| `HJFY-解析逻辑借鉴清单.md` | 前一轮简版及 PDF -> IR -> HTML 取舍 |

## 核心设计判断

HJFY 采用的是**受限语法扫描 + 动态上下文 + 翻译分段 + AST 保护 + 双阶段验证**，不是执行完整 TeX。

值得借鉴的是解析状态、宏与环境分类、参数角色和保守保留；不宜直接照搬的是翻译启发式、全局占位符、部分定界器及不完整的签名语义。

```text
工程文件/单文本
 -> 编码与文件筛选
 -> 收集定义、别名及环境信息，累积 LatexContext
 -> 去注释/词法保护
 -> 段落级半解析：可译文字与保留区域
 -> AST：宏参数、组、数学、环境、条件等结构
 -> 有条件展开零参数纯文本宏
 -> 不可变构造替换与恢复映射
 -> 翻译与有限修复
 -> 保护态验证 -> 恢复 -> 原文态验证
```

上述是阶段关系，不是完整运行轨迹。对 HTML 输出，必须在它的分段层之外增加**语义解释与渲染适配**。

## 1. 词法、源码和空白

### 观察

关键函数：`macro_name @ 0x1001dee20`、`find_pair @ 0x10023b940`、`verbatim_end @ 0x10023b5f0`、`remove_comments @ 0x1002d4800`。

- 原代码大量采用 UTF-8 字节位置，同时按 Unicode 字符前进；检查切片边界。
- 命令名扫描不是简单 `\w+`：有 ASCII 字母、`@` 的条件准入及额外字符处理。不能据此声称支持任意 catcode。
- `find_pair` 处理相同/不同定界符；存在反斜杠奇偶转义、嵌套计数与 verbatim 旁路。
- 注释过滤考虑 `%` 前连续反斜杠的奇偶性；并检查 URL 类参数及代码区。
- `in_url_argument @ 0x1002d45e0` 明确识别 `url`、`ref`、`href`、`burl`、`detokenize`；通过回扫未转义花括号和命令实现，并非通用宏参数角色系统。
- `remove_comments` 保护 `Verbatim`、`lstlisting` 的环境区域，以及 `verbatim_end` / `lstinline` 命令路径。
- 预处理存在 CR 到 LF 的替换；完整 CRLF 先后处理需要谨慎解释，不能仅据该步断言 CRLF 不会被当空行。
- 空白行正则是 `\n[ \t]+\n`；多段处理另使用 `\n\s*\n`，不只检测连续两个 LF。

### 建议

将源码保真和显示文本分开：

```text
SourceFile(bytes, encoding, originalNewlines)
  -> Token(kind, rawSpan, decodedText, lexicalState)
  -> CSTNode(rawSpan, children, diagnostics)
```

原始字节不变；规范化文本另建偏移映射。注释节点可从显示层隐藏，但不能在来源层消失。删注释后的字符拼接应符合自己的明确策略，例如 `word%...\nnext` 不应无意形成新单词。

词法状态至少分为普通、数学、控制词、代码定界、代码环境、LaTeX3、注释。`%` 是否注释必须由状态决定。不要全局替换 `\\n`、删除 `%.*` 或统一 collapse whitespace。

## 2. 参数解析与内置签名

### 观察

`MacroSignatures::insert @ 0x1001cfd60` 保存名字到签名字符串，不验证语法。`get @ 0x1001d6f90` 优先动态映射，再查内置分支。**未知命令**和**已知零参数命令**有不同返回。

原常量包括：

| 签名 | 命令例证 | 常量地址 |
| --- | --- | --- |
| `m` | text、input、end | `0x100e3c11a` |
| `o m` | sqrt、footnote、ce/ch/si | `0x100e3c258` |
| `o m o m` | SI | `0x100e3c260` |
| `o m m` | qty、rule、colorbox | `0x100e3c25b` |
| `s m` | ref、hspace、vspace | `0x100e3c26f` |
| `m m` | frac、setcounter、stackrel | `0x100e3c26c` |
| `m m m` | multicolumn、definecolor | `0x100e3c267` |
| `s o o m` | includegraphics、onlinecite | `0x100e3c272` |
| `s o m` | part、chapter、section | `0x100e3c279` |
| `s m o m o` | newtheorem | `0x100e3c27e` |
| `s m o o m m` | newenvironment、renewenvironment | `0x100e3c287` |
| `s +m o +o +m` | newcommand、renewcommand、providecommand | `0x100e3c292` |
| `s m m m` | resizebox | `0x100e3c29e` |
| `m o m` | scalebox | `0x100e3c2a5` |
| `m o o m` | savebox、raisebox | `0x100e3c2b1` |
| `o o o m m` | parbox | `0x100e3c2b8` |
| `d() o o m` | makebox | `0x100e3c2c6` |
| `o` | item、linebreak、pagebreak | `0x100e3c2d2` |
| `o m o` | usepackage、RequirePackage | `0x100e3c2d3` |

`parse_macro @ 0x1001df4c0` 中可见统计签名 `m` 的数量、统计 trim 后非空花括号参数，并参考签名尾部是否 `o` 控制停止；没有证实完整逐项执行 `s/+m/d()`。签名文本不是完整 xparse 支持证明。

配对失败多数返回 `-1`；`\\` 专用可选参数失败可保留命令并留下未闭合文本。未知命令不应被误认作零参数命令。

### 建议

独立实现真正的参数描述，而不是复制字符串计数：

```text
MacroSpec:
  name
  syntax: Star | OptionalGroup | RequiredTokenOrGroup | Delimited | RawUntil
  argumentRoles: Text | Identifier | URL | Path | Length | Options | Code
  semanticRole
  recoveryPolicy
```

必选参数允许单 token 或花括号组；空组也是已提供的合法参数。可选参数嵌套行为明确，不能简单找最近 `]`。名称保持大小写；仅对明确的兼容别名归一化。

## 3. 不规则命令不能统一消费

### 观察

| 分支 | 消费方式 | 错误边界 |
| --- | --- | --- |
| `let`、`soulregister` | `parse_command_args @ 0x1001e3230` 收集 2/1 个控制序列，其他字符只扫描；LF、`%`、EOF 可结束 | 可少于目标数量成功；命令名失败返回 `-1` |
| `hangafter`、`hangindent` | `parse_equal @ 0x1001defc0` 扫描原始值及 `=` | 不强制必须出现 `=` |
| `vskip/hskip/mskip/hrule` | `parse_line_value @ 0x1001e25b0` 保存到 LF、`%` 或 EOF | 不检查组闭合 |
| 特定 `def` 形式 | `parse_between_def @ 0x1001e2860` 分离组前原文与首个花括号内容 | 特定前置匹配，不是所有 def |
| `addplot` | `parse_addplot @ 0x1001e1390` 收集选项、组、原始词到 `;` | 组失败可返回部分消费结果 |
| `foreach` | `parse_foreach @ 0x1001e1c30` 获取第一组前原文、第一组和第二组内容 | 组缺失/不闭合返回 `-1` |
| 重音命令 | `parse_text_accent @ 0x1001e2c30` 消费字符、控制序列或组 | EOF、`$`、`%`、`}`、孤立反斜杠等失败 |
| 定界式 verbatim-like | `parse_verbatim_like @ 0x1001e3610` 有可选方括号及自选非字母定界符；`{` 对应 `}` | 具体入口命令需按分派确认，不概括为所有 verbatim |
| `begin{textblock...}` | `supports_parentheses_env @ 0x1001e40f0` 允许特定圆括号参数 | 不是任意环境都能接圆括号 |

重音命令名单：`"`、`'`、`.`、`=`、`H`、`^`、反引号、`b/c/d/r/t/u/v/~`。文本重音不宜一律当数学。

### 建议

对代码和绘图“消费正确、暂不解释”通常比错误执行更好。保存 `OpaqueNode(raw, reason, span)`，HTML 可显示原文、可信裁剪图或安全渲染结果。不要在 `addplot` 内把 data file path、坐标和选项当正文。

## 4. 自定义宏与别名

### 观察

关键函数：`collect_from_text @ 0x1001bf860`、`classify_definition @ 0x1001c3610`、`signature @ 0x1001c4540`。

- `def/gdef/edef/xdef` 进入定义收集；名字含 `@` 的该分支会跳过。参数数目参考参数文本和正文的 `#数字` 最大值。
- `newcommand/renewcommand/providecommand/newrobustcmd/DeclareRobustCommand/NewDocumentCommand` 共用收集分支；名字取首个花括号参数，正文取最后一个。
- 普通参数数目可取数值方括号参数，否则从正文推断；非数值方括号参数标记可选参数。这里没有证明保存/执行默认值。
- 普通自定义签名生成 `m ... m`，或首个 `o` 加剩余 `m`，以空格分隔。
- `let` / `LetLtxMacro` 登记别名、复制签名，目标受保护时保护别名。
- 环境定义能影响 ignored/table 等分类；不等于展开整个自定义环境。
- 整个正文等于一个 begin/end 标记时登记宏到环境标记映射。
- 正文能完整解析为一个宏时，登记其关联；还有 opaque/block 分类及引用转发签名。
- 仅**零参数、存在可译文本、全部节点通过 only_textual**的宏进入文本展开表。

`only_textual @ 0x1001baec0` 接受文本、部分递归组，以及明确的 `text/emph/textbf/textit/texttt/xspace/normalfont` 宏，仍递归检查其子节点。

`expand_nodes @ 0x1001bef60` 仅替换没有参数子节点的宏；排除 should_not_translate 和精确 `True/False`；去掉末尾 `\xspace`，处理邻接控制词的空格风险。替换结果成为文本，不重新 parse 或递归展开到不动点。

### 建议

对自有 HTML，首先实现**签名和语义别名**；参数化展开另外做有界、安全的模板替换。不能以支持 `edef` 名称就宣称实现定义时展开、catcode、分组作用域或条件定义。

维护定义 provenance、作用域和诊断。默认不执行文件 IO、shell、网络、任意 TeX 原语。未理解定义也要保留，避免每个未知宏都吞掉后续正文。

## 5. 环境、条件与异常恢复

### 观察

`environment_at @ 0x1001c4c50` 解析 begin/end 与自定义标记，计数可嵌套的同名环境；`cannot_nest @ 0x1001c4750` 用动态集合和内置名单限制计数。名单包含部分数学、代码和矩阵环境，不是通用 TeX 嵌套验证。

未找到结束环境时，返回包含余下文件到 EOF 的区域，结束标记为空；这是一种保留行为，不是成功编译证明。

`conditional_start @ 0x1001c77d0` 支持 if、ifx、ifcat、ifnum、ifdim、ifodd、ifeof、ifvoid、ifhbox、ifvbox、iftrue、ifcase、ifvmode、ifhmode、ifmmode、ifinner、iffalse 和动态集合；有 `\newif` 前文排除。

`conditional_at @ 0x1001c73b0` 计数条件嵌套到 fi；未闭合保留到 EOF。**没有证实求值或只选活动分支**，不应把 iftrue/iffalse 的名字当执行证据。

### 建议

恢复策略应统一：

1. 确保每轮消费至少一个 token，避免死循环。
2. 缺少闭合时创建 `ErrorNode` 或部分节点，保存原始 span。
3. 允许在下一顶层 section/item/明确环境结束等边界重新同步。
4. 记录被错误影响范围；避免坏公式把余下 20 页全部标为数学且不告知用户。
5. 未求值条件保存各分支，渲染采用保守展示或明确的配置解析，不假装执行完整 TeX。

## 6. 分段、标题、图注和复杂区域

### 观察

`parse_latex @ 0x1001e4a00` 综合环境、LaTeX3、宏、数学和段落边界，不是逐节点全文本抽取。三组静态表可被动态上下文补充。

- 章节类宏包含脚注、图注、边注，故这一分类不能直接变成 HTML heading。
- `push_section_macro @ 0x1001eb2d0` 保留命令及参数定界符；`title` 或动态类别有花括号与其他参数的区别处理。
- `push_caption_of @ 0x1001eb0f0` 保留图注类型参数，提取第二个花括号正文。
- 受限环境来自表格/图形名称比较，回退是名称包含 `table/tabular`，不是后缀匹配；`restatable` 明确排除。主循环存在进入内部扫描并提取图注的路径。
- 受限区域只提取 `caption`、`footnote`、`topcaption`、`tablecomments` 和特定 `captionof`；嵌套 `minipage/tcolorbox` 可递归解析，其他嵌套环境保留。表格单元格正文不在这条路径中自动翻译。
- `limited_environment` 伪代码失败，本轮保存汇编补证。`0x1001ec028` 起是跳转表数据，不能把线性反汇编的后半段当代码。
- `push_translate @ 0x1001ea420` 先 trim、排除尺寸式字符串、should_not_translate 和无可译文本；原输入字节长度不超过 8192 才进入翻译候选，8193 起走保留原文路径，没有在这里自动切块。前后空白作为保留段保存。
- 尺寸过滤原正则为 `^\[?[-0-9.]+\w{2,3}\]?$`，这只是启发式，不能保证完整 TeX 长度语法。
- should_not_translate 包含纯符号、纯宏、纯环境、大写串、URL、数值单位、配置方括号和文件路径类别。

### 建议

语义节点至少包含：

```text
Document / Preamble / Section / Paragraph / List / ListItem
InlineText / StyledText / Math / Citation / Reference / Link
Figure / Caption / Table / TableCell / Footnote / Code / Opaque / Error
```

独立保存 heading、caption、footnote、aside 的角色，不借用同一“section”枚举。宏参数原序、星号、可选短标题都要保存。

表格内部不要直接按 `&` 和 `\\` split。至少维护组、数学、嵌套环境、代码状态；处理 multicolumn、multirow、列规格和特殊行命令。复杂表格可保留为资源，但不能声称 HJFY 已提供完整可移植的语义表格解析器。

## 7. 数学、引用与不可变数据

### 观察

不可变替换基于 AST，可以整体替换节点或连续节点区间；保存原 AST 打印文本形成恢复映射。占位形式 `\cmd数字`，计数从零开始。

引用、缩略语和不透明宏整体保护；`protected_reference @ 0x1001c4120` 查询动态集合、citation 名单和固定 ref 名单。后者包括 ref、cref/Cref、vref、eqref、subref、pageref、autoref、nameref、footref。

`is_numeric_text_script @ 0x1002d0c60` 仅针对 textsubscript/textsuperscript、一个参数及特定纯文本内容，要求有数字，允许空白和 `+-−–—,;.()[]`。它不是完整科学单位识别器。

恢复检查未知标识和源映射遗漏；现有证据不能证明 LaTeX 占位符次数与顺序总是严格相等。PDF `{{KEEP_N}}` 的约束不能直接套到 LaTeX。

### 建议

IR 保存原数学源码、行内/独立、编号、label、源 span。引用键、链接目标和资源路径也是数据，显示文字另保存。

占位只是给外部文本处理接口的协议，不是 IR。标识用带文档命名空间的唯一 ID，避免原文已有 `\cmd0` 冲突；按节点策略检查次数、遗漏和合法顺序。恢复后的结构与 ID 关系重新验证。

数学渲染器支持范围之外保留原文/资源并给诊断；不要用“能显示图片”冒充恢复可编辑公式。

## 8. 修复和校验

### 观察

链路含字面换行修复、模型 LaTeX 修复、重复源宏修复、保护态验证、恢复、控制词分隔与原文态验证。

`repair_literal_newlines @ 0x1002892d0` 收集原源文宏名并检查字面 `\n`；不能全局替换，否则会破坏 `\newcommand`、`\nu` 等。

`separate_restored_control_words @ 0x10028bc70` 是恢复后控制词邻接修复入口；具体所有分隔方式仍未完整确认。

校验检查与源文对照，包括新增 Markdown/JSON、数学异常、占位残留、复合引用遗漏、尺寸损坏、异常长度和拒答等。复合引用检查至少防止某成员计数减少，不证明无新增或无重排。

安全切分寻找组外、美元数学外的句末/换行，按 UTF-8 字节中点附近选择。没有完整环境、代码及所有数学定界符状态，不适合作通用解析器切分器。

### 建议

解析器层做结构和来源完整性验证；翻译层再做外部结果验证；渲染层做 HTML 转义、URL 协议限制与资源权限。三者不可混为单个正则清理器。

每次修复记录 rule ID、前后 span 与理由；允许关闭修复并显示原始诊断。优先局部失败保留，避免不可追溯的“猜测正确结果”。

## 9. 工程、多文件与编码

### 观察

`find_main_tex @ 0x100254020` 优先检查 `00README.json` 的 `sources`，要求 usage=`toplevel`、filename 以小写 `.tex` 结尾、路径为文件。首个合适候选读取失败可直接报错。

回退使用根目录 read_dir 的 `.tex` 候选，不是递归主文件搜索。多候选有 documentclass/documentstyle 和引用关系筛选，完整排序优先级未恢复。

input/include 正则：

```regex
\\(?:input|include)\s*(?:\{([^}]+)\}|([^\s%]+))
```

这是文件发现线索，不是安全完整的 TeX 依赖解析。

`validate_latex_source @ 0x100255ba0` 只要发现一个普通 `.tex` 文件即可成功；不要把它描述为语法校验。

`project_read @ 0x1002560b0` 对 tex/ltx/inc 走 split_utf8_document，其余要求全文 UTF-8。未看到自动 GBK/Latin-1 转码证明。非 UTF-8 前导注释横幅存在独立修复能力，剩余内容须 UTF-8；不能推论任意混合编码能修复。

另一个 `read_utf8 @ 0x1002dae60` 入口也调用 split_utf8_document，返回可接受的文本段；没有直接调用横幅修复。`black_translation_filename @ 0x1002d9700` 至少精确过滤 `macros.tex`、`xstring.tex`、`symbols.tex`、`packages.tex`、`listofitems.tex` 及其他打包辅助名。这是翻译筛选，不应让自有解析器跳过其中的宏定义收集。

`.inc` 文件有路径集合门槛；绘图片段包含 nextgroupplot/addplot/filldraw/draw 且无 begin 时有过滤条件。遍历错误部分路径经 Result::ok 丢弃。

### 建议

显式项目清单优先；否则按 documentclass、依赖入度、用户选择推荐主文件，不随机取首个。

建立有向文件依赖图；解析 input/include、bibliography、graphics 分开记录。实现路径根隔离、符号链接策略、循环/重复检测、资源上限和文件种类权限。原程序上述安全行为仍未知，不应将 Path::join 当隔离证明。

编码采用 UTF-8/BOM 优先，其他显式声明或用户选择；失败定位字节，不 silently lossy decode 科学数据。

## 10. 面向中间格式的推荐架构

全部为独立设计建议：

```text
ProjectLoader
  -> LosslessLexer
  -> ConcreteSyntaxTree
  -> DefinitionRegistry / RestrictedExpander
  -> SemanticLowering
  -> DocumentIR
  -> HtmlRenderer
```

每层产出 diagnostics。CST 保留源码细节，IR 提供语义结构，不要求将每条 TeX 排版命令映射成 CSS。

公共字段建议：

```text
id, kind, children, sourceRef(fileId, byteStart, byteEnd),
rawSource, semanticRole, provenance, diagnostics, confidence
```

宏节点保存 name/star/arguments/specResolution；数学保存 rawLatex/displayMode/label；资源保存 assetRef/captionRef；unknown/unsupported 保留 fallback 而不是删除。

Web/PDF/LaTeX 可共享 IR，但来源信息分别是 DOM 路径、PDF 页/对象/字形范围、TeX 文件/span。不得强行用 PDF bbox 表示全部 TeX 节点。

## 11. 实施顺序

1. 无损词法、组/数学/代码状态、错误节点及来源映射。
2. 明确签名、标题、段落、列表、图注、脚注、链接和引用。
3. 宏定义/别名注册及有界纯文本展开。
4. 数学与图形的可靠渲染/保留资源。
5. 表格、跨文件依赖、编码与复杂环境。
6. 可选翻译和修复；先把解析/HTML 回归测试做好。

验收用配套边界语料的性质测试，不要求复刻原程序。每个 case 声明 supported/partial/opaque/error，不能只看页面“有内容”。

## 覆盖与停止标准

| 问题 | 本轮覆盖 |
| --- | --- |
| 整体解析层次及动态上下文 | 足以参考，阶段关系明确 |
| 内置签名和不规则参数消费 | 已恢复代表性规则；非完整 xparse |
| 自定义宏、别名、环境分类及展开范围 | 核心规则已恢复；TeX 执行语义未建立 |
| 注释、URL、verbatim、数学与条件 | 核心状态和典型边界已追踪；复杂 catcode 未恢复 |
| 分段、图注、标题及受限区域 | 主流程和规则已追踪，受限环境汇编补证 |
| 占位、引用保护、恢复与验证 | 核心链已建立；局部修复细节仍有未知 |
| 工程主文件、筛选、编码 | 关键策略明确，部分闭包/安全策略未知 |
| 完整 HTML/表格语义解析 | 原程序证据不足；已给独立实现方案 |
| 实际原程序行为或全部源码还原 | 未完成，也不是当前目标 |

本轮达到“主要可借鉴模块都有证据、规则、限制和实施建议”的停止标准。剩余内容多为完整 TeX 执行、反编译小分支或真实运行验证；继续扩大函数数量不一定能改善自有 HTML 解析器。

Ghidra 仅定向静态分析，未运行 HJFY、未调用翻译 API、未修改原程序。伪代码存在类型恢复和邻近函数污染；尤其已校正 conditional_at/start 的临时别名，以及把 Vec drop/push、UTF-8 辅助函数错猜成 parser 的别名。原符号才是函数身份依据。上述限制造成的未知在证据包保留，不以文档完整代替源码完整。

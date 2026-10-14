# HJFY 解析逻辑借鉴清单

## 目标与范围

目标是改善自有 PDF -> 中间格式 -> HTML，并新增 LaTeX -> 中间格式 -> HTML；不追求与 HJFY 输出一致，也不要求复刻其 PDF 写回、GUI、付费接口或编译工具链。

本轮继续静态追踪 LaTeX，新增 16 个选定函数分析结果，其中 `limited_environment` 反编译失败；其他函数存在 Rust 类型和函数边界恢复限制。保存的是近似伪代码，不是可直接运行的原始代码。

## 本轮实证

配套 `HJFY-0.1.5-LaTeX-rules-evidence.json` 包含二进制身份、原地址、原文件偏移、链式重定位指针、三组完整静态表和 16 个函数结果。静态表经过 Mach-O 地址映射及 `DYLD_CHAINED_PTR_64_OFFSET` 重定位格式确认；未执行目标程序。

| 规则 | 已确认内容 | 借鉴边界 |
| --- | --- | --- |
| 行内宏 | `inline_macro` 查询 261 项表，比较原名称及 ASCII 小写形式，并有星号处理代码 | 星号剥离与 Rust 字符串长度的伪代码恢复需谨慎；不是任意命令大小写都不敏感 |
| 段落边界环境 | `paragraph_end` 查询 58 项表，结合动态上下文判断 | 例如 figure、table、minipage、itemize、proof；不能仅以换行分段 |
| 忽略环境 | `ignored_environment` 查询 91 项表及动态上下文 | 数学、代码、绘图和参考文献等；不是“永远丢弃内容” |
| 章节类宏 | 包括 part、title、chapter、section、subsection、subsubsection、paragraph、caption、footnote、footnotetext、marginpar、marginnote、frametitle、icmltitle | 这是“独立提取文本”分类，不能都映射成 HTML heading |
| 图注 | `push_caption_of` 寻找前两个花括号参数；保留第一个类型参数和可选方括号参数，第二个花括号内容进入 `push_translate` | 表明参数必须按语义处理；短图注可选参数是否另译未证明 |
| 引用 | `is_citation_macro` 显式识别 cite/Cite、citep/citet、textcite、autocite、parencite、footcite、citeauthor、citeyear 等 | 引用 key 是标识符，不应按普通文本翻译 |
| 缩略语 | `is_acronym_use_macro` 显式识别 ac、acf、acs、acl、复数与部分首字母大写变体、acused、acreset | 不能把 acronym key 当显示文字；glossaries 另一命令族需继续追踪 |
| LaTeX3 区域 | `expl_syntax_end` 解析 `ExplSyntaxOn` 并扫描 `ExplSyntaxOff` | 可保守保留整段代码；缺失结束标记的返回语义仍需核实 |
| 空行分段 | `paragraph_end` 有双 LF 判断，同时调用数学、环境、宏和组相关检查 | CRLF、注释行与仅空白行的完整行为尚未恢复 |
| 安全切分 | `safe_split_boundary` 跟踪花括号深度、美元数学状态及反斜杠转义奇偶，收集组外/数学外的换行、`.`、`!`、`?`、`。`、`！`、`？`，选择靠近字节中点的候选 | 该函数本身未显示完整环境栈或所有数学定界符处理，不能当通用安全 TeX 切分器 |

这里的“已确认”是原文件及静态调用证据，不是运行验证。大函数伪代码可能包含邻近函数，局部规则优先以独立小函数和其表查询为依据。

## LaTeX 解析不能直接等于翻译分段

HJFY 的核心目的之一是保留 TeX 后重新编译。对自有 HTML 输出，还需要补上独立语义层：

```text
无损词法 / 源码区间
 -> 宏签名、组、环境、数学与不透明区域
 -> 段落 / 标题 / 列表 / 图注 / 表格 / 引用等语义节点
 -> 中间格式
 -> HTML 渲染
```

分段器回答“哪里能译”，语义解析器回答“这是什么”，渲染器回答“怎么显示”。例如忽略 `tikzpicture` 的翻译内容，仍应保存原源码，选择安全的外部渲染或资源兜底，而不是丢弃该节点。

### 自有实现建议，不是已还原的 HJFY 代码

1. 无损扫描器保留原文本、文件名及半开源码区间；声明偏移采用 UTF-8 字节还是语言字符串索引，避免混用。
2. 分开处理普通文本、注释、控制词、控制符、数学、verbatim 与 LaTeX3；不要用统一正则替换全部命令。
3. 宏注册表描述参数角色：文本、短标题、标识符、URL、路径、尺寸、选项、原始代码；支持必选/可选/星号。
4. 自定义宏先收集签名和定义，采用有深度/次数限制的安全展开；无法理解的宏保留原源码与诊断。
5. 列表按 item 建节点；图和图注建立关联；脚注单独节点，不混进正文阅读顺序。
6. 数学保留精确原源码，记录行内/独立、编号和 label；渲染失败保留原文或可信资源，不静默删除。
7. 表格先做有状态列/行扫描，避免在花括号、数学或嵌套环境中按 `&`/`\\` 误切；复杂结构标为部分支持。
8. 多文件解析设置项目根、路径允许范围、循环检测和 include 深度；禁用任意 shell、写文件及网络执行。
9. 未识别命令、未闭合组/数学/环境产生局部诊断与可恢复节点，限制错误范围，不让整篇消失。
10. 翻译层只改文字片段，校验占位符、引用 ID、数学与资源映射；保留原文供对照。

无需默认自动编译论文；如增加 TeX/TikZ 渲染，应独立沙箱、禁 shell escape、限制时间与资源。

## PDF -> 中间格式 -> HTML 的移植重点

下表的中间格式字段是我们建议的设计，不是 HJFY 原 schema。原程序证据见 `HJFY-0.1.5-PDF-architecture-evidence.json`。

| 优先级 | 原程序静态证据 | 对自有程序的建议 |
| --- | --- | --- |
| 高 | 布局分类；AssignedDisplayItem 有区域、对象索引和 assignment_score | 保留语义区域与原对象关联，不把模型标签直接当 HTML 标签 |
| 高 | ReadingOrder::resolve；Paragraph/SourceLine 含行成员、推断空格和方向 | 保存逻辑顺序、栏、段落关系；双栏不能只按全页 y 坐标排序 |
| 高 | Glyph 来源编码、操作范围、基线和边界；PageInterpreter | 节点保存来源页、对象、字形范围，用于定位、纠错和去重 |
| 高 | 自动 OCR 调用 missing_text_region_indices；置信度配置 | 原生文字优先、按区域补 OCR；保存来源类型与置信度，避免重复段落 |
| 高 | FormulaGroup、InlineAtom、公式成员及叠加图形 | 公式独立 atom，保持与上下文关系；图片/SVG 与候选 LaTeX 分开 |
| 高 | table detection、cell context、unsupported 保留模块 | 可靠时结构表格，不可靠时保留局部资源并给诊断，不强造单元格 |
| 高 | TranslationUnit 将文字、styles、atoms、links 分开 | 中间格式用类型化片段与引用，HTML 最后生成，保留资源及标识完整性 |
| 中 | 图形/图片 atom 与 DOCX 资源裁剪模块 | 保存图像/矢量、图注关联；复杂对象局部资源兜底，不用整页图代替结构 |

当前不优先复刻 PDF 内容流补丁、CID 字体嵌入、译文字号拟合和扫描背景修补，它们主要服务原页面写回。

## 边界测试清单

这些是建议测试，不是已在 HJFY 中验证的结果：

| 输入 | 自有解析器应验证的性质 |
| --- | --- |
| `\\%`、`\%`、真实 `%` 注释、CRLF | 根据词法状态区分转义与注释；统一且可追溯的换行处理 |
| `\section*[Short]{Long}` | 星号、可选和必选参数区分；标题角色正确 |
| `\captionof{table}[Short]{Long}` | 类型/短标题/正文分别保存；不把 table 翻译成自然语言 |
| `\citep[see][p. 3]{key1,key2}` | 注释文字和引用 key 分离 |
| `\newcommand{\foo}[2][default]{...}` | 签名/可选参数/嵌套组；展开有界 |
| `\verb|% $ { }|`、minted、lstlisting | 不按普通文本语法误解析代码内容 |
| `\ExplSyntaxOn ... \ExplSyntaxOff` | 代码区域保留；未闭合有明确诊断 |
| `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、align | 定界符、转义、编号与外部句子分离 |
| `\multicolumn`、`\multirow`、单元格公式 | 结构可用则解析，不可用则保留，不误切数学符号 |
| TikZ/PGFPlots 图及 caption | 图源码/资源与图注分离 |
| 循环 input/include、根目录外路径 | 不死循环、不越界读取；来源映射保留 |
| 双栏 PDF 混合 OCR、公式上下标、跨页段落 | 阅读顺序、去重、atom 归属和段落关系 |

## 下一轮追踪重点

1. 宏签名解析、`collect_from_text` 和 `classify_definition` 的具体分类与展开规则。
2. `limited_environment` 与复杂环境的局部提取；本轮该函数伪代码失败。
3. `group_at`、comment/verbatim/条件分支的状态与不闭合恢复。
4. PDF 的阅读顺序、公式分组、行合并和区域归属实际算法，而不是写回排版。
5. 自有中间格式的映射与回归测试；当前工作区没有用户程序源码，暂不猜测其 schema 或技术栈。

已经有足够规则指导独立设计，但尚未达到完整解析器还原。建议把经过证据确认的规则、独立实现建议及未确定行为分别维护，避免将反编译推测固化成产品规范。

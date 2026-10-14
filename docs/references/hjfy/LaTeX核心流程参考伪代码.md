# LaTeX 核心流程参考伪代码

这些是依据静态规则重新表述的流程，不是原始源码、完整 TeX 引擎或已执行验证的实现。`OBSERVED` 表示关键分支有静态证据；`DESIGN` 表示自有解析器建议。

## 宏定义分类

`collect_from_text`、`classify_definition`、`expand_nodes`：

```text
OBSERVED collect_definition(command, arguments, context):
    if command in {def, gdef, edef, xdef}:
        obtain name and body from parsed arguments
        derive parameter count from maximum "#digit"
        skip this branch when name contains "@"
    else if command in supported command-definition family:
        name = first braced argument
        body = last braced argument
        derive count from numeric option or body
        derive optional-first-parameter flag
    else if command is supported alias assignment:
        register alias, copy known signature and protection
        return
    else if command defines an environment:
        classify environment from body
        return
    else:
        return

    register signature(count, optionalFirst)
    classify body into environment-marker / macro-alias / opaque / block
    if count == 0 and has_translatable_text(body) and every_node_only_textual(body):
        register name -> body in text-expansion table
```

`only_textual` 的可接受宏集合包含 `text/emph/textbf/textit/texttt/xspace/normalfont`，递归检查其子节点。这里不执行 `edef`、默认参数或全部 catcode。

```text
OBSERVED expand_text_macro(node, context):
    if node is not a macro or has argument children:
        recurse only through supported child containers
        return
    body = context.textExpansion[node.name]
    if absent, should_not_translate(body), or body is exactly True/False:
        return
    trim trailing xspace and normalize selected line structure
    preserve control-word boundaries with necessary spacing
    replace node with Text(body)
    # replacement is not reparsed or repeatedly expanded
```

## 环境与条件

```text
OBSERVED scan_environment(opening, input, context):
    depth = 1
    while not EOF:
        bypass verbatim where this environment permits that handling
        parse possible begin/end or context-mapped environment marker
        if same-name opening and nesting allowed:
            depth += 1
        if matching closing:
            depth -= 1
            if depth == 0:
                return opening, body, closing, endPosition
        advance by a valid UTF-8 character when not handled
    return opening, remainingBody, emptyClosing, EOF
```

它不是任意环境栈的完整语法证明；comment 的特殊结束路径和 non-nestable 分类另有分支。

```text
OBSERVED scan_conditional(input, context):
    recognize built-in/custom if start, excluding newif declaration
    depth = 1
    count nested conditional starts
    decrement on fi; return on depth == 0
    at EOF return preserved remainder with no closing
    # no confirmed evaluation of active branch
```

## 受限环境

依据失败函数的原汇编及主循环内部扫描：

```text
OBSERVED is_limited_environment(name):
    remove trailing "*" characters
    if name == "restatable":
        return false
    if name in observed exact-name list:
        return true
    return contains(name, "table") or contains(name, "tabular")
```

精确名称：

```text
tabu, tblr, table, figure, picture, tabular, SCfigure,
tabularx, tabulary, longtabu, xtabular, talltblr, longtblr,
booktabs, longtabs, talltabs, subfigure, longtable, wraptable,
xltabular, wrapfigure, mpxtabular, deluxetable, supertabular,
sidewaystable
```

判断本身不做通用大小写归一化。分段主循环还允许上下文补充分类。

```text
OBSERVED segment_limited_body(body):
    preserve outer opening/closing
    scan body:
        nested minipage/tcolorbox -> recurse parse_latex
        other nested environment -> preserve
        caption/footnote/topcaption/tablecomments -> extract text arguments
        eligible captionof -> preserve type, extract second braced argument
        everything else -> preserve
```

所以这不是表格单元格解析算法；若自有 HTML 需要 `<table>`，应另建表格语义扫描器。

## 文本准入与占位

```text
OBSERVED segment_translation_candidate(raw):
    view = UnicodeTrim(raw)
    if dimensionPattern(view) or should_not_translate(view):
        preserve raw
    else if not has_translatable_text(view) or utf8ByteLength(raw) > 8192:
        preserve raw
    else:
        preserve prefix/suffix whitespace as separate pieces
        enqueue middle text under its policy
```

原尺寸正则不是完整单位解析，原翻译限制也不是通用 HTML parser 文本长度限制。

```text
OBSERVED protect_and_restore(nodes):
    serialize immutable nodes or contiguous immutable ranges
    assign cmd0/cmd1/... and keep restoration map
    generate protected text
    run translation and finite repairs
    validate protected result against protected source
    restore known identifiers; reject unknown/missing mappings
    repair restored control-word adjacency
    validate restored result against original source
```

不能将“遗漏检查”扩写为所有标识严格唯一和顺序完全一致。

## 自有 HTML 解析器强化版

```text
DESIGN parse_project(project):
    load allowed files, detect encoding, build source map
    lex losslessly with explicit code/math/comment states
    parse CST with recovery nodes and monotonic progress
    collect signatures/definitions/aliases with provenance
    resolve supported semantics without arbitrary TeX execution
    expand only approved constructs under depth/size limits
    lower CST to typed IR; preserve unsupported raw nodes/resources
    validate node IDs, spans, references and asset ownership
    render escaped HTML with safe links and resource access rules
```

```text
DESIGN recover_bad_construct(start, diagnostics):
    keep original span and mark incomplete
    choose bounded synchronization point at a known top-level token
    never delete remaining document silently
    return PartialNode and nextPosition > start
```

实现时优先将这些规则转成配套 `LaTeX解析边界用例.json` 的性质测试；其预期是自有设计验收，不是 HJFY 的运行输出。

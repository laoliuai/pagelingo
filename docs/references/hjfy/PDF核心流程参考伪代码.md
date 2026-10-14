# PDF 核心流程参考伪代码

更新：2026-10-11。配套：`PDF解析设计参考手册.md`。

这里是**独立实现参考，不是恢复的 Rust 源码，也不是可运行程序**。`observed_*` 表示从明确分支提炼的局部算法；`recommended_*` 是面向 PDF → IR → HTML 的建议。未知类型、默认参数和总段落算法不使用猜测补齐。

## 1. 独立解析主流程

```text
recommended_parse_document(pdf, adapters, policy):
    ir = DocumentIR()
    for page in pdf.pages:
        geometry = establish_page_geometry(page)
        # CropBox, UserUnit, page rotation, render/model transforms.
        if not finite_and_invertible(geometry):
            ir.add_preserved_page(page, diagnostic="invalid_geometry")
            continue

        display = adapters.native.extract(page, preserve_sources=true)
        # Keep glyph ranges, Form invocation identity, graphics and mapping errors.
        native = normalize_to_visual_space(display, geometry)
        raster = adapters.renderer.render(page, geometry)

        regions = adapters.layout.detect(raster) if adapters.layout else []
        assignments = recommended_assign(native, regions, policy)
        missing = recommended_find_missing_text(regions, native, assignments)
        ocr = recommended_region_ocr(missing, raster, geometry, adapters.ocr)
        text = merge_text_sources(native, ocr, preserve_conflicts=true)

        formulas = discover_formula_seeds_and_members(text, native.graphics)
        owners = SourceOwnershipRegistry(native)
        owners.claim(formulas, conflict_action="preserve_and_diagnose")

        tables = []
        for region in regions.where(label="table"):
            proposal = build_table_candidate(region, text, native.graphics)
            if recommended_validate_table(proposal, owners):
                owners.commit(proposal)
                tables.append(proposal)
            else:
                tables.append(preserve_table_region(region, proposal.reason))

        lines = build_visual_lines(text.excluding_owned_members)
        paragraphs = recommended_segment_paragraphs(lines, regions, policy)
        # HJFY's total paragraph builder was not recovered.
        blocks = combine(paragraphs, formulas, tables, native.assets)
        order = recommended_reading_graph(blocks, geometry, policy)
        ir.add_page(geometry, blocks, order, owners, diagnostics)

    add_optional_cross_page_edges(ir, using_block_ids=true)
    validate_source_coverage_and_no_duplicates(ir)
    return ir
```

模型缺失时仍可解析原生文字；扫描区域保持图像与未识别诊断。`merge_text_sources` 必须保留 OCR 的 bbox / 置信度 /来源，不能整页覆盖原生文本。

## 2. 已观察的 layout adapter

来源：`0x10190e490`、`0x10190d870`。

```text
observed_layout_preprocess(rgb_image):
    reject_if_zero_size(rgb_image)
    H, W = rgb_image.shape
    resized = resize_entire_image(rgb_image, width=800, height=800)
    image = to_NCHW(BGR(resized) / 255.0)
    return image, im_shape=[800, 800], scale_factor=[800/H, 800/W]

observed_layout_rows(output0, threshold):
    regions = []
    for row in output0:
        class_id, score, x1, y1, x2, y2, extra = row
        if valid_class(class_id, upper_exclusive=25) and score > threshold:
            regions.append(region(class_id, score, bbox, extra))
    return regions
```

输出 dtype 和第二输出 int32 /提取符号似i64的疑点需实测。第三输出用途未知。后处理不能简化为单次普通 NMS：

```text
observed_postprocess_outline(regions):
    first_suppression_uses_endpoint_inclusive_IoU()
    # Constants 0.98 / 0.6; category branch mapping is not fully restated here.
    clip_to_image_bounds()
    discard_nonpositive_extent()
    discard_width_or_height_below_6_in_later_stage()
    later_suppression_uses_intersection_over_smaller_area_without_plus_one()
    apply_special_inline_formula_and_image_rules()
    # Complete sorting / tie rules not recovered.
```

## 3. 区域匹配的已观察核心

来源：`assignment_fold @ 0x10085dcb0`。坐标必须先统一。

```text
observed_assignment_score(object_box, region_box, label):
    I = intersection_area(object_box, region_box)
    AO = positive_area(object_box)
    AR = positive_area(region_box)
    object_fraction = I / AO if AO > 0 else 0
    region_fraction = I / AR if AR > 0 else 0
    bias = 0.05
    if label < 0x16:
        if bitset_contains(0x106208, label):
            bias = 0
        else if label == 0x15:
            bias = 0.0125
    return 0.55*object_fraction + 0.25*region_fraction \
           + 0.15*center_inside(object_box, region_box) + bias

recommended_assign(objects, regions, policy):
    for object in objects:
        candidates = [(r, observed_assignment_score(object.bbox, r.bbox, r.label))
                      for r in regions]
        eligible = candidates.where(score >= policy.assignment_threshold)
        if empty(eligible):
            emit_unassigned(object)
        else:
            selected = choose_best_with_explicit_tie_policy(eligible)
            emit_assignment(object.source, selected, candidates)
```

独立建议的 tie policy 不等于恢复的 HJFY tie policy；原分支存在类别优先、字段/ID决胜。阈值来自调用方，默认值未知。

## 4. 缺失文字与 OCR 的边界

来源：`0x100be35c0`、`0x100bd69f0`、`0x100d02ea0`、`0x100bd48b0`。

```text
observed_missing_region_predicate(region, records, all_regions):
    if not bitset_contains(0x1c204d5, region.label):
        return false
    if abs(region.width) < 8 or abs(region.height) < 8:
        return false
    if records.any(region_id == region.id and status_byte == 0xff):
        return false
    # Exact record type / state meaning remains unknown.
    A = abs(region.width * region.height)
    if A > float32_epsilon:
        for other in all_regions:
            if other.id != region.id and other.label < 0x16 \
               and bitset_contains(0x20c02a, other.label):
                if intersection_area(region, other) / A > 0.01:
                    return false
    return true
```

不把此谓词等同完整自动 OCR：auto 还有坐标/旋转与面积条件；覆盖求和不是并集，最终面积变量语义未闭合。不能写成“missing > 60%”。

```text
recommended_region_ocr(regions, raster, geometry, ocr_adapter):
    if empty(regions):
        return []
    if ocr_adapter is missing:
        return preserved_unrecognized_regions(regions, "ocr_unavailable")
    result = []
    for region in regions:
        crop_rect = clip(expand(floor_ceil(region.render_bbox), 6), raster.bounds)
        if conflicts_with_protected_content(crop_rect):
            result.append(preserve(region, "protected_overlap"))
            continue
        crop = raster.crop(crop_rect)
        if crop.height < 96:
            crop, crop_scale = enlarge_to_height(crop, 96)
        recognized = ocr_adapter.recognize(crop)
        result += map_back_and_validate(recognized, crop_rect, crop_scale, geometry)
    return result
```

扩6/高96是观察值，冲突判定与adapter验证是独立建议。CTC和识别置信度规则未恢复。

## 5. 行与阅读顺序

来源：`0x100c29af0`、`0x100bde1c0`。

```text
observed_build_lines(sorted_items):
    T = 0.55 * max(median(abs(item.height)), 1)
    lines = []
    for item in sorted_items:
        position = branch_specific_vertical_position(item)
        target = first(line in reverse_creation_order(lines)
                       where abs(position - mean(line.positions)) <= T)
        if target exists:
            target.append(item)
        else:
            lines.append(Line(item))
    return lines
```

初始比较器、特殊位置字段和总分段算法未知。独立实现可改为最近合格行，但须标注为改进而非原算法。

```text
observed_recursive_xy(boxes):
    if size(boxes) <= 1: return boxes
    xs = sort_by_x0(boxes)
    gap, split = maximum_adjacent_gap(xs, tie="last")
    if gap > 0 and gap >= 0.05 * max(upper_median_width(xs), 1):
        return recurse(xs.before(split)) + recurse(xs.after(split))
    ys = sort_by_y0(boxes)
    gap, split = maximum_adjacent_gap(ys, tie="last")
    if gap > 0:
        return recurse(ys.before(split)) + recurse(ys.after(split))
    return ys
```

相邻间隙可被 spanning box 误导。推荐先处理跨栏块，再用全部框投影并集检验切线为空白；输出顺序图而非唯一不可解释字符串。

跨页续段建议存 block ID 邻接，保留连字符；不要复用 HJFY 以全文为键的邻居表。英语规则只是上下文启发式，不代替中文或 Unicode Bidi。

## 6. 公式成员与所有权

```text
recommended_formula_groups(items, graphics):
    seeds = detect_strong_formula_evidence(items, graphics)
    groups = []
    for seed in seeds:
        group = FormulaAtom(anchor=seed, members=[seed.source_range])
        for candidate in bounded_neighbors(seed):
            if same_source_context(seed, candidate) \
               and no_prose_or_owner_conflict(candidate) \
               and supported_attachment_evidence(seed, candidate):
                group.add(candidate.source_range, evidence)
        attach_local_rules_and_delimiters(group, graphics)
        if group_expands_beyond_paragraph_bounds(group):
            preserve_smaller_supported_group_and_diagnose()
        groups.append(group)
    return groups
```

具体局部字号、gap、位移与联合框阈值见手册第8节。字体匹配或纯数字不是独立强判据。成员保存 glyph range；fraction rule不是任意水平线；编号不是公式正文。

```text
recommended_render_formula(atom):
    if safe_vector_replay(atom): return vector_asset(atom)
    return crop_original_page(atom.bbox, with_provenance=true)
```

矢量优先与crop降级是你的输出建议，不能宣称 HJFY 已对任意公式保证此路径。

## 7. 表格事务

来源：`0x100c1dc80`、`0x100c29360`、`0x100c27fb0`。

```text
observed_table_outline(region):
    if text_item_count(region) < 4: reject("insufficient_text_items")
    columns = connected_vertical_rules_or_horizontal_endpoints_or_text_alignment()
    if not 3 <= boundary_count(columns) <= 17:
        reject("unsupported_column_count")
    if lacks_sufficient_vertical_grid and column_count(columns) < 3:
        reject("text_only_table_has_too_few_columns")
    rows = horizontal_grid_or_best_anchor_column()
    if boundary_count(rows) < 3: reject("ambiguous_rows")
    for text in region.items:
        cell = locate_by_bbox_center(text, rows, columns)
        if meaningful(text) and not cell: reject("text_outside_grid")
        if nonempty(text) and horizontal_coverage(text, cell) < 0.90:
            reject("text_crosses_column")
        assign_to_single_cell(text, cell)
    reject_if_missing_meaningful_text_or_no_translatable_cells()
    reject_if_source_glyph_shared_with_external_items()
    return candidate_cells

recommended_validate_table(proposal, owners):
    if proposal.failed: return false
    if has_unsupported_merge_topology(proposal): return false
    if not complete_meaningful_source_coverage(proposal): return false
    if owners.conflicts(proposal.source_ranges): return false
    return true
```

复杂rowspan/colspan检测是独立建议；原算法没有恢复这种拓扑。成功才替换，失败保留同表关联区域，不能半提交。

## 8. 可选翻译与可信 HTML

```text
recommended_translate(block, translator):
    fragment, manifest = serialize_restricted_fragment(block)
    # Manifest contains KEEP sequence, styles/spans, links, immutable literals.
    response = translator(fragment)
    parsed = parse_allowlisted_fragment(response)
    if parsed.failed \
       or parsed.keep_sequence != manifest.keep_sequence \
       or parsed.style_span_sequence != manifest.style_span_sequence \
       or changed_immutable_links_or_literals(parsed, manifest):
        return preserve_original(block, "invalid_translation")
    return apply_to_ir(block, parsed, preserve_source_ranges=true)

recommended_export_html(ir):
    validate_ownership_and_source_coverage(ir)
    return trusted_renderer(ir, escape_text=true, sanitize_links=true)
```

严格序列校验是建议合同；不能把 HJFY 的全部提示约束当作每个验证模式已完全恢复。最终renderer不信任LLM HTML；email和URL保真不等于允许执行危险URL。

## 9. 验证入口

算法单测用合成 display list；字体、ToUnicode、Form、clip、alpha使用真实自制PDF集成测试。测试规范见 `PDF解析边界用例.json`。当前没有实际PDF fixture、目标执行结果或用户解析器测试结果。

"""Native prompt panels: logical paragraphs, roles, placeholders and answer slots.

Only the export copy changes. Positive geometric and textual evidence is required
before treating a code/table candidate as a natural-language prompt.
"""

import re
from copy import deepcopy
from statistics import median

import pypdfium2 as pdfium
from bs4 import NavigableString
from pagelingo_parser.normalize import content_text
from preview_layout import (
    canonical,
    in_box,
    map_native,
    math_contents_in_block,
    native_chars,
    short_rules,
    source_block,
    union_box,
)
from preview_paragraphs import ranges, source_lines
from preview_source import (
    BAD_GLYPHS,
    FURNITURE_TYPES,
    callout_box,
    colored_rectangles,
    contained,
    overlap_fraction,
    page_panels,
    text_highlights,
)
from preview_typography import underlined_indices

PLACEHOLDER = re.compile(r"\{[∗*][^{}\n]{1,64}[∗*]\}")
ROLE = re.compile(r"^(?:TASK|SYSTEM|USER|ASSISTANT|DEMO\d*)$")
LABEL = re.compile(r"^(?:Q|A|Input|Output|Problem|Solution|Question|Answer|Text|Article|Step \d+):")
NAMED_LINE = re.compile(r"^[A-Za-z][A-Za-z\d ]{0,25}:")


def line_text(chars, members):
    """PDF whitespace is useful, but only text belonging to this visual line is read."""
    indices = {c["index"] for c in members}
    start, end = min(indices), max(indices)
    return re.sub(
        r"\s+",
        " ",
        "".join(
            c["text"]
            for c in chars[start : end + 1]
            if c["index"] in indices or c["text"].isspace()
        ),
    ).strip()


def gray_role(line, chars, *, template=False):
    gray = [
        c
        for c in line["members"]
        if c["color"]
        and c["color"][3] == 255
        and max(c["color"][:3]) - min(c["color"][:3]) < 8
        and 70 <= min(c["color"][:3]) <= 190
    ]
    label = line_text(chars, gray) if gray else ""
    if not gray or not (
        ROLE.fullmatch(label)
        or template and re.fullmatch(r"[A-Za-z][A-Za-z\d ]{0,25}", label)
    ):
        return None
    body = [c for c in line["members"] if c not in gray]
    if not body or min(c["bbox"][0] for c in body) <= max(c["bbox"][2] for c in gray):
        return None
    return {
        "text": line_text(chars, gray),
        "color": gray[0]["color"][:3],
        "width": max(c["bbox"][2] for c in gray) - min(c["bbox"][0] for c in gray),
        "gap": min(c["bbox"][0] for c in body) - max(c["bbox"][2] for c in gray),
        "fontRatio": median(c["fontSize"] for c in gray) / median(c["fontSize"] for c in body),
        "indices": [c["index"] for c in gray],
        "body": body,
    }


def template_role_panel(chars, lines, parser_text):
    """Admit mixed-case field labels only for an exactly anchored variable template.

    Gray text alone is not a role: real tables and arbitrary colored prose must
    not enter this path. Each row needs a label and a shared body column, with
    at least two complete placeholder values and a natural-language instruction.
    """
    if len(lines) < 3:
        return False
    roles = [gray_role(line, chars, template=True) for line in lines]
    if not all(roles):
        return False
    lefts = [min(c["bbox"][0] for c in role["body"]) for role in roles]
    if max(lefts) - min(lefts) > 0.004:
        return False
    bodies = [line_text(chars, role["body"]) for role in roles]
    if sum(bool(PLACEHOLDER.fullmatch(t)) for t in bodies) < 2:
        return False
    if not any(len(re.findall(r"[A-Za-z]+", text)) >= 4 for text in bodies):
        return False
    native = " ".join(line_text(chars, line["members"]) for line in lines)
    return canonical(native) == canonical(parser_text)


def blank_slots(panel, chars, rules, font, page, paints=None):
    result = []
    for box in rules:
        if not contained(box, panel["bbox"], tolerance=0):
            continue
        y = (box[1] + box[3]) / 2
        # Reject rules under existing glyphs, including model-missed underlining.
        if any(
            c["bbox"]
            and box[0] <= c["x"] <= box[2]
            and 0 < (y - c["y"]) * page.get_height() < font * 1.2
            for c in chars
        ):
            continue
        if not 0.7 <= (box[2] - box[0]) * page.get_width() / font <= 8:
            continue
        slot = {
                "bbox": box,
                "widthEm": round((box[2] - box[0]) * page.get_width() / font, 3),
        }
        for paint in paints or []:
            bbox = paint["bbox"]
            if (
                contained(bbox, panel["bbox"], tolerance=0)
                and 0.5 <= (bbox[3] - bbox[1]) * page.get_height() / font <= 1.7
                and abs(bbox[3] - y) * page.get_height() < font * 0.4
                and 0.8 <= (bbox[2] - bbox[0]) / (box[2] - box[0]) <= 1.2
                and abs(bbox[0] - box[0]) * page.get_width() < font * 0.3
                and not any(in_box(c, bbox, tolerance=0) for c in chars)
            ):
                slot.update(backgroundColor=paint["color"], backgroundBBox=bbox)
        result.append(slot)
    return result


def split_panel_blocks(blocks, panels, chars, rules, page):
    """Describe disjoint template fragments without changing parser block identities."""
    splits = {}
    for original in list(blocks):
        if original["type"] not in {"text", "code"} or math_contents_in_block(original):
            continue
        if (original.get("guess_lang") or "txt").casefold() not in {
            "txt", "text", "plain", "unknown",
        }:
            continue
        candidates = sorted(
            [p for p in panels if max(p["color"]) - min(p["color"]) <= 8
             and 220 <= min(p["color"]) < 253
             and contained(p["bbox"], original["bbox"], tolerance=0.004)],
            key=lambda p: p["bbox"][1],
        )
        if len(candidates) < 2 or any(
            a["bbox"][3] >= b["bbox"][1]
            for a, b in zip(candidates, candidates[1:], strict=False)
        ):
            continue
        groups = []
        for panel in candidates:
            selected = [c for c in chars if in_box(c, panel["bbox"], tolerance=0)]
            lines = source_lines(selected)
            if (
                not lines
                or not any(
                    PLACEHOLDER.fullmatch(line_text(chars, line["members"])) for line in lines
                )
                or not blank_slots(
                    panel, chars, rules, median(line["fontSize"] for line in lines), page
                )
            ):
                break
            text = " ".join(line_text(chars, line["members"]) for line in lines)
            groups.append((panel, selected, text))
        if len(groups) != len(candidates):
            continue
        original_text = content_text(original.get("content", ""))
        if canonical("".join(t for _, _, t in groups)) != canonical(original_text):
            continue
        selected = [c for c in chars if in_box(c, original["bbox"])]
        if canonical("".join(c["text"] for c in selected)) != canonical(original_text):
            continue
        for ordinal, (panel, native, _) in enumerate(groups):
            splits[tuple(panel["bbox"])] = {
                "method": "disjoint-native-template-panels", "sourceBlockIndex": original["index"],
                "sourceKind": original["type"], "sourceBBox": original["bbox"],
                "sourceText": original_text,
                "panelOrdinal": ordinal,
                "nativeCharacterRanges": ranges(c["index"] for c in native),
            }
    return splits


def reconstruct_rows(
    chars, lines, slots, parser_text, page, *, template_roles=False, paragraph_boxes=()
):
    rows, roles, soft_hyphens = [], [], []
    right_margin = max(line["bbox"][2] for line in lines)
    for i, line in enumerate(lines):
        role = gray_role(line, chars, template=template_roles)
        members = role["body"] if role else line["members"]
        text = line_text(chars, members)
        soft_wrap = False
        if text.endswith("\x02") and i + 1 < len(lines):
            next_text = line_text(chars, lines[i + 1]["members"])
            left, right = (
                re.search(r"([a-z]+)\x02$", text),
                re.match(r"([a-z]+)", next_text),
            )
            if (
                left
                and right
                and (left[1] + right[1] in parser_text or left[1] + "-\n" + right[1] in parser_text)
            ):
                text = text[:-1]
                soft_wrap = True
                soft_hyphens.append(members[-1]["index"])
        if BAD_GLYPHS.search(text):
            return None
        if role:
            roles.append(role)
        line_slots = [
            slot
            for slot in slots
            if abs((slot["bbox"][1] + slot["bbox"][3]) / 2 - line["baseline"]) * page.get_height()
            < line["fontSize"] * 0.6
            and slot["bbox"][0] >= line["bbox"][2] - 0.002
        ]
        for slot in line_slots:
            slot["inlineLine"] = i
        mapping = None
        if roles and "→" in text:
            left, right = text.split("→", 1)
            mapping = {"left": left.strip(), "right": right.strip()}
        start_new = (
            not rows
            or role is not None
            or mapping is not None
            or PLACEHOLDER.fullmatch(text) is not None
            or NAMED_LINE.match(text) is not None
        )
        if rows and i:
            gap = (line["baseline"] - lines[i - 1]["baseline"]) * page.get_height()
            start_new |= gap > 1.48 * line["fontSize"] or bool(rows[-1].get("placeholderOnly"))
            # Block boundaries provide an additional hard-break hint, not hard wrapping.
            previous_text = rows[-1]["text"]
            start_new |= previous_text.endswith(":") or bool(rows[-1].get("mapping"))
            start_new |= not previous_text
            paragraph = next(
                (box for box in paragraph_boxes if contained(lines[i - 1]["bbox"], box)), None
            )
            margin = max(
                line["bbox"][2] for line in lines if contained(line["bbox"], paragraph)
            ) if paragraph else right_margin
            start_new |= (margin - lines[i - 1]["bbox"][2]) * page.get_width() > 2.5 * line[
                "fontSize"
            ]
        if not start_new:
            row = rows[-1]
            join = row.pop("joinNext", False)
            boundary = row["text"][-1:] + text[:1]
            join |= bool(re.fullmatch(r"[\u3400-\u9fff]{2}", boundary)) and boundary in parser_text
            row["text"] += ("" if join else " ") + text
            row["sourceIndices"].extend(sorted(c["index"] for c in members))
            row["joinNext"] = soft_wrap
            row["slots"].extend(line_slots)
        else:
            rows.append(
                {
                    "text": text,
                    "role": {k: v for k, v in role.items() if k != "body"} if role else None,
                    "mapping": mapping,
                    "placeholderOnly": bool(PLACEHOLDER.fullmatch(text)),
                    "slots": line_slots,
                    "sourceIndices": sorted(c["index"] for c in members),
                    "baseline": line["baseline"],
                    "joinNext": soft_wrap,
                }
            )
        # A standalone slot is a separate layout object, never inferred from model text.
        next_baseline = lines[i + 1]["baseline"] if i + 1 < len(lines) else 1
        for slot in slots:
            y = (slot["bbox"][1] + slot["bbox"][3]) / 2
            if "inlineLine" not in slot and line["baseline"] < y < next_baseline:
                rows.append(
                    {
                        "text": "",
                        "role": None,
                        "mapping": None,
                        "slots": [slot],
                        "sourceIndices": [],
                        "baseline": y,
                    }
                )
    expected = canonical("".join(line_text(chars, line["members"]) for line in lines)).replace(
        "\x02", ""
    )
    actual = canonical(
        "".join((row["role"]["text"] if row["role"] else "") + row["text"] for row in rows)
    )
    if expected != actual:
        return None
    return rows, roles, soft_hyphens


def row_appearance(row, chars, rules, page, highlights):
    native = [chars[i] for i in row["sourceIndices"] if chars[i]["text"] != "\x02"]
    if canonical("".join(c["text"] for c in native)) != canonical(row["text"]):
        raise ValueError("Prompt inline appearance is not aligned with native text")
    row["native"] = [{k: c[k] for k in ("index", "text", "color")} for c in native]
    row["underlinedIndices"] = underlined_indices(native, rules, page.get_height())
    indices = {c["index"] for c in native}
    row["highlights"] = [
        {**highlight, "indices": [i for i in highlight["indices"] if i in indices]}
        for highlight in highlights
        if indices.intersection(highlight["indices"])
    ]


def recover_role_coverage(members, blocks, chars, lines, roles, uncovered, page):
    """Recover omitted Q/A prose only inside a verified, single-column role panel.

    Native PDF text is authoritative here. Existing parser fragments must match
    it exactly; unrelated text, real math/visuals and ambiguous columns fail shut.
    The original parser bboxes and recovered native ranges remain inspectable.
    """
    roles = [role for role in roles if role]
    if len(roles) < 2 or any(b["type"] != "text" for b in members):
        return None
    body_left = median(min(c["bbox"][0] for c in role["body"]) for role in roles)
    texts = []
    for line in lines:
        role = gray_role(line, chars)
        body = role["body"] if role else line["members"]
        if abs(min(c["bbox"][0] for c in body) - body_left) > 0.012:
            return None
        texts.append(line_text(chars, body))
    if sum(t.startswith("Q:") for t in texts) < 2 or sum(t.startswith("A:") for t in texts) < 2:
        return None
    other = [b for b in blocks if b not in members and b["type"] not in FURNITURE_TYPES]
    if any(any(in_box(c, b["bbox"]) for b in other) for c in uncovered):
        return None
    for block in members:
        native = [c for c in chars if in_box(c, block["bbox"])]
        actual = " ".join(line_text(chars, line["members"]) for line in source_lines(native))
        if canonical(actual) != canonical(content_text(block.get("content", ""))):
            return None
    return {
        "method": "native-role-question-answer-coverage",
        "blockIndex": members[0]["index"],
        "parserBBox": members[0]["bbox"][:],
        "exportBBox": union_box([members[0]["bbox"], *[c["bbox"] for c in uncovered]]),
        "sourceCharacterRanges": ranges(c["index"] for c in uncovered),
    }


def recover_labeled_coverage(members, blocks, chars, lines, uncovered):
    """Repair small omissions in a single-column, colon-labeled prose panel.

    Every parser block must be an exact native anchor, apart from at most one
    missing leading character in a long block. Whole omitted lines must be
    standalone labels. Conflicting ownership or other text differences reject
    the entire repair; nothing is guessed from a label's language or meaning.
    """
    if len(members) < 2 or any(b["type"] not in {"text", "paragraph_title"} for b in members):
        return None
    labels = [
        line for line in lines
        if re.fullmatch(r"[A-Za-z][A-Za-z\d ]{0,25}:", line_text(chars, line["members"]))
    ]
    if len(labels) < 2 or max(line["bbox"][0] for line in lines) - min(
        line["bbox"][0] for line in lines
    ) > 0.012:
        return None
    ordered = sorted(members, key=lambda b: b["bbox"][1])
    if any(a["bbox"][3] > b["bbox"][1] for a, b in zip(ordered, ordered[1:], strict=False)):
        return None
    fixes = {}
    for block in ordered:
        selected = [c for c in chars if in_box(c, block["bbox"])]
        native = " ".join(line_text(chars, line["members"]) for line in source_lines(selected))
        expected = canonical(content_text(block.get("content", "")))
        actual = canonical(native).replace("\x02", "")
        if actual == expected:
            continue
        if len(expected) < 20 or actual[1:] != expected:
            return None
        visible = [c for c in selected if canonical(c["text"])]
        if not visible or canonical(visible[0]["text"]) != actual[0]:
            return None
        # A prefix is recoverable at a physical line start, never mid-line.
        line = next((line for line in lines if visible[0] in line["members"]), None)
        if not line or line["members"][0] is not visible[0]:
            return None
        fixes[block["index"]] = [visible[0]]
    uncovered_indices = {c["index"] for c in uncovered}
    omitted = [line for line in labels if all(
        c["index"] in uncovered_indices for c in line["members"]
    )]
    if uncovered_indices != {c["index"] for line in omitted for c in line["members"]}:
        return None
    for line in omitted:
        following = next((b for b in ordered if b["bbox"][1] >= line["bbox"][3]), None)
        if following is None:
            return None
        fixes.setdefault(following["index"], []).extend(line["members"])
    if not fixes:
        return None
    recovered = [c for group in fixes.values() for c in group]
    others = [b for b in blocks if b not in members and b["type"] not in FURNITURE_TYPES]
    if any(any(in_box(c, b["bbox"]) for b in others) for c in recovered):
        return None
    repairs = []
    for block in ordered:
        if block["index"] not in fixes:
            continue
        recovered_chars = fixes[block["index"]]
        repairs.append({
            "blockIndex": block["index"],
            "parserBBox": block["bbox"][:],
            "exportBBox": union_box([block["bbox"], *[c["bbox"] for c in recovered_chars]]),
            "parserText": content_text(block.get("content", "")),
            "sourceCharacterRanges": ranges(c["index"] for c in recovered_chars),
        })
    return {
        "method": "native-labeled-panel-text-coverage",
        "sourceCharacterRanges": ranges(c["index"] for c in recovered),
        "blockRepairs": repairs,
    }


def repair_order(blocks, panels):
    panels = [p for p in panels if not p.get("splitFromParserBlocks")]
    if not panels:
        return
    before = [b["index"] for b in blocks]
    member_indices = {i for r in panels for i in r["blockIndices"]}
    units = [
        {
            "bbox": r["bbox"],
            "blocks": [b for b in blocks if b["index"] in r["blockIndices"]],
            "furniture": False,
        }
        for r in panels
    ]
    units.extend(
        {"bbox": b["bbox"], "blocks": [b], "furniture": b["type"] in FURNITURE_TYPES}
        for b in blocks
        if b["index"] not in member_indices
    )
    ordered = sorted(units, key=lambda u: u["bbox"][1])
    content = [u for u in ordered if not u["furniture"]]
    if any(
        a["bbox"][3] > b["bbox"][1] + 0.002 for a, b in zip(content[:-1], content[1:], strict=True)
    ):
        return  # Overlapping columns/sidebars do not establish this ordering evidence.
    after = [
        b["index"] for unit in ordered for b in sorted(unit["blocks"], key=lambda b: b["bbox"][1])
    ]
    if before != after:
        for record in panels:
            record["readingOrderRepair"] = {
                "before": before,
                "after": after,
                "method": "nonoverlapping-panel-and-body-units",
            }


def prepare_prompts(raw, run, source):
    prompts, prose = [], []
    with pdfium.PdfDocument(source) as pdf:
        for parsed in raw["pages"]:
            index = parsed["page_idx"]
            blocks = parsed.get("blocks", [])
            page = pdf[run["requestedPageIndices"][index]]
            textpage = None
            try:
                panels = page_panels(page)
                if not panels and not any(b["type"] == "equation" for b in blocks):
                    continue
                textpage = page.get_textpage()
                chars = native_chars(page, textpage)
                highlights = text_highlights(page, chars)
                page_prompts = []
                rules = short_rules(page, max_width=page.get_width())
                paints = colored_rectangles(page)
                panel_splits = split_panel_blocks(blocks, panels, chars, rules, page)
                for panel in panels:
                    if (
                        max(panel["color"]) - min(panel["color"]) > 8
                        or not 220 <= min(panel["color"]) < 253
                    ):
                        continue
                    members = [
                        b
                        for b in blocks
                        if b["type"] not in FURNITURE_TYPES
                        and overlap_fraction(b["bbox"], panel["bbox"]) >= 0.95
                    ]
                    fragment = panel_splits.get(tuple(panel["bbox"]))
                    if fragment:
                        members = [b for b in blocks if b["index"] == fragment["sourceBlockIndex"]]
                    if not members or any(
                        b["type"] in {"image", "chart"}
                        or b.get("sub_type") == "algorithm"
                        or math_contents_in_block(b)
                        or b["type"] == "code"
                        and b.get("guess_lang", "txt").casefold()
                        not in {
                            "txt",
                            "text",
                            "plain",
                            "plaintext",
                            "unknown",
                            "yaml",
                            "yml",
                        }
                        for b in members
                    ):
                        continue
                    selected = [c for c in chars if in_box(c, panel["bbox"], tolerance=0)]
                    lines = source_lines(selected)
                    if not lines:
                        continue
                    font = median(line["fontSize"] for line in lines)
                    slots = blank_slots(panel, chars, rules, font, page, paints)
                    parser_text = " ".join(content_text(b.get("content", "")) for b in members)
                    template_roles = template_role_panel(chars, lines, parser_text)
                    roles = [gray_role(line, chars, template=template_roles) for line in lines]
                    uncovered = [
                        c for c in selected
                        if c["bbox"] and not any(in_box(c, b["bbox"]) for b in members)
                    ]
                    labeled_recovery = recover_labeled_coverage(
                        members, blocks, chars, lines, uncovered
                    )
                    template = any(
                        PLACEHOLDER.search(line_text(chars, line["members"])) for line in lines
                    )
                    highlighted = {i for h in highlights for i in h["indices"]}
                    highlighted_instruction = any(
                        len(re.findall(r"[A-Za-z]+", line_text(chars, line["members"]))) >= 4
                        and all(c["index"] in highlighted for c in line["members"])
                        for line in lines
                    ) and any(NAMED_LINE.match(line_text(chars, line["members"])) for line in lines)
                    if (
                        not slots and not any(roles)
                        and not highlighted_instruction and not labeled_recovery
                    ):
                        continue
                    if (
                        any(b["type"] == "table" for b in members)
                        and not any(roles)
                        and not template
                    ):
                        continue  # Shaded real tables retain the original visual policy.
                    reconstructed = reconstruct_rows(
                        chars, lines, slots, parser_text, page, template_roles=template_roles,
                        paragraph_boxes=[b["bbox"] for b in members] if labeled_recovery else (),
                    )
                    if reconstructed is None:
                        continue
                    rows, roles, hyphens = reconstructed
                    recovery = labeled_recovery
                    if uncovered and recovery is None:
                        recovery = recover_role_coverage(
                            members, blocks, chars, lines, roles, uncovered, page
                        )
                        if recovery is None:
                            continue
                    for row in rows:
                        row_appearance(row, chars, rules, page, highlights)
                    record = {
                        "parsedPageIndex": index,
                        "sourcePageIndex": run["requestedPageIndices"][index],
                        "bbox": panel["bbox"],
                        "bodyColor": panel["color"],
                        "rounded": panel["rounded"],
                        "blockIndices": [b["index"] for b in members],
                        "rows": rows,
                        "sourceCharacterRanges": ranges(c["index"] for c in selected),
                        "nativeSoftHyphenIndices": hyphens,
                        "method": "native-prompt-lines-roles-and-empty-rules",
                        "roleWidthEm": max(
                            (r["width"] * page.get_width() / font for r in roles),
                            default=0,
                        ),
                        "roleGapEm": median(r["gap"] * page.get_width() / font for r in roles)
                        if roles
                        else 0,
                        "parserBlocks": [
                            {
                                "blockIndex": b["index"],
                                "kind": b["type"],
                                "bbox": b["bbox"],
                                "text": content_text(b.get("content", "")),
                            }
                            for b in members
                        ],
                    }
                    if fragment:
                        record["splitFromParserBlocks"] = [deepcopy(fragment)]
                    if recovery:
                        record["nativeCoverageRepair"] = recovery
                        if recovery.get("blockRepairs"):
                            for repair in recovery["blockRepairs"]:
                                next(b for b in members if b["index"] == repair["blockIndex"])[
                                    "bbox"
                                ] = repair["exportBBox"]
                        else:
                            members[0]["bbox"] = recovery["exportBBox"]
                    for block in members:
                        native = [c for c in (chars if fragment else selected)
                                  if in_box(c, block["bbox"])]
                        text = " ".join(
                            line_text(chars, line["members"]) for line in source_lines(native)
                        )
                        # Raw stays immutable. The render copy uses ordinary text, not pre/table.
                        identity, bbox = block["index"], block["bbox"]
                        block.clear()
                        block.update(
                            type="text",
                            index=identity,
                            bbox=bbox,
                            content=[{"type": "text", "content": text.replace("\x02", "")}],
                        )
                    page_prompts.append(record)
                repair_order(blocks, page_prompts)
                if page_prompts:
                    continuations = [b["index"] for b in blocks if b.get("continues_prev")]
                    for block in blocks:
                        if block.get("continues_prev"):
                            block["continues_prev"] = False
                    for record in page_prompts:
                        record["deferredContinuationBlockIndices"] = continuations
                prompts.extend(page_prompts)
                for block in blocks:
                    if block["type"] != "equation":
                        continue
                    selected = [c for c in chars if in_box(c, block["bbox"])]
                    lines = source_lines(selected)
                    if len(lines) != 1:
                        continue
                    text = line_text(chars, lines[0]["members"])
                    if (
                        not re.fullmatch(r"[a-zA-Z_]+\s*=\s*[a-zA-Z ,.'’-]+", text)
                        or len(re.findall(r"[a-zA-Z]+", text.split("=", 1)[1])) < 4
                        or len(re.findall(r"\b[a-zA-Z]{2,}\b", text.split("=", 1)[1])) < 3
                    ):
                        continue
                    prose.append(
                        {
                            "parsedPageIndex": index,
                            "sourcePageIndex": run["requestedPageIndices"][index],
                            "blockIndex": block["index"],
                            "parserText": block["content"],
                            "text": text,
                            "sourceCharacterRanges": ranges(c["index"] for c in selected),
                            "method": "native-single-line-prose-assignment",
                        }
                    )
                    identity, bbox = block["index"], block["bbox"]
                    block.clear()
                    block.update(
                        type="text",
                        index=identity,
                        bbox=bbox,
                        content=[{"type": "text", "content": text}],
                    )
            finally:
                if textpage is not None:
                    textpage.close()
                page.close()
    return {"prompts": prompts, "proseRepairs": prose}


def ensure_prompt_callouts(callouts, prompts):
    for record in prompts:
        fragment = bool(record.get("splitFromParserBlocks"))
        existing = next(
            (
                c
                for c in callouts
                if c["parsedPageIndex"] == record["parsedPageIndex"]
                and set(c["blockIndices"]) == set(record["blockIndices"])
                and not fragment
            ),
            None,
        )
        if existing is None:
            callouts.append(
                {
                    k: record[k]
                    for k in (
                        "parsedPageIndex",
                        "sourcePageIndex",
                        "bbox",
                        "blockIndices",
                        "bodyColor",
                        "rounded",
                    )
                }
            )
            existing = callouts[-1]
            existing.update(
                borderColor=record["bodyColor"], headerBlockIndex=None, headerColor=None
            )
        existing["prompt"] = True
        if fragment:
            existing["embeddedPrompt"] = True


def append_text(soup, parent, text):
    offset = 0
    for match in PLACEHOLDER.finditer(text):
        parent.append(text[offset : match.start()])
        span = soup.new_tag(
            "span",
            attrs={"class": "pl-prompt-placeholder", "data-pl-preserve": "placeholder"},
        )
        span.string = match.group()
        parent.append(span)
        offset = match.end()
    parent.append(text[offset:])


def append_slots(soup, parent, slots):
    for slot in slots:
        span = soup.new_tag(
            "span",
            attrs={
                "class": "pl-completion-slot",
                "data-pl-preserve": "blank",
                "aria-label": "待补全文本",
                "style": f"--pl-slot-width:{slot['widthEm']}em",
            },
        )
        span.string = "____"
        if slot.get("backgroundColor"):
            span["style"] += ";background-color:#" + "".join(
                f"{c:02x}" for c in slot["backgroundColor"]
            )
        parent.append(span)


def apply_prompt_appearance(soup, line, row):
    leaves, mapped = map_native(line, row["native"])
    styles = {}
    backgrounds = {i: tuple(h["color"]) for h in row.get("highlights", []) for i in h["indices"]}
    for char in row["native"]:
        color = char["color"]
        colored = bool(color and color[3] == 255 and color[:3] != [0, 0, 0])
        underlined = char["index"] in row["underlinedIndices"]
        background = backgrounds.get(char["index"])
        if char["index"] in mapped and (colored or underlined or background):
            styles[mapped[char["index"]]] = (
                tuple(color[:3]) if colored else None,
                underlined,
                background,
            )
    for i, leaf in enumerate(leaves):
        if leaf.find_parent(attrs={"data-pl-preserve": True}):
            background = {styles[(i, o)][2] for o in range(len(str(leaf))) if (i, o) in styles}
            if len(background) == 1 and None not in background:
                leaf.parent["style"] = "background-color:#" + "".join(
                    f"{c:02x}" for c in background.pop()
                )
            if all(
                styles.get((i, offset), (None, False, None))[1]
                for offset, char in enumerate(str(leaf)) if not char.isspace()
            ):
                leaf.wrap(soup.new_tag("u"))
            continue  # Variables and blank slots remain intact protected objects.
        text, start = str(leaf), 0
        # Native mappings omit spaces. Bridge only whitespace between identical
        # painted styles so a highlighted sentence stays one formatting binding.
        for match in re.finditer(r"\s+", text):
            left, right = (
                styles.get((i, match.start() - 1)),
                styles.get((i, match.end())),
            )
            if left and left == right:
                for offset in range(match.start(), match.end()):
                    styles[(i, offset)] = left
        while start < len(text):
            style = styles.get((i, start), (None, False, None))
            end = start + 1
            while end < len(text) and styles.get((i, end), (None, False, None)) == style:
                end += 1
            piece = NavigableString(text[start:end])
            if style[1]:
                underline = soup.new_tag("u")
                underline.append(piece)
                piece = underline
            if style[0]:
                color = soup.new_tag("span", attrs={"class": "pl-source-color"})
                color["style"] = "color:#" + "".join(f"{c:02x}" for c in style[0])
                color.append(piece)
                piece = color
            if style[2]:
                highlight = soup.new_tag(
                    "span",
                    attrs={"class": "pl-source-highlight", "data-pl-format": "style"},
                )
                highlight["style"] = "background-color:#" + "".join(f"{c:02x}" for c in style[2])
                highlight.append(piece)
                piece = highlight
            leaf.insert_before(piece)
            start = end
        leaf.extract()


def apply_prompts(soup, supplement):
    fragment_roots = set()
    for record in supplement["prompts"]:
        nodes = [source_block(soup, record["parsedPageIndex"], i) for i in record["blockIndices"]]
        if any(n is None for n in nodes) or any(n.parent is not nodes[0].parent for n in nodes):
            raise ValueError("Native prompt bindings lost before rendering")
        root = nodes[0]
        prompt = soup.new_tag("div", attrs={"class": "pl-prompt"})
        if record["roleWidthEm"]:
            prompt["class"].append("pl-prompt-roles")
            prompt["style"] = (
                f"--pl-role-width:{record['roleWidthEm']:.3f}em;"
                f"--pl-role-gap:{record['roleGapEm']:.3f}em"
            )
        current = prompt
        for index, row in enumerate(record["rows"]):
            if row["role"]:
                role_row = soup.new_tag("div", attrs={"class": "pl-prompt-role-row"})
                role = soup.new_tag("span", attrs={"class": "pl-prompt-role", "translate": "no"})
                role.string = row["role"]["text"]
                role["style"] = (
                    "color:#"
                    + "".join(f"{c:02x}" for c in row["role"]["color"])
                    + f";font-size:{row['role']['fontRatio']:.3f}em"
                )
                current = soup.new_tag("div", attrs={"class": "pl-prompt-value"})
                role_row.extend([role, current])
                prompt.append(role_row)
            line = soup.new_tag(
                "p",
                attrs={
                    "class": "docvortex-text pl-prompt-line",
                    "data-prompt-row": str(index),
                },
            )
            if row["mapping"]:
                line["class"].append("pl-prompt-mapping")
                line["translate"] = "no"
                for value in (row["mapping"]["left"], "→", row["mapping"]["right"]):
                    cell = soup.new_tag("span")
                    cell.string = value
                    line.append(cell)
                append_slots(soup, line.contents[-1], row["slots"])
            else:
                append_text(soup, line, row["text"])
                append_slots(soup, line, row["slots"])
            if not row["text"]:
                line["class"].append("pl-prompt-answer-line")
            apply_prompt_appearance(soup, line, row)
            current.append(line)
        if canonical(prompt.get_text()).replace("____", "") != canonical(
            "".join((r["role"]["text"] if r["role"] else "") + r["text"] for r in record["rows"])
        ):
            raise ValueError("Native prompt lost text during construction")
        if record.get("splitFromParserBlocks"):
            identity = record["parsedPageIndex"], record["blockIndices"][0]
            if identity not in fragment_roots:
                root.clear()
                fragment_roots.add(identity)
            box = callout_box(soup, record)
            body = soup.new_tag("div", attrs={"class": "pl-callout-body"})
            body.append(prompt)
            box.append(body)
            root.append(box)
        else:
            root.clear()
            root.append(prompt)
        root["data-block-type"] = "text"
        for node in nodes[1:]:
            if node.get("id"):
                alias = soup.new_tag("span", id=node["id"])
                root.append(alias)
            node.decompose()
        record["applied"] = True
    repaired_pages = set()
    for record in supplement["prompts"]:
        page_index = record["parsedPageIndex"]
        if not record.get("readingOrderRepair") or page_index in repaired_pages:
            continue
        section = soup.select_one(f'section[data-page-idx="{page_index}"]')
        units, seen = [], set()
        for index in record["readingOrderRepair"]["after"]:
            node = source_block(soup, page_index, index)
            if node is None:
                continue
            while node.parent is not section and node.parent is not None:
                node = node.parent
            if node.parent is not section:
                raise ValueError("A prompt order repair crosses a source page boundary")
            if id(node) not in seen:
                units.append(node)
                seen.add(id(node))
        originals = [n for n in section.children if getattr(n, "name", None)]
        prefixes, tails = {}, []
        for i, extra in enumerate(originals):
            if id(extra) in seen:
                continue
            target = next((n for n in originals[i + 1 :] if id(n) in seen), None)
            if target is None:
                tails.append(extra)
            else:
                prefixes.setdefault(id(target), []).append(extra)
        for unit in units:
            for extra in prefixes.get(id(unit), []):
                section.append(extra.extract())
            section.append(unit.extract())
        for extra in tails:
            section.append(extra.extract())
        repaired_pages.add(page_index)
    for record in supplement["proseRepairs"]:
        node = source_block(soup, record["parsedPageIndex"], record["blockIndex"])
        if node is None:
            raise ValueError("Native prose assignment lost before rendering")
        node["class"] = [*node.get("class", []), "pl-source-centered"]
        node["data-source-prose-assignment"] = "true"
        record["applied"] = True

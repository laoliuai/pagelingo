"""Source-backed layout supplements for experimental, untranslated PDF previews.

Retained parser runs are immutable. These records supplement their private export
copy; they are not a new canonical Reader IR or a claim of full layout recovery.
"""

import ctypes
import re
import unicodedata
from copy import copy
from difflib import SequenceMatcher
from statistics import median

import pypdfium2 as pdfium
from bs4 import NavigableString
from pagelingo_parser.geometry import normalized_pdf_box
from pagelingo_parser.normalize import content_text
from preview_paragraphs import (
    page_evidence,
    paragraph_records,
    ranges,
    source_lines,
    validate_native_ownership,
)
from preview_source import BAD_GLYPHS, overlap_fraction

BULLET = re.compile(r"^\s*([•●▪◦‣–])\s+")
NUMBER = re.compile(r"^\s*(?:\((\d+|[a-z]|[ivxlcdm]+)\)|((?:\d+|[a-z]|[ivxlcdm]+))[.)])\s+")


def union_box(boxes):
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def canonical(text):
    return "".join(
        c for c in unicodedata.normalize("NFKC", text) if not c.isspace() and c != "\u00ad"
    )


def native_bounds(box, page):
    left, bottom, right, top = page.get_bbox()
    width, height = right - left, top - bottom

    def point(x, y):
        match page.get_rotation():
            case 0:
                return left + x * width, top - y * height
            case 90:
                return left + y * width, bottom + x * height
            case 180:
                return right - x * width, bottom + y * height
            case 270:
                return right - y * width, top - x * height
            case _:
                raise ValueError("Unsupported PDF rotation")

    points = [point(x, y) for x in (box[0], box[2]) for y in (box[1], box[3])]
    return (
        min(p[0] for p in points),
        min(p[1] for p in points),
        max(p[0] for p in points),
        max(p[1] for p in points),
    )


def in_box(char, box, tolerance=0.003):
    if char["bbox"] is None:
        return False
    x, y = char["x"], char["y"]
    return (
        box[0] - tolerance <= x <= box[2] + tolerance
        and box[1] - tolerance <= y <= box[3] + tolerance
    )


def native_chars(page, textpage):
    chars = []
    for index in range(textpage.count_chars()):
        code = pdfium.raw.FPDFText_GetUnicode(textpage, index)
        text = chr(code) if code <= 0x10FFFF else "\ufffd"
        bbox = None
        if not text.isspace() and code:
            try:
                bbox = normalized_pdf_box(
                    textpage.get_charbox(index), page.get_bbox(), page.get_rotation()
                )
            except ValueError:
                pass
        rgba = [ctypes.c_uint() for _ in range(4)]
        color = (
            [c.value for c in rgba]
            if bbox and pdfium.raw.FPDFText_GetFillColor(textpage, index, *rgba)
            else None
        )
        origin_x, origin_y = ctypes.c_double(), ctypes.c_double()
        baseline = None
        if bbox and pdfium.raw.FPDFText_GetCharOrigin(textpage, index, origin_x, origin_y):
            left, bottom, right, top = page.get_bbox()
            x, y = origin_x.value, origin_y.value
            width, height = right - left, top - bottom
            match page.get_rotation():
                case 0:
                    baseline = [(x - left) / width, (top - y) / height]
                case 90:
                    baseline = [(y - bottom) / height, (x - left) / width]
                case 180:
                    baseline = [(right - x) / width, (y - bottom) / height]
                case 270:
                    baseline = [(top - y) / height, (right - x) / width]
        chars.append(
            {
                "index": index,
                "text": text,
                "bbox": bbox,
                "color": color,
                "x": (bbox[0] + bbox[2]) / 2 if bbox else None,
                "y": (bbox[1] + bbox[3]) / 2 if bbox else None,
                "fontSize": pdfium.raw.FPDFText_GetFontSize(textpage, index) if bbox else 0,
                "baseline": baseline or [(bbox[0] + bbox[2]) / 2, bbox[3]] if bbox else None,
                "pageHeight": page.get_height(),
            }
        )
    return chars


def source_text(chars, selected):
    if not selected:
        return ""
    first, last = min(c["index"] for c in selected), max(c["index"] for c in selected)
    return re.sub(r"\s+", " ", "".join(c["text"] for c in chars[first : last + 1])).strip()


def underlined(block):
    if isinstance(block, dict):
        if "underline" in block.get("styles", []):
            return True
        content = block.get("content", [])
        return isinstance(content, list) and any(underlined(c) for c in content)
    return False


def italic_body_example(block, selected, textpage, body_font):
    """A sentence-sized italic example cannot acquire a heading's typography.

    Keep numbered, bold and large headings. Classification requires a single
    line, exact native text coverage, regular italic fonts and the body size.
    Font evidence is read only for these few title candidates, not every glyph.
    """
    if block["type"] != "paragraph_title" or not body_font or math_contents_in_block(block):
        return None
    text = content_text(block.get("content", "")).strip()
    lines = source_lines(selected)
    if (
        len(lines) != 1
        or not re.search(r"[.!?]$", text)
        or len(re.findall(r"[A-Za-z]+", text)) < 4
        or re.match(r"^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s", text)
        or canonical("".join(c["text"] for c in selected)) != canonical(text)
        or not 0.95 <= lines[0]["fontSize"] / body_font <= 1.05
    ):
        return None
    fonts = set()
    letters = [c for c in selected if re.search(r"[A-Za-z]", c["text"])]
    for char in letters:
        buffer, flags = ctypes.create_string_buffer(256), ctypes.c_int()
        length = pdfium.raw.FPDFText_GetFontInfo(
            textpage, char["index"], buffer, len(buffer), flags
        )
        if length > len(buffer):
            buffer = ctypes.create_string_buffer(length)
            length = pdfium.raw.FPDFText_GetFontInfo(
                textpage, char["index"], buffer, len(buffer), flags
            )
        weight = pdfium.raw.FPDFText_GetFontWeight(textpage, char["index"])
        if not length or not flags.value & (1 << 6) or not 0 < weight <= 500:
            return None
        fonts.add((buffer.value.decode("utf-8", errors="replace"), flags.value, weight))
    if not letters:
        return None
    return {
        "method": "native-body-sized-italic-example",
        "parserKind": block["type"],
        "parserLevel": block.get("level"),
        "fontSize": lines[0]["fontSize"],
        "bodyFontSize": body_font,
        "fonts": [
            {"name": name, "flags": flags, "weight": weight}
            for name, flags, weight in sorted(fonts)
        ],
        "nativeCharacterRanges": ranges(c["index"] for c in selected),
    }


def short_rules(page, max_width=80):
    """Direct horizontal rules, joining adjacent fragments before length filtering."""
    rules = []
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH], max_depth=1):
        if pdfium.raw.FPDFPath_CountSegments(obj) not in (2, 5):
            continue
        matrix = obj.get_matrix()
        if abs(matrix.b) > 1e-5 or abs(matrix.c) > 1e-5:
            continue
        left, bottom, right, top = obj.get_bounds()
        if not 3 <= right - left <= page.get_width() or not 0 < top - bottom <= 1.601:
            continue
        try:
            box = normalized_pdf_box(obj.get_bounds(), page.get_bbox(), page.get_rotation())
        except ValueError:
            continue
        # A vertical line in a rotated display is not a completion slot.
        if (box[2] - box[0]) * page.get_width() < 3:
            continue
        if (box[3] - box[1]) * page.get_height() > 1.601:
            continue
        fill, stroke = ctypes.c_int(), ctypes.c_int()
        if not pdfium.raw.FPDFPath_GetDrawMode(obj, fill, stroke) or not (
            fill.value or stroke.value
        ):
            continue
        rules.append(box)
    merged = []
    for box in sorted(rules, key=lambda b: ((b[1] + b[3]) / 2, b[0])):
        existing = next(
            (
                b
                for b in reversed(merged)
                if abs((b[1] + b[3] - box[1] - box[3]) / 2) * page.get_height() < 0.5
                and max(b[0], box[0]) <= min(b[2], box[2]) + 0.5 / page.get_width()
            ),
            None,
        )
        if existing is None:
            merged.append(box[:])
        else:
            existing[:] = union_box([existing, box])
    return [b for b in merged if (b[2] - b[0]) * page.get_width() <= max_width]


def has_colored_text(page):
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_TEXT], max_depth=1):
        rgba = [ctypes.c_uint() for _ in range(4)]
        if pdfium.raw.FPDFPageObj_GetFillColor(obj, *rgba):
            rgb = [c.value for c in rgba[:3]]
            if rgba[3].value == 255 and max(rgb) - min(rgb) > 30:
                return True
    return False


def marker(block):
    if block["type"] != "text":
        return None
    text = content_text(block.get("content", ""))
    if match := BULLET.match(text):
        return {
            "kind": "ul",
            "prefix": match.group(),
            "number": None,
            "numberStyle": None,
        }
    if match := NUMBER.match(text):
        token = match[1] or match[2]
        if token.isdigit():
            number, style = int(token), "decimal"
        elif len(token) == 1 and token not in "ivx":
            number, style = ord(token) - ord("a") + 1, "lower-alpha"
        else:
            values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
            number = sum(
                -values[c] if i + 1 < len(token) and values[c] < values[token[i + 1]] else values[c]
                for i, c in enumerate(token)
            )
            style = "lower-roman"
        return {
            "kind": "ol",
            "prefix": match.group(),
            "number": number,
            "numberStyle": style,
        }
    return None


def list_records(blocks, parsed_index, source_index, prompt_indices=None):
    groups, current = [], []
    prompt_indices = prompt_indices or set()
    for block in [*blocks, {"type": "end"}]:
        item = None if block.get("index") in prompt_indices else marker(block)
        if (
            current
            and item is None
            and block.get("bbox")
            and block["type"] in {"text", "image", "table", "chart", "code", "equation"}
        ):
            if block["bbox"][0] >= current[-1]["bbox"][0] + 0.009:
                current[-1]["continuationBlockIndices"].append(block["index"])
                continue
        if current and (item is None or item["kind"] != current[-1]["kind"]):
            if any(e["numberStyle"] == "lower-alpha" for e in current):
                for entry in current:
                    if match := re.match(r"^\s*\(?([a-z])[.)]", entry["prefix"]):
                        entry["number"] = ord(match[1]) - ord("a") + 1
                        entry["numberStyle"] = "lower-alpha"
            lefts = []
            for entry in current:
                x = entry["bbox"][0]
                if not any(abs(x - left) < 0.015 for left in lefts):
                    lefts.append(x)
            lefts.sort()
            for entry in current:
                entry["depth"] = min(
                    range(len(lefts)), key=lambda i: abs(lefts[i] - entry["bbox"][0])
                )
            # Numbering advances among siblings; children may restart at one.
            siblings = {}
            valid = current[0]["kind"] == "ul"
            if not valid and len(current) >= 2:
                valid = True
                for entry in current:
                    depth = entry["depth"]
                    previous = siblings.get(depth)
                    if previous and (
                        entry["numberStyle"] != previous["numberStyle"]
                        or entry["number"] != previous["number"] + 1
                    ):
                        valid = False
                    siblings = {d: e for d, e in siblings.items() if d <= depth}
                    siblings[depth] = entry
            if valid:
                groups.append(
                    {
                        "parsedPageIndex": parsed_index,
                        "sourcePageIndex": source_index,
                        "kind": current[0]["kind"],
                        "items": current,
                    }
                )
            current = []
        if item:
            current.append(
                {
                    **item,
                    "blockIndex": block["index"],
                    "bbox": block["bbox"][:],
                    "continuationBlockIndices": [],
                }
            )
    return groups


def definition_records(blocks, chars, page, parsed_index, source_index):
    """Recover aligned label/value rows, preserving rendered inline formatting."""
    records, pending = [], []

    def flush():
        if len(pending) >= 2:
            font = median(row["fontSize"] for row in pending)
            value_lefts = [row["valueBBox"][0] for row in pending]
            if max(value_lefts) - min(value_lefts) <= 0.012:
                records.append(
                    {
                        "parsedPageIndex": parsed_index,
                        "sourcePageIndex": source_index,
                        "blockIndices": list(dict.fromkeys(row["blockIndex"] for row in pending)),
                        "labelWidthEm": max(
                            (r["labelBBox"][2] - r["labelBBox"][0]) * page.get_width() / font
                            for r in pending
                        ),
                        "gapEm": median(
                            (r["valueBBox"][0] - r["labelBBox"][2]) * page.get_width() / font
                            for r in pending
                        ),
                        "rows": pending[:],
                        "native": [
                            {k: c[k] for k in ("index", "text")}
                            for c in chars
                            if any(
                                in_box(c, b["bbox"])
                                for b in blocks
                                if b["index"] in {r["blockIndex"] for r in pending}
                            )
                        ],
                    }
                )
        pending.clear()

    for block in [*blocks, {"type": "end"}]:
        proposed = []
        if block["type"] == "text" and not math_contents_in_block(block):
            selected = [c for c in chars if in_box(c, block["bbox"])]
            lines = source_lines(selected)
            for line in lines:
                positioned = line["members"]
                colon = next(
                    (i for i, c in enumerate(positioned) if c["text"] in {":", "："}),
                    None,
                )
                if colon is None or not 0 < colon < len(positioned) - 1:
                    proposed = []
                    break
                label, value = positioned[: colon + 1], positioned[colon + 1 :]
                label_text = source_text(chars, label)
                gap = value[0]["bbox"][0] - label[-1]["bbox"][2]
                if (
                    len(label_text) > 35
                    or not re.fullmatch(r"[\w\s()/−-]+[:：]", label_text)
                    or gap * page.get_width() < 0.65 * line["fontSize"]
                ):
                    proposed = []
                    break
                proposed.append(
                    {
                        "blockIndex": block["index"],
                        "label": label_text,
                        "labelBBox": union_box([c["bbox"] for c in label]),
                        "valueBBox": union_box([c["bbox"] for c in value]),
                        "labelIndices": [c["index"] for c in label],
                        "valueIndices": [c["index"] for c in value],
                        "fontSize": line["fontSize"],
                        "baseline": line["baseline"],
                    }
                )
        if not proposed:
            flush()
        else:
            if pending and (
                (proposed[0]["baseline"] - pending[-1]["baseline"]) * page.get_height()
                > 3 * proposed[0]["fontSize"]
                or abs(proposed[0]["valueBBox"][0] - pending[-1]["valueBBox"][0]) > 0.012
            ):
                flush()
            pending.extend(proposed)
    return records


def math_contents_in_block(block):
    if isinstance(block, dict):
        if block.get("type") in {"equation", "equation_inline"}:
            return True
        return isinstance(block.get("content"), list) and any(
            math_contents_in_block(c) for c in block["content"]
        )
    return False


def notation_rows(block, chars, page):
    selected = [c for c in chars if in_box(c, block["bbox"])]
    if len(selected) < 20:
        return None
    tolerance = median(c["fontSize"] for c in selected) / page.get_height() * 0.7
    groups = []
    for char in sorted(selected, key=lambda c: c["y"]):
        if not groups or abs(char["y"] - median(c["y"] for c in groups[-1])) > tolerance:
            groups.append([char])
        else:
            groups[-1].append(char)
    if len(groups) < 4:
        return None
    rows, starts = [], []
    for group in groups:
        positioned = sorted(group, key=lambda c: c["bbox"][0])
        gap, start = max(
            (b["bbox"][0] - a["bbox"][2], b["bbox"][0])
            for a, b in zip(positioned[:-1], positioned[1:], strict=True)
        )
        if gap * page.get_width() < 8:
            return None
        starts.append(start)
        term = [c for c in group if c["bbox"][0] < start - 0.003]
        explanation = [c for c in group if c not in term]
        if not term or len(explanation) < 4:
            return None
        description = source_text(chars, explanation)
        if BAD_GLYPHS.search(description):
            return None
        rows.append(
            {
                "symbolText": source_text(chars, term),
                "symbolBBox": union_box([c["bbox"] for c in term]),
                "description": description,
                "descriptionBBox": union_box([c["bbox"] for c in explanation]),
            }
        )
    if max(starts) - min(starts) > 0.005:
        return None  # Require a genuinely aligned definition column.
    return rows


def repair_footnotes(blocks, page, textpage):
    notes = [b for b in blocks if b["type"] == "page_footnote"]
    repairs, used = [], set()
    for outer in sorted(
        notes,
        key=lambda b: (b["bbox"][2] - b["bbox"][0]) * (b["bbox"][3] - b["bbox"][1]),
        reverse=True,
    ):
        if outer["index"] in used:
            continue
        fragments = [
            b
            for b in notes
            if b is not outer
            and b["index"] not in used
            and overlap_fraction(b["bbox"], outer["bbox"]) >= 0.95
        ]
        if not fragments:
            continue
        box = union_box([b["bbox"] for b in [outer, *fragments]])
        box = [
            max(0, box[0] - 0.003),
            max(0, box[1] - 0.004),
            min(1, box[2] + 0.003),
            min(1, box[3] + 0.003),
        ]
        text = re.sub(r"\s+", " ", textpage.get_text_bounded(*native_bounds(box, page))).strip()
        if not text or BAD_GLYPHS.search(text):
            continue
        removed = [b["index"] for b in fragments]
        repairs.append(
            {
                "blockIndex": outer["index"],
                "removedIndices": removed,
                "bbox": box,
                "text": text,
            }
        )
        outer["bbox"] = box
        outer["content"] = [{"type": "text", "content": text}]
        used.update(removed)
        used.add(outer["index"])
    blocks[:] = [
        b for b in blocks if b["index"] not in {i for r in repairs for i in r["removedIndices"]}
    ]
    return repairs


def collect_layout(raw, run, source, callouts=None, prompt_blocks=None):
    layout = {
        "lists": [],
        "notation": [],
        "inline": [],
        "footnoteRepairs": [],
        "paragraphs": [],
        "definitions": [],
        "pages": [],
        "prompts": [],
        "proseRepairs": [],
    }
    callouts = callouts or []
    prompt_blocks = prompt_blocks or set()
    regions = []
    with pdfium.PdfDocument(source) as pdf:
        for parsed in raw["pages"]:
            index = parsed["page_idx"]
            source_index = run["requestedPageIndices"][index]
            blocks = parsed.get("blocks", [])
            prompt_indices = {b["index"] for b in blocks if (index, b["index"]) in prompt_blocks}
            lists = list_records(blocks, index, source_index, prompt_indices)
            layout["lists"].extend(lists)
            page = pdf[source_index]
            textpage = None
            try:
                rules = short_rules(page)
                notation = any(
                    b["type"] == "paragraph_title"
                    and content_text(b.get("content", "")).strip().lower() == "notation"
                    for b in blocks
                )
                notes = [b for b in blocks if b["type"] == "page_footnote"]
                overlapping = any(
                    a is not b and overlap_fraction(a["bbox"], b["bbox"]) >= 0.95
                    for a in notes
                    for b in notes
                )
                if blocks:
                    textpage = page.get_textpage()
                    chars = native_chars(page, textpage)
                else:
                    chars = []
                if overlapping:
                    for repair in repair_footnotes(blocks, page, textpage):
                        layout["footnoteRepairs"].append(
                            {
                                **repair,
                                "parsedPageIndex": index,
                                "sourcePageIndex": source_index,
                            }
                        )
                evidence = page_evidence(
                    blocks,
                    chars,
                    page,
                    index,
                    source_index,
                    run.get("runId", "fixture"),
                )
                layout["pages"].append(evidence)
                marked_indices = {b["index"] for b in blocks if marker(b)} | prompt_indices
                paragraphs = paragraph_records(
                    blocks,
                    evidence,
                    [c for c in callouts if c["parsedPageIndex"] == index],
                    marked_indices,
                )
                layout["paragraphs"].extend(paragraphs)
                panel_members = {
                    i for p in callouts if p["parsedPageIndex"] == index for i in p["blockIndices"]
                }
                body_fonts = [
                    line["fontSize"]
                    for b in evidence["blocks"]
                    if b["kind"] == "text"
                    and b["blockIndex"] not in panel_members | prompt_indices
                    and b["bbox"][2] - b["bbox"][0] > 0.45
                    for line in b["visualLines"]
                ]
                body_font = median(body_fonts) if body_fonts else None
                definitions = definition_records(
                    [b if b["index"] not in prompt_indices else {"type": "end"} for b in blocks],
                    chars,
                    page,
                    index,
                    source_index,
                )
                for group in definitions:
                    left = min(row["labelBBox"][0] for row in group["rows"])
                    anchor = next(
                        (r for r in paragraphs if r["blockIndex"] == group["blockIndices"][0]),
                        None,
                    )
                    columns = evidence["bodyColumns"]
                    base = (
                        anchor["referenceLeft"]
                        if anchor
                        else (
                            min(columns, key=lambda c: abs(c["left"] - left))["left"]
                            if columns
                            else left
                        )
                    )
                    font = median(row["fontSize"] for row in group["rows"])
                    group["leftInsetEm"] = round(
                        max(0, min(8, (left - base) * page.get_width() / font)), 3
                    )
                layout["definitions"].extend(definitions)
                for group in lists:
                    first = group["items"][0]
                    selected = [c for c in chars if in_box(c, first["bbox"])]
                    lines = source_lines(selected)
                    if lines:
                        line = lines[0]
                        prefix_length = len(canonical(first["prefix"]))
                        members = line["members"]
                        content_left = members[min(prefix_length, len(members) - 1)]["bbox"][0]
                        panel = next(
                            (
                                c
                                for c in callouts
                                if c["parsedPageIndex"] == index
                                and first["blockIndex"] in c["blockIndices"]
                            ),
                            None,
                        )
                        if panel:
                            bases = [
                                line["bbox"][0]
                                for b in evidence["blocks"]
                                if b["blockIndex"] in panel["blockIndices"]
                                and b["blockIndex"] not in marked_indices
                                for line in b["visualLines"]
                            ]
                            base = min(bases) if bases else first["bbox"][0]
                        else:
                            columns = evidence["bodyColumns"]
                            base = (
                                min(
                                    columns,
                                    key=lambda c: abs(c["left"] - first["bbox"][0]),
                                )["left"]
                                if columns
                                else first["bbox"][0]
                            )
                        group["insetEm"] = round(
                            max(
                                1.2,
                                min(
                                    8,
                                    (content_left - base) * page.get_width() / line["fontSize"],
                                ),
                            ),
                            3,
                        )
                for panel in [c for c in callouts if c["parsedPageIndex"] == index]:
                    columns = evidence["bodyColumns"]
                    if columns:
                        column = min(columns, key=lambda c: abs(c["left"] - panel["bbox"][0]))
                        fonts = [
                            line["fontSize"]
                            for b in evidence["blocks"]
                            if b["blockIndex"] in panel["blockIndices"]
                            for line in b["visualLines"]
                        ]
                        if fonts:
                            panel["leftInsetEm"] = round(
                                max(
                                    0,
                                    min(
                                        8,
                                        (panel["bbox"][0] - column["left"])
                                        * page.get_width()
                                        / median(fonts),
                                    ),
                                ),
                                3,
                            )
                            panel["rightInsetEm"] = round(
                                max(
                                    0,
                                    min(
                                        8,
                                        (column["right"] - panel["bbox"][2])
                                        * page.get_width()
                                        / median(fonts),
                                    ),
                                ),
                                3,
                            )
                notation_indices = set()
                if notation:
                    for block in blocks:
                        if block["type"] != "text" or block["bbox"][3] - block["bbox"][1] < 0.2:
                            continue
                        rows = notation_rows(block, chars, page)
                        if rows is None:
                            continue
                        for row_index, row in enumerate(rows):
                            path = (
                                f"assets/original/page-{source_index + 1:04d}"
                                f"-notation-{block['index']}-{row_index}.png"
                            )
                            row["symbolPath"] = path
                            regions.append(
                                {
                                    "parsedPageIndex": index,
                                    "sourcePageIndex": source_index,
                                    "blockIndex": block["index"],
                                    "rowIndex": row_index,
                                    "kind": "notation-symbol",
                                    "role": "notation-symbol",
                                    "bbox": row["symbolBBox"],
                                    "path": path,
                                    "source": "native-pdf-character-bounds",
                                }
                            )
                        layout["notation"].append(
                            {
                                "parsedPageIndex": index,
                                "sourcePageIndex": source_index,
                                "blockIndex": block["index"],
                                "rows": rows,
                            }
                        )
                        notation_indices.add(block["index"])
                for block in blocks:
                    if (
                        block["type"] not in {"text", "paragraph_title", "page_footnote"}
                        or block["index"] in notation_indices
                        or block["index"] in prompt_indices
                    ):
                        continue
                    selected = [c for c in chars if in_box(c, block["bbox"])]
                    if not selected:
                        continue
                    colored_chars = [
                        c
                        for c in selected
                        if c["color"]
                        and c["color"][3] == 255
                        and max(c["color"][:3]) - min(c["color"][:3]) > 30
                    ]
                    blanks = []
                    for rule in [] if underlined(block) else rules:
                        baseline = (rule[1] + rule[3]) / 2
                        before = [
                            c
                            for c in selected
                            if c["bbox"][2] <= rule[0] + 0.001
                            and abs(c["bbox"][3] - baseline) * page.get_height() < 5
                        ]
                        if not before:
                            continue
                        anchor = max(before, key=lambda c: c["bbox"][2])
                        if (rule[0] - anchor["bbox"][2]) * page.get_width() > 14:
                            continue
                        width_em = (rule[2] - rule[0]) * page.get_width() / anchor["fontSize"]
                        if width_em < 0.7:
                            continue  # Underlined spaces/kerning gaps are not completion slots.
                        above = [
                            c
                            for c in chars
                            if c["bbox"]
                            and rule[0] <= c["x"] <= rule[2]
                            and 0 < baseline - c["y"] < anchor["fontSize"] / page.get_height() * 1.2
                        ]
                        if above:
                            continue  # It underlines existing text, not an empty slot.
                        blanks.append(
                            {
                                "bbox": rule,
                                "afterNativeIndex": anchor["index"],
                                "widthEm": width_em,
                            }
                        )
                    full_box = union_box([block["bbox"], *[b["bbox"] for b in blanks]])
                    wide = [
                        b["bbox"]
                        for b in blocks
                        if b["type"] == "text" and b["bbox"][2] - b["bbox"][0] > 0.5
                    ]
                    center = median((b[0] + b[2]) / 2 for b in wide) if wide else 0.5
                    inset = next(
                        (r for r in paragraphs if r["blockIndex"] == block["index"]),
                        None,
                    )
                    aligned_inset = (
                        inset
                        and inset["leftInsetEm"] > 0
                        and any(
                            peer["blockIndex"] != block["index"]
                            and abs(peer["leftInsetEm"] - inset["leftInsetEm"]) < 0.15
                            and abs(peer["visualLines"][0]["bbox"][1] - block["bbox"][1]) < 0.06
                            for peer in paragraphs
                        )
                    )
                    centered = (
                        block["type"] in {"text", "paragraph_title"}
                        and full_box[2] - full_box[0] < 0.55
                        and full_box[3] - full_box[1] < 0.035
                        and abs((full_box[0] + full_box[2]) / 2 - center) < 0.025
                        and not marker(block)
                        and not aligned_inset
                    )
                    example = italic_body_example(block, selected, textpage, body_font)
                    centered |= example is not None
                    if not colored_chars and not blanks and not centered:
                        continue
                    layout["inline"].append(
                        {
                            "parsedPageIndex": index,
                            "sourcePageIndex": source_index,
                            "blockIndex": block["index"],
                            "centered": centered,
                            "native": [
                                {k: c[k] for k in ("index", "text", "color")} for c in selected
                            ],
                            "coloredIndices": [c["index"] for c in colored_chars],
                            "blanks": blanks,
                            **({"exampleAppearance": example} if example else {}),
                        }
                    )
                # Preserve block identities until structural supplements are applied.
                identities = {i["blockIndex"] for group in lists for i in group["items"]}
                identities.update(notation_indices)
                identities.update(r["blockIndex"] for r in paragraphs)
                identities.update(i for r in definitions for i in r["blockIndices"])
                identities.update(
                    r["blockIndex"] for r in layout["inline"] if r["parsedPageIndex"] == index
                )
                for position, block in enumerate(blocks):
                    if block["index"] in identities:
                        for neighbor in blocks[position : position + 2]:
                            if "continues_prev" in neighbor:
                                neighbor["continues_prev"] = False
            finally:
                if textpage is not None:
                    textpage.close()
                page.close()
    validate_native_ownership(layout["pages"])
    return layout, regions


def source_block(soup, page_index, block_index):
    cache = soup.__dict__.get("_pl_source_blocks")
    if cache is None:
        cache = {
            (int(node["data-page-idx"]), int(node["data-block-index"])): node
            for node in soup.select(".docvortex-block[data-page-idx][data-block-index]")
        }
        soup.__dict__["_pl_source_blocks"] = cache
    node = cache.get((page_index, block_index))
    return node if node is not None and node.attrs is not None and node.parent is not None else None


def plain_nodes(node):
    return [
        leaf
        for leaf in node.find_all(string=True)
        if not leaf.find_parent(class_="docvortex-math")
        and not leaf.find_parent(["script", "style"])
    ]


def append_piece(soup, pieces, text, color):
    if not text:
        return
    if color:
        span = soup.new_tag("span", attrs={"class": "pl-source-color"})
        span["style"] = "color:#" + "".join(f"{c:02x}" for c in color)
        span.string = text
        pieces.append(span)
    else:
        pieces.append(NavigableString(text))


def map_native(node, characters):
    """Align source character IDs with local DOM text, never with translated text."""
    leaves = plain_nodes(node)
    target, positions = [], []
    for leaf_index, leaf in enumerate(leaves):
        for offset, char in enumerate(str(leaf)):
            for part in canonical(char):
                target.append(part)
                positions.append((leaf_index, offset))
    native, indices = [], []
    for char in characters:
        for part in canonical(char["text"]):
            native.append(part)
            indices.append(char["index"])
    mapped = {}
    for match in SequenceMatcher(None, native, target, autojunk=False).get_matching_blocks():
        for offset in range(match.size):
            mapped[indices[match.a + offset]] = positions[match.b + offset]
    return leaves, mapped


def apply_inline(soup, record):
    node = source_block(soup, record["parsedPageIndex"], record["blockIndex"])
    if node is None or node.find("img"):
        return {
            "appliedColors": 0,
            "appliedBlanks": 0,
            "skipped": "protected-or-missing",
        }
    leaves, mapped = map_native(node, record["native"])
    colors, slots = {}, {}
    by_index = {c["index"]: c for c in record["native"]}
    for index in record["coloredIndices"]:
        if index in mapped:
            colors[mapped[index]] = by_index[index]["color"][:3]
    for slot in record["blanks"]:
        anchor = mapped.get(slot["afterNativeIndex"])
        if anchor:
            slots[(anchor[0], anchor[1] + 1)] = slot
    for leaf_index, leaf in enumerate(leaves):
        text = str(leaf)
        pieces, current, current_color = [], "", None

        for offset in range(len(text) + 1):
            slot = slots.get((leaf_index, offset))
            if slot:
                append_piece(soup, pieces, current, current_color)
                current = ""
                span = soup.new_tag(
                    "span",
                    attrs={
                        "class": "pl-completion-slot",
                        "aria-label": "待补全文本",
                        "style": f"--pl-slot-width:{slot['widthEm']:.3f}em",
                    },
                )
                span.string = "____"
                pieces.append(span)
            if offset == len(text):
                break
            color = colors.get((leaf_index, offset))
            if color != current_color:
                append_piece(soup, pieces, current, current_color)
                current = ""
                current_color = color
            current += text[offset]
        append_piece(soup, pieces, current, current_color)
        for piece in pieces:
            leaf.insert_before(piece)
        leaf.extract()
    if record["centered"]:
        node["class"] = [*node.get("class", []), "pl-source-centered"]
        heading = node.find(re.compile(r"^h[1-6]$"))
        if heading and re.search(r"[.!?]$", heading.get_text().strip()):
            heading.name = "p"  # A centered example sentence is not a chapter heading.
            heading["class"] = ["docvortex-text"]
            if record.get("exampleAppearance"):
                heading.attrs.pop("data-heading-level", None)
                node["data-block-type"] = "text"
                node.attrs.pop("data-level", None)
                node["class"].append("pl-source-example")
                for inline in heading.find_all(["strong", "b", "em", "i"]):
                    inline.unwrap()
                italic = soup.new_tag("em")
                for child in list(heading.contents):
                    italic.append(child.extract())
                heading.append(italic)
                record["exampleAppearance"]["applied"] = True
    return {"appliedColors": len(colors), "appliedBlanks": len(slots), "skipped": None}


def remove_prefix(node, prefix):
    leaves = plain_nodes(node)
    joined = "".join(str(leaf) for leaf in leaves)
    match = BULLET.match(joined) or NUMBER.match(joined)
    if match is None or canonical(match.group()) != canonical(prefix):
        raise ValueError("A recovered list marker disagrees with the rendered text")
    remaining = match.end()
    for leaf in leaves:
        if remaining <= 0:
            break
        text = str(leaf)
        take = min(remaining, len(text))
        leaf.replace_with(NavigableString(text[take:]))
        remaining -= take
    if remaining:
        raise ValueError("A recovered list marker lost its text")


def slice_inline(soup, node, start, end):
    """Copy a validated text interval and its inline markup without duplicate IDs."""
    position = 0

    def visit(child):
        nonlocal position
        if isinstance(child, NavigableString):
            left, right = position, position + len(str(child))
            position = right
            value = str(child)[max(0, start - left) : max(0, min(right, end) - left)]
            return NavigableString(value) if value and right > start and left < end else None
        fragment = copy(child)
        fragment.clear()
        fragment.attrs.pop("id", None)
        for part in child.children:
            selected = visit(part)
            if selected is not None:
                fragment.append(selected)
        return fragment if fragment.contents else None

    fragment = soup.new_tag("span")
    for child in node.children:
        selected = visit(child)
        if selected is None:
            continue
        if selected.name in {"p", "div"}:
            fragment.extend(list(selected.contents))
        else:
            fragment.append(selected)
    return fragment


def apply_definitions(soup, records):
    for record in records:
        native = record.pop("native")
        nodes = {
            index: source_block(soup, record["parsedPageIndex"], index)
            for index in record["blockIndices"]
        }
        root = nodes[record["blockIndices"][0]]
        if any(
            node is None
            or node.find(["img", "script", "style"])
            or node.select_one(".docvortex-math")
            for node in nodes.values()
        ):
            record.update(applied=False, reason="protected-or-missing")
            continue
        if any(node.parent is not root.parent for node in nodes.values()):
            record.update(applied=False, reason="different-structural-parents")
            continue
        slices = []
        valid = True
        for index, node in nodes.items():
            indices = {
                i
                for row in record["rows"]
                if row["blockIndex"] == index
                for key in ("labelIndices", "valueIndices")
                for i in row[key]
            }
            leaves, mapped = map_native(node, [c for c in native if c["index"] in indices])
            offsets, offset = [], 0
            for leaf in leaves:
                offsets.append(offset)
                offset += len(str(leaf))
            for row in [r for r in record["rows"] if r["blockIndex"] == index]:
                pair = []
                for key in ("labelIndices", "valueIndices"):
                    if any(i not in mapped for i in row[key]):
                        valid = False
                        break
                    positions = [offsets[mapped[i][0]] + mapped[i][1] for i in row[key]]
                    if positions != sorted(positions):
                        valid = False
                        break
                    pair.append(slice_inline(soup, node, min(positions), max(positions) + 1))
                if len(pair) == 2:
                    slices.append(pair)
        before = canonical("".join(node.get_text() for node in nodes.values()))
        after = canonical("".join(fragment.get_text() for pair in slices for fragment in pair))
        if not valid or before != after:
            record.update(applied=False, reason="native-dom-text-coverage-mismatch")
            continue  # Atomic: leave every source node intact if coverage is uncertain.
        dl = soup.new_tag("dl", attrs={"class": "pl-label-rows"})
        dl["style"] = (
            f"--pl-label-width:{record['labelWidthEm']:.3f}em;"
            f"--pl-label-gap:{min(2, record['gapEm']):.3f}em"
        )
        for row, pair in zip(record["rows"], slices, strict=True):
            entry = soup.new_tag("div", attrs={"class": "pl-label-row"})
            entry["data-source-block-index"] = str(row["blockIndex"])
            original = nodes[row["blockIndex"]]
            if original.get("data-source-id"):
                entry["data-source-id"] = original["data-source-id"]
            if original is not root and original.get("id"):
                entry["id"] = original["id"]
                original.attrs.pop("id", None)
            dt, dd = soup.new_tag("dt"), soup.new_tag("dd")
            dt.extend(list(pair[0].contents))
            dd.extend(list(pair[1].contents))
            entry.extend([dt, dd])
            dl.append(entry)
        root.clear()
        root["class"] = [*root.get("class", []), "pl-source-paragraph"]
        root["data-source-first-line-em"] = "0"
        root["data-source-inset-em"] = str(record.get("leftInsetEm", 0))
        root["style"] = (
            root.get("style", "") + ";--pl-first-line:0em;"
            f"--pl-inset:{record.get('leftInsetEm', 0)}em"
        )
        root.append(dl)
        for node in list(nodes.values())[1:]:
            node.decompose()
        record["applied"] = True


def apply_lists(soup, records):
    for record in records:
        nodes = [
            source_block(soup, record["parsedPageIndex"], item["blockIndex"])
            for item in record["items"]
        ]
        if any(n is None or n.find("img") for n in nodes):
            record["applied"] = False
            continue
        if any(n.parent is not nodes[0].parent for n in nodes):
            record["applied"] = False
            continue  # Never regroup blocks across a painted panel boundary.
        parent, units, used = nodes[0].parent, [], set()
        for item in record["items"]:
            continuation = []
            for index in item.get("continuationBlockIndices", []):
                unit = source_block(soup, record["parsedPageIndex"], index)
                if unit is None:
                    # A validated label group may already own this source block.
                    continue
                while unit.parent is not parent and unit.parent is not None:
                    unit = unit.parent
                if unit.parent is not parent or any(
                    n is unit or n in unit.descendants for n in nodes
                ):
                    continuation = None
                    break
                if id(unit) not in used:
                    continuation.append(unit)
                    used.add(id(unit))
            units.append(continuation)
        if any(unit is None for unit in units):
            record.update(applied=False, reason="continuation-crosses-list-boundary")
            continue
        prefixes = []
        for node in nodes:
            joined = "".join(str(leaf) for leaf in plain_nodes(node))
            prefixes.append(BULLET.match(joined) or NUMBER.match(joined))
        if any(
            match is None or canonical(match.group()) != canonical(item["prefix"])
            for match, item in zip(prefixes, record["items"], strict=True)
        ):
            record["applied"] = False
            record["reason"] = "marker-not-reliably-rendered"
            continue
        root = soup.new_tag(record["kind"], attrs={"class": "pl-source-list"})
        inset = record.get("insetEm", 2.4)
        root["style"] = f"padding-left:{inset}em;--pl-parent-inset:{inset}em"
        if record["kind"] == "ol":
            root["start"] = str(record["items"][0]["number"])
            root["style"] += (
                f";list-style-type:{record['items'][0].get('numberStyle') or 'decimal'}"
            )
        nodes[0].insert_before(root)
        stack = [root]
        for item, node, continuation in zip(record["items"], nodes, units, strict=True):
            depth = min(item["depth"], len(stack))
            if not root.find("li"):
                depth = 0  # A page may start with a continuation of a nested list.
            while len(stack) > depth + 1:
                stack.pop()
            if depth == len(stack):
                parent_item = stack[-1].find_all("li", recursive=False)[-1]
                nested = soup.new_tag(record["kind"], attrs={"class": "pl-source-list"})
                if record["kind"] == "ol":
                    nested["start"] = str(item["number"])
                    nested["style"] = f"list-style-type:{item.get('numberStyle') or 'decimal'}"
                parent_item.append(nested)
                stack.append(nested)
            remove_prefix(node, item["prefix"])
            node.name = "li"
            node["data-list-depth"] = str(depth)
            node["style"] = node.get("style", "") + f";--pl-parent-inset:{inset + depth * 1.8}em"
            for unit in continuation:
                node.append(unit.extract())
            stack[-1].append(node.extract())
        record["applied"] = True


def toc_depth(text, fallback=0):
    if re.match(r"^[IVXLCDM]+\s+", text):
        return 0
    if match := re.match(r"^(\d+(?:\.\d+)*)[.]?\s+", text):
        return min(6, match[1].count(".") + 1)
    return fallback


def apply_layout(soup, layout):
    for record in layout["notation"]:
        node = source_block(soup, record["parsedPageIndex"], record["blockIndex"])
        if node is None:
            raise ValueError("Notation source block lost during rendering")
        node.clear()
        dl = soup.new_tag("dl", attrs={"class": "pl-notation"})
        for index, row in enumerate(record["rows"]):
            entry = soup.new_tag(
                "div",
                attrs={"class": "pl-notation-entry", "data-notation-row": str(index)},
            )
            dt, dd = soup.new_tag("dt"), soup.new_tag("dd")
            dt.append(soup.new_tag("img", src=row["symbolPath"], alt=row["symbolText"]))
            dd.string = row["description"]
            entry.extend([dt, dd])
            dl.append(entry)
        node.append(dl)
    for record in layout["inline"]:
        record["result"] = apply_inline(soup, record)
        record.pop("native")  # Do not duplicate whole source paragraphs in metadata.
    for record in layout.get("paragraphs", []):
        node = source_block(soup, record["parsedPageIndex"], record["blockIndex"])
        if node is None or node.find("img") or "pl-source-centered" in node.get("class", []):
            record["applied"] = False
            continue
        node["class"] = [*node.get("class", []), "pl-source-paragraph"]
        node["data-source-first-line-em"] = str(record["firstLineEm"])
        node["data-source-inset-em"] = str(record["leftInsetEm"])
        node["style"] = (
            node.get("style", "") + ";"
            f"--pl-first-line:{record['firstLineEm']}em;--pl-inset:{record['leftInsetEm']}em"
        )
        record["applied"] = True
    for page in layout.get("pages", []):
        for block in page["blocks"]:
            if "/c" not in block["id"]:
                node = source_block(soup, page["parsedPageIndex"], block["blockIndex"])
                if node:
                    node["data-source-id"] = block["id"]
    apply_definitions(soup, layout.get("definitions", []))
    for group in layout.get("definitions", []):
        if group["applied"]:
            for paragraph in layout.get("paragraphs", []):
                if (
                    paragraph["parsedPageIndex"] == group["parsedPageIndex"]
                    and paragraph["blockIndex"] in group["blockIndices"]
                ):
                    paragraph.update(
                        applied=False,
                        reason="superseded-by-label-rows",
                        labelGroupBlockIndex=group["blockIndices"][0],
                    )
    apply_lists(soup, layout["lists"])
    for index in soup.select(".docvortex-index"):
        index["class"] = [*index.get("class", []), "pl-source-index"]
        for item in index.select("li"):
            depth = toc_depth(item.get_text("", strip=True))
            item["data-toc-depth"] = str(depth)
            item["style"] = f"--pl-depth:{depth}"
    for section in soup.select("section[data-page-idx]"):
        notes = section.select('.docvortex-block[data-block-type="page_footnote"]')
        if notes:
            notes[0].insert_before(soup.new_tag("hr", attrs={"class": "pl-footnote-rule"}))
            for note in notes:
                note["class"] = [*note.get("class", []), "pl-reader-footnote"]

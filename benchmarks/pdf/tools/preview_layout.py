"""Source-backed layout supplements for experimental, untranslated PDF previews.

Retained parser runs are immutable. These records supplement their private export
copy; they are not a new canonical Reader IR or a claim of full layout recovery.
"""

import ctypes
import re
import unicodedata
from difflib import SequenceMatcher
from statistics import median

import pypdfium2 as pdfium
from bs4 import NavigableString
from pagelingo_parser.geometry import normalized_pdf_box
from pagelingo_parser.normalize import content_text
from preview_source import BAD_GLYPHS, overlap_fraction

BULLET = re.compile(r"^\s*([•●▪◦])\s*")
NUMBER = re.compile(r"^\s*(\d+)[.)]\s+")


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
        chars.append(
            {
                "index": index,
                "text": text,
                "bbox": bbox,
                "color": color,
                "x": (bbox[0] + bbox[2]) / 2 if bbox else None,
                "y": (bbox[1] + bbox[3]) / 2 if bbox else None,
                "fontSize": pdfium.raw.FPDFText_GetFontSize(textpage, index) if bbox else 0,
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


def short_rules(page):
    """Only short, direct, horizontal paths; text underlines are rejected later."""
    rules = []
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH], max_depth=1):
        if pdfium.raw.FPDFPath_CountSegments(obj) not in (2, 5):
            continue
        matrix = obj.get_matrix()
        if abs(matrix.b) > 1e-5 or abs(matrix.c) > 1e-5:
            continue
        left, bottom, right, top = obj.get_bounds()
        if not 3 <= right - left <= 80 or not 0 < top - bottom <= 1.6:
            continue
        try:
            box = normalized_pdf_box(obj.get_bounds(), page.get_bbox(), page.get_rotation())
        except ValueError:
            continue
        # A vertical line in a rotated display is not a completion slot.
        if (box[2] - box[0]) * page.get_width() < 3:
            continue
        if (box[3] - box[1]) * page.get_height() > 1.6:
            continue
        fill, stroke = ctypes.c_int(), ctypes.c_int()
        if not pdfium.raw.FPDFPath_GetDrawMode(obj, fill, stroke) or not (
            fill.value or stroke.value
        ):
            continue
        rules.append(box)
    return rules


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
        return {"kind": "ul", "prefix": match.group(), "number": None}
    if match := NUMBER.match(text):
        return {"kind": "ol", "prefix": match.group(), "number": int(match[1])}
    return None


def list_records(blocks, parsed_index, source_index):
    groups, current = [], []
    for block in [*blocks, {"type": "end"}]:
        item = marker(block)
        if current and (item is None or item["kind"] != current[-1]["kind"]):
            # A numbered ordinary sentence is not sufficient list evidence.
            valid = current[0]["kind"] == "ul" or (
                len(current) >= 2
                and all(
                    b["number"] == a["number"] + 1
                    for a, b in zip(current[:-1], current[1:], strict=True)
                )
            )
            if valid:
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
            current.append({**item, "blockIndex": block["index"], "bbox": block["bbox"][:]})
    return groups


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
            {"blockIndex": outer["index"], "removedIndices": removed, "bbox": box, "text": text}
        )
        outer["bbox"] = box
        outer["content"] = [{"type": "text", "content": text}]
        used.update(removed)
        used.add(outer["index"])
    blocks[:] = [
        b for b in blocks if b["index"] not in {i for r in repairs for i in r["removedIndices"]}
    ]
    return repairs


def collect_layout(raw, run, source):
    layout = {"lists": [], "notation": [], "inline": [], "footnoteRepairs": []}
    regions = []
    with pdfium.PdfDocument(source) as pdf:
        for parsed in raw["pages"]:
            index = parsed["page_idx"]
            source_index = run["requestedPageIndices"][index]
            blocks = parsed.get("blocks", [])
            lists = list_records(blocks, index, source_index)
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
                colored = has_colored_text(page)
                if notation or rules or overlapping or colored:
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
                    centered = (
                        block["type"] in {"text", "paragraph_title"}
                        and full_box[2] - full_box[0] < 0.55
                        and full_box[3] - full_box[1] < 0.035
                        and abs((full_box[0] + full_box[2]) / 2 - center) < 0.025
                        and not marker(block)
                    )
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
                        }
                    )
                # Preserve block identities until structural supplements are applied.
                identities = {i["blockIndex"] for group in lists for i in group["items"]}
                identities.update(notation_indices)
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
    return layout, regions


def source_block(soup, page_index, block_index):
    return soup.select_one(
        f'.docvortex-block[data-page-idx="{page_index}"][data-block-index="{block_index}"]'
    )


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


def apply_inline(soup, record):
    node = source_block(soup, record["parsedPageIndex"], record["blockIndex"])
    if node is None or node.find("img"):
        return {"appliedColors": 0, "appliedBlanks": 0, "skipped": "protected-or-missing"}
    leaves = plain_nodes(node)
    target, positions = [], []
    for leaf_index, leaf in enumerate(leaves):
        for offset, char in enumerate(str(leaf)):
            for part in canonical(char):
                target.append(part)
                positions.append((leaf_index, offset))
    native, indices = [], []
    for char in record["native"]:
        for part in canonical(char["text"]):
            native.append(part)
            indices.append(char["index"])
    mapped = {}
    for match in SequenceMatcher(None, native, target, autojunk=False).get_matching_blocks():
        for offset in range(match.size):
            mapped[indices[match.a + offset]] = positions[match.b + offset]
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
        if record["kind"] == "ol":
            root["start"] = str(record["items"][0]["number"])
        nodes[0].insert_before(root)
        stack = [root]
        for item, node in zip(record["items"], nodes, strict=True):
            depth = min(item["depth"], len(stack))
            if not root.find("li"):
                depth = 0  # A page may start with a continuation of a nested list.
            while len(stack) > depth + 1:
                stack.pop()
            if depth == len(stack):
                parent_item = stack[-1].find_all("li", recursive=False)[-1]
                nested = soup.new_tag(record["kind"], attrs={"class": "pl-source-list"})
                parent_item.append(nested)
                stack.append(nested)
            remove_prefix(node, item["prefix"])
            node.name = "li"
            node["data-list-depth"] = str(depth)
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
                "div", attrs={"class": "pl-notation-entry", "data-notation-row": str(index)}
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

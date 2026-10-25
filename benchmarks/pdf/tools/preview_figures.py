"""Keep a confirmed grid of subfigures together as one original PDF region."""

import re
from copy import deepcopy

import pypdfium2 as pdfium
from pagelingo_parser.normalize import content_text
from preview_source import FURNITURE_TYPES, overlap_fraction


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def grid_rows(bodies):
    rows = []
    for body in sorted(bodies, key=lambda b: (b["bbox"][1], b["bbox"][0])):
        box = body["bbox"]
        for row in rows:
            anchor = row[0]["bbox"]
            overlap = min(box[3], anchor[3]) - max(box[1], anchor[1])
            if overlap >= min(box[3] - box[1], anchor[3] - anchor[1]) * 0.7:
                row.append(body)
                break
        else:
            rows.append([body])
    if len(rows) < 2:
        return None
    columns = len(rows[0])
    if any(len(row) != columns for row in rows[:-1]):
        return None
    if len(rows[-1]) != columns and not (
        columns >= 2 and len(rows) >= 3 and len(rows[-1]) == 1
    ):
        return None
    for row in rows:
        row.sort(key=lambda b: b["bbox"][0])
        if any(a["bbox"][2] >= b["bbox"][0] for a, b in zip(row, row[1:], strict=False)):
            return None
        if len(row) == columns:
            if any(abs(a["bbox"][0] - b["bbox"][0]) > 0.025
                   for a, b in zip(rows[0], row, strict=True)):
                return None
        else:
            grid = union([body["bbox"] for body in rows[0]])
            last = row[0]["bbox"]
            if abs((last[0] + last[2] - grid[0] - grid[2]) / 2) > 0.025:
                return None
    if any(max(b["bbox"][3] for b in a) >= min(b["bbox"][1] for b in b_row)
           for a, b_row in zip(rows, rows[1:], strict=False)):
        return None
    return rows


def native_subcaptions(source, source_index, box, bodies):
    """Vertical pairs need source (a), (b), ... labels, including labels inside crops."""
    from preview_layout import in_box, native_chars
    from preview_paragraphs import ranges, source_lines
    from preview_prompts import line_text

    if source is None or len(bodies) > 26:
        return None
    with pdfium.PdfDocument(source) as pdf:
        page = pdf[source_index]
        textpage = page.get_textpage()
        try:
            chars = native_chars(page, textpage)
            lines = source_lines([c for c in chars if in_box(c, box, tolerance=0)])
            labels = [(line, line_text(chars, line["members"])) for line in lines]
            labels = [(line, text) for line, text in labels if re.match(r"^\([a-z]\)\s+\S", text)]
            if len(labels) != len(bodies):
                return None
            result = []
            for ordinal, ((line, text), body) in enumerate(zip(labels, bodies, strict=True)):
                bbox = body["bbox"]
                if (
                    not text.startswith(f"({chr(97 + ordinal)})")
                    or not bbox[3] - 0.03 <= line["bbox"][1] <= bbox[3] + 0.05
                    or abs((line["bbox"][0] + line["bbox"][2] - bbox[0] - bbox[2]) / 2) > 0.05
                ):
                    return None
                result.append({
                    "text": text, "bbox": line["bbox"],
                    "nativeCharacterRanges": ranges(c["index"] for c in line["members"]),
                })
            return result
        finally:
            textpage.close()
            page.close()


def merge_figure_groups(raw, run, source=None):
    records = []
    for page in raw["pages"]:
        blocks = page.get("blocks", [])
        groups, pending = [], []
        for block in [*blocks, {"type": "end"}]:
            if block["type"] in {"image", "chart"}:
                pending.append(block)
            else:
                if len(pending) >= 2:
                    groups.append(pending[:])
                pending.clear()
        for group in groups:
            bodies = [c for b in group for c in b["content"]
                      if c["type"] == f"{b['type']}_body"]
            captions = [c for b in group for c in b["content"]
                        if c["type"] == f"{b['type']}_caption"]
            main = [c for c in captions if re.match(
                r"^Fig(?:ure)?\.?\s*\d", content_text(c.get("content", "")).strip(), re.I
            )]
            if len(bodies) != len(group) or len(main) != 1:
                continue
            rows = grid_rows(bodies)
            if rows is None:
                continue
            caption = main[0]
            body_box = union([b["bbox"] for b in bodies])
            cbox = caption["bbox"]
            if (
                not 0 <= cbox[1] - body_box[3] <= 0.1
                or cbox[2] - cbox[0] < (body_box[2] - body_box[0]) * 0.8
                or any(c["bbox"][1] < body_box[1] - 0.003 or c["bbox"][3] > cbox[1]
                       for c in captions if c is not caption)
            ):
                continue
            box = union([body_box, *[c["bbox"] for c in captions if c is not caption]])
            if any(overlap_fraction(b["bbox"], box) > 0.05 for b in blocks
                   if b not in group and b["type"] not in FURNITURE_TYPES):
                continue
            labels = None
            if len(rows[0]) == 1:
                labels = native_subcaptions(
                    source, run["requestedPageIndices"][page["page_idx"]], box,
                    [body for row in rows for body in row],
                )
                if labels is None:
                    continue
            anchor = group[0]
            originals = deepcopy(group)
            body = deepcopy(bodies[0])
            body.update(index=anchor["index"], bbox=box, type=f"{anchor['type']}_body")
            caption = deepcopy(caption)
            caption["type"] = f"{anchor['type']}_caption"
            anchor.update(bbox=box, content=[body, caption])
            for removed in group[1:]:
                blocks.remove(removed)
            records.append({
                "parsedPageIndex": page["page_idx"],
                "sourcePageIndex": run["requestedPageIndices"][page["page_idx"]],
                "blockIndex": anchor["index"], "blockIndices": [b["index"] for b in originals],
                "method": "shared-caption-native-subfigure-grid",
                "rows": len(rows), "columns": len(rows[0]), "bbox": box,
                "rowLengths": [len(row) for row in rows],
                "captionIndex": caption["index"], "originalBlocks": originals, "applied": True,
                **({"nativeSubcaptions": labels} if labels else {}),
            })
    return records

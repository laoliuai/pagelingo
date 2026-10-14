"""Conservative PDF paint projection and original-source protection for P0 previews."""

import ctypes
import re

import pypdfium2 as pdfium
from pagelingo_parser.geometry import normalized_pdf_box
from pagelingo_parser.normalize import content_text

BAD_GLYPHS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ue000-\uf8ff\ufffd-\uffff]")
UNCERTAIN_MATH = re.compile(r"[_^]\s*\{\s*\?\s*\}")
VISUAL_TYPES = {"image", "table", "chart"}
FURNITURE_TYPES = {"header", "footer", "page_number"}


def math_contents(block):
    if not isinstance(block, dict):
        return []
    if block.get("type") in {"equation", "equation_inline"}:
        return [block["content"]]
    content = block.get("content")
    return (
        [formula for child in content for formula in math_contents(child)]
        if isinstance(content, list)
        else []
    )


def area(box):
    return (box[2] - box[0]) * (box[3] - box[1])


def overlap_fraction(inner, outer):
    width = max(0, min(inner[2], outer[2]) - max(inner[0], outer[0]))
    height = max(0, min(inner[3], outer[3]) - max(inner[1], outer[1]))
    return width * height / area(inner)


def contained(inner, outer, tolerance=0.002):
    return (
        inner[0] >= outer[0] - tolerance
        and inner[1] >= outer[1] - tolerance
        and inner[2] <= outer[2] + tolerance
        and inner[3] <= outer[3] + tolerance
    )


def rectangular_path(obj):
    """Reject triangles, circles, compound paths and angled/sheared shapes."""
    matrix = obj.get_matrix()
    if abs(matrix.b) > 1e-5 or abs(matrix.c) > 1e-5:
        return False, False
    vertices, moves, bezier_points = [], 0, 0
    count = pdfium.raw.FPDFPath_CountSegments(obj)
    if not 4 <= count <= 32:
        return False, False
    for index in range(count):
        segment = pdfium.raw.FPDFPath_GetPathSegment(obj, index)
        kind = pdfium.raw.FPDFPathSegment_GetType(segment)
        moves += kind == pdfium.raw.FPDF_SEGMENT_MOVETO
        if kind == pdfium.raw.FPDF_SEGMENT_BEZIERTO:
            bezier_points += 1
            if bezier_points % 3:
                continue  # Keep curve endpoints, not control points.
        x, y = ctypes.c_float(), ctypes.c_float()
        if not pdfium.raw.FPDFPathSegment_GetPoint(segment, x, y):
            return False, False
        vertices.append((x.value, y.value))
    if moves != 1 or not pdfium.raw.FPDFPathSegment_GetClose(segment):
        return False, False
    width = max(x for x, _ in vertices) - min(x for x, _ in vertices)
    height = max(y for _, y in vertices) - min(y for _, y in vertices)
    if width <= 0 or height <= 0:
        return False, False
    polygon = (
        abs(
            sum(
                x * yy - xx * y
                for (x, y), (xx, yy) in zip(vertices, vertices[1:] + vertices[:1], strict=True)
            )
        )
        / 2
    )
    return polygon / (width * height) >= 0.9, bool(bezier_points)


def page_panels(page):
    """Only direct page paths: nested Form transforms are not assumed calibrated."""
    candidates = []
    for order, obj in enumerate(
        page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH], max_depth=1)
    ):
        fill, stroke = ctypes.c_int(), ctypes.c_int()
        if not pdfium.raw.FPDFPath_GetDrawMode(obj, fill, stroke) or not fill.value:
            continue
        channels = [ctypes.c_uint() for _ in range(4)]
        if not pdfium.raw.FPDFPageObj_GetFillColor(obj, *channels):
            continue
        rgba = [c.value for c in channels]
        if rgba[3] != 255:
            continue
        rectangular, rounded = rectangular_path(obj)
        if not rectangular:
            continue
        try:
            bbox = normalized_pdf_box(obj.get_bounds(), page.get_bbox(), page.get_rotation())
        except ValueError:
            continue
        if bbox[2] - bbox[0] < 0.25 or bbox[3] - bbox[1] < 0.025 or area(bbox) > 0.8:
            continue
        candidates.append(
            {"bbox": bbox, "color": rgba[:3], "rounded": rounded, "paintOrder": order}
        )
    return candidates


def text_highlights(page, chars):
    """Opaque, colored rectangles calibrated to a single native text line.

    PDF highlighters often paint each word separately. These small paths are
    deliberately excluded from page_panels, which identifies larger containers.
    """
    result = []
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_PATH], max_depth=1):
        fill, stroke = ctypes.c_int(), ctypes.c_int()
        channels = [ctypes.c_uint() for _ in range(4)]
        if (
            not pdfium.raw.FPDFPath_GetDrawMode(obj, fill, stroke)
            or not fill.value
            or not pdfium.raw.FPDFPageObj_GetFillColor(obj, *channels)
        ):
            continue
        rgba = [c.value for c in channels]
        if rgba[3] != 255 or max(rgba[:3]) - min(rgba[:3]) < 30:
            continue
        if not rectangular_path(obj)[0]:
            continue
        try:
            bbox = normalized_pdf_box(obj.get_bounds(), page.get_bbox(), page.get_rotation())
        except ValueError:
            continue
        selected = [
            c
            for c in chars
            if c["bbox"]
            and c["fontSize"] > 0
            and bbox[0] <= c["x"] <= bbox[2]
            and bbox[1] <= c["y"] <= bbox[3]
        ]
        if not selected or any(
            not 0.5 <= (bbox[3] - bbox[1]) * page.get_height() / c["fontSize"] <= 1.7
            for c in selected
        ):
            continue
        result.append({"bbox": bbox, "color": rgba[:3], "indices": [c["index"] for c in selected]})
    return result


def project_source(raw, run, source):
    """No inference. Preserve uncertain text and code, supplement confirmed panel styles."""
    callouts, protected = [], {}
    with pdfium.PdfDocument(source) as pdf:
        for parsed in raw["pages"]:
            parsed_index = parsed["page_idx"]
            source_index = run["requestedPageIndices"][parsed_index]
            blocks = parsed.get("blocks", [])
            page = pdf[source_index]
            try:
                panels = page_panels(page)
                for block in blocks:
                    if block["type"] in VISUAL_TYPES | FURNITURE_TYPES:
                        continue
                    bad = BAD_GLYPHS.findall(content_text(block.get("content", "")))
                    uncertain = [
                        formula
                        for formula in math_contents(block)
                        if UNCERTAIN_MATH.search(formula)
                    ]
                    algorithm = block["type"] == "code" and block.get("sub_type") == "algorithm"
                    if not bad and not algorithm and not uncertain:
                        continue
                    bbox = block["bbox"][:]
                    if algorithm:
                        # Include the painted frame and floating title when close to the
                        # parser's algorithm bbox. Never expand into arbitrary nearby text.
                        for panel in panels:
                            pbox = panel["bbox"]
                            if (
                                overlap_fraction(pbox, bbox) >= 0.9
                                and area(pbox) > area(bbox) * 0.5
                            ):
                                bbox = [
                                    min(bbox[0], pbox[0]),
                                    min(bbox[1], pbox[1]),
                                    max(bbox[2], pbox[2]),
                                    max(bbox[3], pbox[3]),
                                ]
                    protected[(parsed_index, block["index"])] = {
                        "role": "algorithm" if algorithm else "source-fallback",
                        "reason": "preserve-algorithm-layout"
                        if algorithm
                        else ("invalid-text-glyphs" if bad else "uncertain-math-punctuation"),
                        "sourceKind": block["type"],
                        "sourceBBox": block["bbox"][:],
                        "bbox": bbox,
                        "invalidGlyphCodes": sorted({f"U+{ord(char):04X}" for char in bad}),
                        "uncertainMath": uncertain,
                    }
                # Each outer panel owns its inset body and title strip. The parser's
                # graph/table bodies are excluded so chart shading cannot become a callout.
                outers = [
                    p
                    for p in panels
                    if min(p["color"]) < 253
                    if not any(
                        p is not q
                        and min(q["color"]) < 253
                        and contained(p["bbox"], q["bbox"], tolerance=0)
                        and area(q["bbox"]) > area(p["bbox"]) * 1.01
                        for q in panels
                    )
                ]
                for outer in outers:
                    bbox = outer["bbox"]
                    members = [
                        b
                        for b in blocks
                        if b["type"] not in FURNITURE_TYPES
                        and overlap_fraction(b["bbox"], bbox) >= 0.97
                    ]
                    if not members or any(
                        b["type"] in VISUAL_TYPES or (parsed_index, b["index"]) in protected
                        for b in members
                    ):
                        continue
                    # Do not move blocks across outside content or claim partial matches.
                    positions = [blocks.index(b) for b in members]
                    if positions != list(range(positions[0], positions[-1] + 1)):
                        continue
                    inset = [
                        p
                        for p in panels
                        if p is not outer
                        and contained(p["bbox"], bbox)
                        and p["bbox"][2] - p["bbox"][0] >= (bbox[2] - bbox[0]) * 0.8
                        and area(p["bbox"]) >= area(bbox) * 0.55
                    ]
                    body = max(inset, key=lambda p: p["paintOrder"]) if inset else outer
                    header = None
                    if (body["bbox"][1] - bbox[1]) * page.get_height() > 5:
                        first = members[0]
                        if (
                            first["type"] in {"paragraph_title", "doc_title"}
                            and (first["bbox"][1] + first["bbox"][3]) / 2 < body["bbox"][1]
                        ):
                            header = first["index"]
                    callouts.append(
                        {
                            "parsedPageIndex": parsed_index,
                            "sourcePageIndex": source_index,
                            "bbox": bbox,
                            "blockIndices": [b["index"] for b in members],
                            "bodyColor": body["color"],
                            "borderColor": outer["color"],
                            "rounded": outer["rounded"],
                            "headerBlockIndex": header,
                            "headerColor": outer["color"] if header is not None else None,
                        }
                    )
                    # Preserve identities for styling and prevent source continuations
                    # being absorbed across a panel boundary by the upstream renderer.
                    for position in positions + [positions[-1] + 1]:
                        if position < len(blocks) and "continues_prev" in blocks[position]:
                            blocks[position]["continues_prev"] = False
            finally:
                page.close()
    return callouts, protected


def apply_callouts(soup, callouts):
    blocks = {
        (int(node["data-page-idx"]), int(node["data-block-index"])): node
        for node in soup.select(".docvortex-block[data-page-idx][data-block-index]")
    }
    for record in callouts:
        nodes = [blocks.get((record["parsedPageIndex"], index)) for index in record["blockIndices"]]
        if any(node is None for node in nodes):
            raise ValueError("A styled panel lost a source block during rendering")
        # This is article content. Generic browser translators often exclude aside.
        box = soup.new_tag("section", attrs={"class": "pl-callout"})
        box["data-source-panel"] = str(record["sourcePageIndex"])

        def color(rgb):
            return "#" + "".join(f"{c:02x}" for c in rgb)

        box["style"] = (
            f"background:{color(record['bodyColor'])};"
            f"border-color:{color(record['borderColor'])};"
            f"border-radius:{8 if record['rounded'] else 0}px;"
            f"margin-inline-start:max(0em,calc({record.get('leftInsetEm', 0)}em "
            "- var(--pl-parent-inset,0em)));"
            f"margin-inline-end:{record.get('rightInsetEm', 0)}em"
        )
        nodes[0].insert_before(box)
        body = soup.new_tag("div", attrs={"class": "pl-callout-body"})
        for node in nodes:
            if int(node["data-block-index"]) == record["headerBlockIndex"]:
                node["class"] = [*node.get("class", []), "pl-callout-title"]
                rgb = record["headerColor"]
                foreground = "#fff" if sum(rgb) < 3 * 160 else "#202b3b"
                node["style"] = f"background:{color(rgb)};color:{foreground}"
                box.append(node.extract())
            else:
                body.append(node.extract())
        box.append(body)

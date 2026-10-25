"""Native font evidence and conservative inline typography for PDF previews."""

import ctypes
import re
import unicodedata

import pypdfium2 as pdfium
from bs4 import NavigableString


def canonical(text):
    return "".join(
        c for c in unicodedata.normalize("NFKC", text) if not c.isspace() and c != "\u00ad"
    )


def font_appearance(textpage, index):
    buffer, flags = ctypes.create_string_buffer(256), ctypes.c_int()
    length = pdfium.raw.FPDFText_GetFontInfo(textpage, index, buffer, len(buffer), flags)
    if length > len(buffer):
        buffer = ctypes.create_string_buffer(length)
        length = pdfium.raw.FPDFText_GetFontInfo(textpage, index, buffer, len(buffer), flags)
    name = buffer.value.decode("utf-8", errors="replace") if length else ""
    weight = pdfium.raw.FPDFText_GetFontWeight(textpage, index)
    # Some embedded CJK subsets report 0 or values above 1000. Those are not
    # usable CSS weights and cannot turn isolated glyphs into bold text.
    valid_weight = weight if 1 <= weight <= 1000 else None
    return {
        "name": name,
        "flags": flags.value,
        "rawWeight": weight,
        "weight": valid_weight,
        "bold": bool(
            flags.value & (1 << 18)
            or re.search(r"bold|semibold|demi|heavy|black", name, re.I)
            or valid_weight is not None and valid_weight >= 550
        ),
        "italic": bool(flags.value & (1 << 6) or re.search(r"italic|ital|oblique", name, re.I)),
    }


def underlined_indices(characters, rules, page_height):
    return [
        c["index"]
        for c in characters
        if c.get("baseline")
        and any(
            rule[0] <= c["x"] <= rule[2]
            and 0 < ((rule[1] + rule[3]) / 2 - c["baseline"][1]) * page_height
            < c["fontSize"] * 0.6
            for rule in rules
        )
    ]


def ambiguous_math_glyphs(page, textpage, bbox):
    """Unmapped extension-font letters cannot safely represent math operators."""
    from pagelingo_parser.geometry import normalized_pdf_box

    result = []
    for index in range(textpage.count_chars()):
        code = pdfium.raw.FPDFText_GetUnicode(textpage, index)
        if not (65 <= code <= 90 or 97 <= code <= 122):
            continue
        try:
            box = normalized_pdf_box(
                textpage.get_charbox(index), page.get_bbox(), page.get_rotation()
            )
        except ValueError:
            continue
        x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        if not (bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]):
            continue
        font = font_appearance(textpage, index)
        if re.search(r"math.*extension|^cmex|^lmex", font["name"], re.I):
            result.append({"nativeIndex": index, "unicode": chr(code), "bbox": box, "font": font})
    return result


def parser_font_styles(block):
    if not isinstance(block, dict):
        return False
    return bool({"bold", "italic"}.intersection(block.get("styles", []))) or any(
        parser_font_styles(child)
        for child in block.get("content", [])
        if isinstance(child, dict)
    )


def regular_body_heading(block, selected, body_font, in_panel):
    if block["type"] != "paragraph_title" or not body_font or not selected:
        return None
    content = block.get("content", [])
    if any(c.get("type") != "text" for c in content):
        return None
    text = "".join(c.get("content", "") for c in content).strip()
    fonts = [c.get("font") for c in selected]
    if (
        canonical("".join(c["text"] for c in selected)) != canonical(text)
        or any(not f or not f["name"] or f["bold"] or f["italic"] for f in fonts)
        or any(not 0.95 <= c["fontSize"] / body_font <= 1.05 for c in selected)
        or re.match(r"^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s", text)
        or not (
            len(re.findall(r"[A-Za-z]+", text)) >= 8
            or in_panel and len(text) <= 40 and text.endswith((":", "："))
        )
    ):
        return None
    return {"method": "native-regular-body-prose", "parserLevel": block.get("level")}


def apply_typography(soup, node, characters, underlined):
    leaves = [
        leaf for leaf in node.find_all(string=True)
        if not leaf.find_parent(class_="docvortex-math")
        and not leaf.find_parent(["script", "style"])
        and not leaf.find_parent(class_="pl-completion-slot")
    ]
    source = [(part, c) for c in characters for part in canonical(c["text"])]
    target = [
        (part, (i, offset))
        for i, leaf in enumerate(leaves)
        for offset, char in enumerate(str(leaf))
        for part in canonical(char)
    ]
    native_text = "".join(part for part, _ in source)
    dom_text = "".join(part for part, _ in target)
    offset, alignment = 0, "exact"
    if dom_text != native_text:
        # A parser can omit a leading CJK glyph. Style existing text only when
        # its entire sequence is a unique, almost complete native substring.
        offset = native_text.find(dom_text)
        if (
            len(dom_text) < 20
            or len(native_text) - len(dom_text) > 2
            or offset < 0
            or native_text.count(dom_text) != 1
        ):
            return {"alignment": "text-mismatch", "applied": False}
        alignment = "near-complete-source-span"
    mapped = {
        position: char
        for (_, position), (_, char) in zip(target, source[offset:], strict=False)
    }
    removed = 0
    for tag in node.find_all(["strong", "b", "em", "i"]):
        trait = "bold" if tag.name in {"strong", "b"} else "italic"
        members = [
            mapped.get((i, o))
            for i, leaf in enumerate(leaves) if tag in leaf.parents
            for o, char in enumerate(str(leaf)) if canonical(char)
        ]
        if members and all(c and c.get("font", {}).get("name") for c in members):
            if not any(c["font"][trait] for c in members):
                tag.unwrap()
                removed += 1
    underlined = set(underlined)
    wrapped = 0
    for i, leaf in enumerate(leaves):
        if leaf.find_parent(attrs={"data-pl-preserve": True}):
            continue
        text = str(leaf)
        styles = {}
        for o, _ in enumerate(text):
            char = mapped.get((i, o))
            if not char:
                continue
            font = char.get("font", {})
            styles[o] = (
                bool(font.get("bold") and not leaf.find_parent(["strong", "b"])),
                bool(font.get("italic") and not leaf.find_parent(["em", "i"])),
                bool(char["index"] in underlined and not leaf.find_parent("u")),
            )
        for match in re.finditer(r"\s+", text):
            left, right = styles.get(match.start() - 1), styles.get(match.end())
            if left and left == right:
                for o in range(match.start(), match.end()):
                    styles[o] = left
        start = 0
        while start < len(text):
            style = styles.get(start, (False, False, False))
            end = start + 1
            while end < len(text) and styles.get(end, (False, False, False)) == style:
                end += 1
            piece = NavigableString(text[start:end])
            for enabled, name in zip(style, ("strong", "em", "u"), strict=True):
                if enabled:
                    wrapper = soup.new_tag(name)
                    wrapper.append(piece)
                    piece = wrapper
                    wrapped += 1
            leaf.insert_before(piece)
            start = end
        leaf.extract()
    return {
        "alignment": alignment, "applied": True,
        "removedUnsupportedStyles": removed, "addedStyleRuns": wrapped,
    }

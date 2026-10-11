"""Loss-conscious P0 projection; semantic merging and translation are deliberately absent."""

import hashlib

from .geometry import display_box, validate_box

KIND_MAP = {
    "text": "paragraph",
    "paragraph": "paragraph",
    "doc_title": "title",
    "title": "title",
    "section_header": "heading",
    "paragraph_title": "heading",
    "list_item": "list",
    "list": "list",
    "index": "index",
    "picture": "figure",
    "image": "figure",
    "image_body": "figure",
    "chart": "figure",
    "table": "table",
    "table_body": "table",
    "formula": "equation",
    "equation": "equation",
    "code": "code",
    "code_body": "code",
    "algorithm_body": "algorithm",
    "caption": "caption",
    "image_caption": "caption",
    "table_caption": "caption",
    "chart_caption": "caption",
    "code_caption": "caption",
    "footnote": "footnote",
    "page_footnote": "footnote",
    "image_footnote": "footnote",
    "table_footnote": "footnote",
    "chart_footnote": "footnote",
    "code_footnote": "footnote",
    "page_header": "header",
    "header": "header",
    "page_footer": "footer",
    "footer": "footer",
    "page_number": "page_number",
    "reference": "reference",
    "ref_text": "reference",
}
TEXT_KINDS = {"paragraph", "title", "heading", "caption", "list", "footnote"}
VISUAL_KINDS = {"figure", "table", "equation", "code", "algorithm", "unknown"}


def content_text(content) -> str:
    """Display/search projection only. Original structured content stays in `payload`."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(content_text(child) for child in content)
    if isinstance(content, dict):
        return content_text(content.get("content", ""))
    return ""


def _block(parser, pointer, label, text, payload, source_refs, scope="body", parent_id=None):
    return {
        "id": hashlib.sha256(f"{parser}:{pointer}".encode()).hexdigest()[:20],
        "rawRef": pointer,
        "kind": KIND_MAP.get(label, "unknown"),
        "parserLabel": label,
        "text": text,
        "payload": payload,
        "sourceRefs": source_refs,
        "scope": scope,
        "parentId": parent_id,
        "confidence": None,
        "assetIds": [],
    }


def normalize_docling(raw: dict, selected: list[int], source: dict) -> tuple[list, list, list]:
    blocks, warnings, reached = [], [], set()
    raw_pages = raw.get("pages", {})
    covered = [
        selected[int(number) - 1] for number in raw_pages if 1 <= int(number) <= len(selected)
    ]

    def resolve(pointer):
        value = raw
        for part in pointer.removeprefix("#/").split("/"):
            value = value[int(part)] if isinstance(value, list) else value[part]
        return value

    def visit(pointer, scope="body", parent=None):
        if pointer in reached:
            return
        reached.add(pointer)
        item = resolve(pointer)
        label = item.get("label", "unknown")
        if pointer.startswith(("#/body", "#/furniture", "#/groups/")):
            for child in item.get("children", []):
                visit(child["$ref"], scope, parent)
            return
        refs = []
        for provenance in item.get("prov", []):
            parser_page = provenance["page_no"]
            if not 1 <= parser_page <= len(selected):
                raise ValueError("Docling provenance points outside parsed page set")
            index = selected[parser_page - 1]
            raw_size = raw_pages.get(str(parser_page), {}).get("size", {})
            page = source["pages"][index]
            ref = {"pageIndex": index, "precision": "page", "bbox": None}
            box = provenance.get("bbox")
            try:
                if box:
                    width, height = raw_size["width"], raw_size["height"]
                    if (
                        abs(width - page["displayWidth"]) > 1
                        or abs(height - page["displayHeight"]) > 1
                    ):
                        raise ValueError("Parser page size differs from displayed CropBox")
                    if any(abs(v) > 1e-6 for v in page["displayCropBox"][:2]):
                        raise ValueError(
                            "Non-zero CropBox origin needs backend-specific validation"
                        )
                    ref["bbox"] = display_box(
                        [box["l"], box["t"], box["r"], box["b"]]
                        if box["coord_origin"] == "TOPLEFT"
                        else [box["l"], box["b"], box["r"], box["t"]],
                        width,
                        height,
                        box["coord_origin"],
                    )
                    ref["precision"] = "bbox"
            except (ValueError, KeyError, ZeroDivisionError) as error:
                warnings.append(
                    {"code": "bbox_unverified", "rawRef": pointer, "message": str(error)}
                )
            refs.append(ref)
        if not refs:
            warnings.append({"code": "source_missing", "rawRef": pointer})
        block = _block(
            "docling",
            pointer,
            label,
            item.get("text", ""),
            item,
            refs,
            scope,
            parent_id=parent,
        )
        blocks.append(block)
        for child in item.get("children", []):
            visit(child["$ref"], scope, block["id"])

    visit("#/body")
    visit("#/furniture", "furniture")
    # Do not silently discard unreferenced raw items; visibly retain them as orphans.
    for collection in ("texts", "tables", "pictures"):
        for position in range(len(raw.get(collection, []))):
            pointer = f"#/{collection}/{position}"
            if pointer not in reached:
                warnings.append({"code": "unreferenced_item", "rawRef": pointer})
                visit(pointer, "orphan")
    return blocks, covered, warnings


def normalize_mineru(raw: dict, selected: list[int], source: dict) -> tuple[list, list, list]:
    if raw.get("schema") != "docvortex.middle" or raw.get("schema_version") != "2.0":
        raise ValueError("Only MinerU 4 DocVortex middle schema 2.0 is supported")
    blocks, covered, warnings = [], [], []

    def visit(item, pointer, source_index, parent=None):
        label = item["type"]
        refs = [{"pageIndex": source_index, "precision": "page", "bbox": None}]
        if item.get("bbox") is not None:
            refs[0].update({"precision": "bbox", "bbox": validate_box(item["bbox"])})
        block = _block(
            "mineru",
            pointer,
            label,
            content_text(item.get("content", "")),
            item,
            refs,
            parent_id=parent,
        )
        blocks.append(block)
        # Child semantic blocks are retained separately with their parent relation.
        # Inline spans remain verbatim in their parent's payload, including LaTeX and code.
        content = item.get("content", [])
        if label in {"image", "table", "chart", "code", "list", "index"} and isinstance(
            content, list
        ):
            for position, child in enumerate(content):
                visit(child, f"{pointer}/content/{position}", source_index, block["id"])

    for position, page in enumerate(raw["pages"]):
        index = page["page_idx"]
        if not 0 <= index < len(selected):
            raise ValueError("MinerU page points outside parsed page set")
        source_index = selected[index]
        covered.append(source_index)
        for block_index, item in enumerate(page.get("blocks", [])):
            visit(item, f"#/pages/{position}/blocks/{block_index}", source_index)
    if len(covered) != len(set(covered)):
        raise ValueError("Duplicate MinerU source page")
    return blocks, covered, warnings


def normalize(parser: str, raw: dict, selected: list[int], source: dict, input_hash: str) -> dict:
    adapter = normalize_docling if parser == "docling" else normalize_mineru
    blocks, covered, warnings = adapter(raw, selected, source)
    missing = sorted(set(selected) - set(covered))
    if missing:
        warnings.append({"code": "pages_missing", "pageIndices": missing})
    located_pages = {ref["pageIndex"] for block in blocks for ref in block["sourceRefs"]}
    empty_text_pages = sorted(
        index
        for index in covered
        if index not in located_pages and source["pages"][index].get("nativeText", "").strip()
    )
    if empty_text_pages:
        warnings.append(
            {
                "code": "source_text_without_blocks",
                "pageIndices": empty_text_pages,
                "message": "Native source text exists, but parser returned no content blocks",
            }
        )
    return {
        "schemaVersion": "pagelingo-parse/0.1",
        "stage": "P0-provisional",
        "sourceSha256": input_hash,
        "sourcePageCount": source["pageCount"],
        "requestedPageIndices": selected,
        "parsedPageIndices": sorted(covered),
        "coverage": "full" if selected == list(range(source["pageCount"])) else "sample",
        "status": "partial" if missing or empty_text_pages else "complete",
        "coordinateSystem": "rotated-cropbox-top-left-0-1",
        "blocks": blocks,
        "assets": [],
        "warnings": warnings,
        "limitations": [
            "No semantic merging or dehyphenation yet",
            "Inline fidelity requires manual review",
            "Source-image fallback is not proof that all figures were detected",
        ],
    }

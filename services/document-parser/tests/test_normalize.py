from copy import deepcopy

import pytest

from pagelingo_parser.normalize import normalize, normalize_docling, normalize_mineru


def source(count=3):
    return {
        "pageCount": count,
        "pages": [
            {"displayWidth": 100, "displayHeight": 200, "displayCropBox": [0, 0, 100, 200]}
            for _ in range(count)
        ],
    }


def test_mineru_sample_maps_original_pages_and_preserves_inline_semantics():
    spans = [
        {"type": "text", "content": "Use "},
        {"type": "code_inline", "content": "  numpy.mean(x)  "},
        {"type": "equation_inline", "content": r"\pi_\theta (a \mid s)"},
    ]
    raw = {
        "schema": "docvortex.middle",
        "schema_version": "2.0",
        "pages": [
            {
                "page_idx": 0,
                "blocks": [{"type": "text", "bbox": [0.1, 0.2, 0.8, 0.4], "content": spans}],
            },
            {"page_idx": 1, "blocks": []},
        ],
    }
    original = deepcopy(raw)
    blocks, pages, warnings = normalize_mineru(raw, [2, 8], source(10))
    assert pages == [2, 8]
    assert blocks[0]["sourceRefs"][0]["pageIndex"] == 2
    assert blocks[0]["payload"]["content"] == spans
    assert blocks[0]["confidence"] is None
    assert not warnings
    assert raw == original


def test_mineru_nested_caption_page_precision_and_unknown_content_are_retained():
    raw = {
        "schema": "docvortex.middle",
        "schema_version": "2.0",
        "pages": [
            {
                "page_idx": 0,
                "blocks": [
                    {
                        "type": "image",
                        "bbox": [0.1, 0.1, 0.9, 0.8],
                        "content": [
                            {"type": "image_body", "content": "", "image_path": "images/a.jpg"},
                            {
                                "type": "image_caption",
                                "content": [{"type": "text", "content": "Fig. 1"}],
                            },
                        ],
                    },
                    {"type": "future_kind", "content": "Keep unknown items"},
                ],
            },
        ],
    }
    blocks, _, _ = normalize_mineru(raw, [0], source())
    assert len(blocks) == 4
    assert blocks[1]["parentId"] == blocks[0]["id"]
    assert blocks[2]["sourceRefs"][0]["precision"] == "page"
    assert blocks[3]["kind"] == "unknown"
    assert blocks[3]["text"] == "Keep unknown items"


def test_default_preview_or_missing_page_cannot_pass_as_full_success():
    raw = {
        "schema": "docvortex.middle",
        "schema_version": "2.0",
        "pages": [{"page_idx": 0, "blocks": []}],
    }
    document = normalize("mineru", raw, [0, 1, 2], source(), "a" * 64)
    assert document["coverage"] == "full"
    assert document["status"] == "partial"
    assert document["warnings"] == [{"code": "pages_missing", "pageIndices": [1, 2]}]


def test_legacy_mineru_json_is_explicitly_rejected():
    with pytest.raises(ValueError, match="MinerU 4"):
        normalize_mineru({"pdf_info": []}, [0], source())


@pytest.mark.parametrize("page", [{"page_idx": 0}, {"page_idx": 0, "blocks": []}])
def test_present_page_with_native_text_but_no_blocks_is_partial(page):
    s = source(1)
    s["pages"][0]["nativeText"] = "Native text remains visible in the rotated source PDF."
    raw = {"schema": "docvortex.middle", "schema_version": "2.0", "pages": [page]}

    document = normalize("mineru", raw, [0], s, "a" * 64)

    assert document["parsedPageIndices"] == [0]
    assert document["coverage"] == "full"
    assert document["status"] == "partial"
    assert document["warnings"][0]["code"] == "source_text_without_blocks"
    assert document["warnings"][0]["pageIndices"] == [0]


def test_genuinely_blank_page_does_not_become_a_parse_failure():
    s = source(1)
    s["pages"][0]["nativeText"] = " \n\r\t"
    raw = {
        "schema": "docvortex.middle",
        "schema_version": "2.0",
        "pages": [{"page_idx": 0, "blocks": []}],
    }
    document = normalize("mineru", raw, [0], s, "a" * 64)
    assert document["status"] == "complete"
    assert document["warnings"] == []


def test_docling_body_order_furniture_and_orphan_retained_without_mutation():
    raw = {
        "body": {"children": [{"$ref": "#/texts/1"}, {"$ref": "#/texts/0"}]},
        "furniture": {"children": [{"$ref": "#/texts/2"}]},
        "pages": {"1": {"size": {"width": 100, "height": 200}}},
        "texts": [
            {
                "label": "text",
                "text": "Second",
                "prov": [
                    {
                        "page_no": 1,
                        "bbox": {
                            "l": 10,
                            "t": 180,
                            "r": 90,
                            "b": 140,
                            "coord_origin": "BOTTOMLEFT",
                        },
                    }
                ],
            },
            {"label": "section_header", "text": "First", "prov": [{"page_no": 1}]},
            {"label": "page_footer", "text": "Page 1", "prov": [{"page_no": 1}]},
            {"label": "future_kind", "text": "Keep orphan", "prov": []},
        ],
    }
    previous = deepcopy(raw)
    blocks, covered, warnings = normalize_docling(raw, [2], source())
    assert [b["text"] for b in blocks] == ["First", "Second", "Page 1", "Keep orphan"]
    assert blocks[1]["sourceRefs"] == [
        {"pageIndex": 2, "precision": "bbox", "bbox": [0.1, 0.1, 0.9, 0.3]}
    ]
    assert covered == [2]
    assert blocks[2]["scope"] == "furniture"
    assert blocks[3]["scope"] == "orphan"
    assert {w["code"] for w in warnings} == {"unreferenced_item", "source_missing"}
    assert raw == previous


def test_docling_unverified_crop_frame_degrades_to_page_and_warns():
    s = source(1)
    s["pages"][0]["displayCropBox"] = [10, 20, 100, 200]
    raw = {
        "body": {"children": [{"$ref": "#/texts/0"}]},
        "furniture": {"children": []},
        "pages": {"1": {"size": {"width": 100, "height": 200}}},
        "texts": [
            {
                "label": "text",
                "text": "Preserved",
                "prov": [
                    {
                        "page_no": 1,
                        "bbox": {"l": 10, "t": 20, "r": 90, "b": 80, "coord_origin": "TOPLEFT"},
                    }
                ],
            }
        ],
    }
    blocks, _, warnings = normalize_docling(raw, [0], s)
    assert blocks[0]["sourceRefs"][0] == {"pageIndex": 0, "precision": "page", "bbox": None}
    assert warnings[0]["code"] == "bbox_unverified"


def test_docling_figure_labels_keep_parent_relation_instead_of_becoming_body():
    raw = {
        "body": {"children": [{"$ref": "#/pictures/0"}, {"$ref": "#/texts/1"}]},
        "furniture": {"children": []},
        "pages": {"1": {"size": {"width": 100, "height": 200}}},
        "pictures": [
            {"label": "picture", "prov": [{"page_no": 1}], "children": [{"$ref": "#/texts/0"}]}
        ],
        "texts": [
            {"label": "text", "text": "x0", "prov": [{"page_no": 1}]},
            {"label": "text", "text": "Real article paragraph", "prov": [{"page_no": 1}]},
        ],
    }
    blocks, _, _ = normalize_docling(raw, [0], source())
    assert [b["text"] for b in blocks if b["parentId"] is None] == ["", "Real article paragraph"]
    assert blocks[1]["parentId"] == blocks[0]["id"]
    assert blocks[1]["payload"] == raw["texts"][0]

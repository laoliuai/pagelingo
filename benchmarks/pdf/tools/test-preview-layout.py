"""Real PDF regressions for semantic rows, blank rules, colors and footnotes."""

import copy
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from preview_evidence import source_layout
from preview_layout import apply_layout, collect_layout, list_records
from preview_paragraphs import validate_native_ownership
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)


def text_block(index, text, box, kind="text"):
    return {
        "type": kind,
        "index": index,
        "bbox": box,
        "content": [{"type": "text", "content": text}],
    }


class LayoutTests(unittest.TestCase):
    def fixture(self, root):
        writer = PdfWriter()
        font = writer._add_object(
            DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                }
            )
        )
        contents = [
            b"BT /F1 18 Tf 20 380 Td (Notation) Tj ET "
            b"BT /F1 12 Tf 50 320 Td (a) Tj ET BT /F1 12 Tf 120 320 Td (variable) Tj ET "
            b"BT /F1 12 Tf 50 295 Td (b) Tj ET BT /F1 12 Tf 120 295 Td (vector) Tj ET "
            rb"BT /F1 12 Tf 50 270 Td (f\(x\)) Tj ET BT /F1 12 Tf 120 270 Td (function) Tj ET "
            b"BT /F1 12 Tf 50 245 Td (x) Tj ET BT /F1 12 Tf 120 245 Td (input) Tj ET",
            b"BT /F1 12 Tf 30 330 Td (Here) Tj ET "
            b"60 328.5 m 90 328.5 l 0.8 w S "
            b"BT /F1 12 Tf 94 330 Td (answer) Tj ET "
            b"BT /F1 12 Tf 30 280 Td 0 0 1 rg (Input) Tj 0 0 0 rg (: data) Tj ET "
            b"BT /F1 12 Tf 30 240 Td (underlined) Tj ET "
            b"30 238.5 m 88 238.5 l 0.8 w S "
            b"BT /F1 12 Tf 30 210 Td (word) Tj ET "
            b"BT /F1 12 Tf 83 210 Td (next) Tj ET "
            b"30 208.5 m 59 208.5 l 0.8 w S "
            b"59 208.5 m 80 208.5 l 0.8 w S "
            b"80 208.5 m 108 208.5 l 0.8 w S",
            b"BT /F1 9 Tf 30 25 Td (1 Words and punctuation: I, love, food.) Tj ET",
            b"BT /F1 12 Tf 48 350 Td (First line of prose) Tj ET "
            b"BT /F1 12 Tf 30 334 Td (second line of prose.) Tj ET "
            b"BT /F1 12 Tf 30 290 Td (Body text establishes) Tj ET "
            b"BT /F1 12 Tf 30 274 Td (the left body margin.) Tj ET "
            b"BT /F1 12 Tf 60 220 Td (Indented explanation) Tj ET "
            b"BT /F1 12 Tf 60 204 Td (continues at this inset.) Tj ET",
            b"BT /F1 12 Tf 95 350 Td (Original:) Tj ET "
            b"BT /F1 12 Tf 160 350 Td (plain value) Tj ET "
            b"BT /F1 12 Tf 71 325 Td (Unchanged:) Tj ET "
            b"BT /F1 12 Tf 160 325 Td 1 0 0 rg (red) Tj 0 0 0 rg ( value) Tj ET "
            b"BT /F1 12 Tf 95 260 Td (Sequence:) Tj ET "
            b"BT /F1 12 Tf 160 260 Td (linked value) Tj ET "
            b"BT /F1 12 Tf 117 235 Td (Label:) Tj ET "
            b"BT /F1 12 Tf 160 235 Td (IsNext) Tj ET",
        ]
        for content in contents:
            page = writer.add_blank_page(width=300, height=400)
            page[NameObject("/Resources")] = DictionaryObject(
                {
                    NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
                }
            )
            stream = DecodedStreamObject()
            stream.set_data(content)
            page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as target:
            writer.write(target)
        return source, {
            "schema": "docvortex.middle",
            "schema_version": "2.0",
            "is_full_document": True,
            "metadata": {
                "file_suffix": "pdf",
                "producer": {"name": "test-fixture", "version": "1"},
            },
            "pages": [
                {
                    "page_idx": 0,
                    "blocks": [
                        {
                            **text_block(0, "Notation", [0.06, 0.02, 0.4, 0.07], "paragraph_title"),
                            "level": 2,
                        },
                        text_block(
                            1, "a variable b vector f(x) function x input", [0.15, 0.15, 0.7, 0.41]
                        ),
                    ],
                },
                {
                    "page_idx": 1,
                    "blocks": [
                        text_block(0, "Here answer", [0.09, 0.15, 0.6, 0.18]),
                        text_block(1, "Input: data", [0.09, 0.27, 0.5, 0.31]),
                        text_block(2, "underlined", [0.09, 0.37, 0.5, 0.41]),
                        {
                            **text_block(3, "word next", [0.09, 0.46, 0.5, 0.49]),
                            "content": [
                                {"type": "text", "content": "word next", "styles": ["underline"]}
                            ],
                        },
                    ],
                },
                {
                    "page_idx": 2,
                    "blocks": [
                        text_block(0, ", love,", [0.46, 0.914, 0.52, 0.94], "page_footnote"),
                        text_block(
                            1,
                            "1 Words and punctuation: I food.",
                            [0.09, 0.911, 0.68, 0.94],
                            "page_footnote",
                        ),
                    ],
                },
                {
                    "page_idx": 3,
                    "blocks": [
                        text_block(
                            0, "First line of prose second line of prose.", [0.09, 0.09, 0.55, 0.18]
                        ),
                        text_block(
                            1,
                            "Body text establishes the left body margin.",
                            [0.09, 0.25, 0.60, 0.34],
                        ),
                        text_block(
                            2,
                            "Indented explanation continues at this inset.",
                            [0.19, 0.43, 0.67, 0.515],
                        ),
                    ],
                },
                {
                    "page_idx": 4,
                    "blocks": [
                        {
                            **text_block(0, "", [0.23, 0.095, 0.78, 0.2]),
                            "content": [
                                {"type": "text", "content": "Original: plain value "},
                                {
                                    "type": "text",
                                    "content": "Unchanged: red",
                                    "styles": ["underline"],
                                },
                                {"type": "text", "content": " value"},
                            ],
                        },
                        {
                            **text_block(1, "", [0.30, 0.32, 0.80, 0.36]),
                            "content": [
                                {"type": "text", "content": "Sequence: "},
                                {
                                    "type": "hyperlink",
                                    "url": "https://example.com/source",
                                    "content": [{"type": "text", "content": "linked value"}],
                                },
                            ],
                        },
                        text_block(2, "Label: IsNext", [0.37, 0.385, 0.69, 0.42]),
                    ],
                },
            ],
        }

    def render(self, raw, layout):
        soup = BeautifulSoup(
            render_html(MiddleJson.from_dict(raw), mode=RenderMode.FULL, standalone=True),
            "html.parser",
        )
        apply_layout(soup, layout)
        return soup

    def test_pdf_definition_rows_have_independent_selectable_descriptions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            layout, regions = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            soup = self.render(raw, layout)
            self.assertEqual(
                [dd.get_text() for dd in soup.select(".pl-notation dd")],
                ["variable", "vector", "function", "input"],
            )
            self.assertEqual(len(regions), 4)
            self.assertEqual(len(soup.select(".pl-notation dt img")), 4)
            self.assertEqual(regions[2]["source"], "native-pdf-character-bounds")
            self.assertEqual(layout["notation"][0]["rows"][2]["symbolText"], "f(x)")

    def test_empty_rule_is_inserted_but_real_text_underline_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            layout, _ = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            soup = self.render(raw, layout)
            paragraph = soup.select_one('[data-page-idx="1"][data-block-index="0"]')
            self.assertEqual(paragraph.get_text().strip(), "Here____ answer")
            self.assertEqual(len(soup.select(".pl-completion-slot")), 1)
            self.assertFalse(
                soup.select_one('[data-page-idx="1"][data-block-index="2"] .pl-completion-slot')
            )
            self.assertFalse(
                soup.select_one('[data-page-idx="1"][data-block-index="3"] .pl-completion-slot')
            )
            colored = soup.select_one('[data-page-idx="1"][data-block-index="1"] .pl-source-color')
            self.assertEqual(colored.get_text(), "Input")
            self.assertEqual(colored["style"], "color:#0000ff")

    def test_overlapping_footnote_fragment_is_repaired_from_source_not_deleted(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            original = copy.deepcopy(raw)
            layout, _ = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            soup = self.render(raw, layout)
            repair = layout["footnoteRepairs"][0]
            self.assertEqual(repair["removedIndices"], [0])
            self.assertEqual(repair["text"], "1 Words and punctuation: I, love, food.")
            self.assertEqual(len(soup.select('[data-page-idx="2"] .pl-reader-footnote')), 1)
            self.assertEqual(len(original["pages"][2]["blocks"]), 2)
            self.assertEqual(len(raw["pages"][2]["blocks"]), 1)

    def test_native_first_line_and_whole_paragraph_indentation_are_distinct(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            layout, _ = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            records = {
                r["blockIndex"]: r for r in layout["paragraphs"] if r["parsedPageIndex"] == 3
            }
            self.assertAlmostEqual(records[0]["firstLineEm"], 1.5, delta=0.08)
            self.assertEqual(records[0]["leftInsetEm"], 0)
            self.assertAlmostEqual(records[2]["leftInsetEm"], 2.5, delta=0.05)
            self.assertEqual(records[2]["firstLineEm"], 0)
            self.assertNotIn(1, records)
            soup = self.render(raw, layout)
            self.assertEqual(len(soup.select('[data-page-idx="3"].pl-source-paragraph')), 2)
            validate_native_ownership(layout["pages"])

    def test_label_value_rows_preserve_underline_color_and_all_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            layout, _ = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            soup = self.render(raw, layout)
            rows = soup.select('[data-page-idx="4"] .pl-label-row')
            self.assertEqual(
                [r.dt.get_text() for r in rows], ["Original:", "Unchanged:", "Sequence:", "Label:"]
            )
            self.assertEqual(
                [r.dd.get_text() for r in rows],
                ["plain value", "red value", "linked value", "IsNext"],
            )
            self.assertEqual(rows[1].dd.u.get_text(), "red")
            self.assertEqual(rows[1].dd.select_one(".pl-source-color")["style"], "color:#ff0000")
            self.assertTrue(all(r["applied"] for r in layout["definitions"]))
            self.assertEqual(rows[2].dd.a["href"], "https://example.com/source")

    def test_body_sized_italic_sentence_is_an_example_while_true_headings_stay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            writer = PdfWriter()
            fonts = {}
            for key, name in [
                ("F1", "Helvetica"),
                ("F2", "Helvetica-Oblique"),
                ("F3", "Helvetica-Bold"),
            ]:
                descriptor = writer._add_object(
                    DictionaryObject(
                        {
                            NameObject("/Type"): NameObject("/FontDescriptor"),
                            NameObject("/FontName"): NameObject("/" + name),
                            NameObject("/Flags"): NumberObject(96 if key == "F2" else 32),
                            NameObject("/ItalicAngle"): NumberObject(-12 if key == "F2" else 0),
                            NameObject("/FontWeight"): NumberObject(700 if key == "F3" else 400),
                            NameObject("/FontBBox"): ArrayObject(
                                [NumberObject(v) for v in (-166, -225, 1000, 931)]
                            ),
                            NameObject("/Ascent"): NumberObject(718),
                            NameObject("/Descent"): NumberObject(-207),
                            NameObject("/CapHeight"): NumberObject(718),
                            NameObject("/StemV"): NumberObject(88),
                        }
                    )
                )
                fonts[NameObject("/" + key)] = writer._add_object(
                    DictionaryObject(
                        {
                            NameObject("/Type"): NameObject("/Font"),
                            NameObject("/Subtype"): NameObject("/Type1"),
                            NameObject("/BaseFont"): NameObject("/" + name),
                            NameObject("/FontDescriptor"): descriptor,
                        }
                    )
                )
            page = writer.add_blank_page(width=400, height=480)
            page[NameObject("/Resources")] = DictionaryObject(
                {NameObject("/Font"): DictionaryObject(fonts)}
            )
            stream = DecodedStreamObject()
            stream.set_data(
                b"BT /F1 12 Tf 30 430 Td (Body prose establishes the normal size.) Tj ET "
                b"BT /F2 12 Tf 65 380 Td (Calculate the average of 2 and 9.) Tj ET "
                b"BT /F3 16 Tf 30 310 Td (1.2 A Real Heading) Tj ET "
                b"BT /F3 12 Tf 30 250 Td (Calculate a genuinely bold heading.) Tj ET"
            )
            page[NameObject("/Contents")] = writer._add_object(stream)
            source = root / "source.pdf"
            with source.open("wb") as target:
                writer.write(target)
            raw = {
                "schema": "docvortex.middle",
                "schema_version": "2.0",
                "is_full_document": True,
                "metadata": {
                    "file_suffix": "pdf",
                    "producer": {"name": "example-fixture", "version": "1"},
                },
                "pages": [
                    {
                        "page_idx": 0,
                        "blocks": [
                            text_block(
                                0,
                                "Body prose establishes the normal size.",
                                [0.07, 0.075, 0.8, 0.11],
                            ),
                            {
                                **text_block(
                                    1,
                                    "Calculate the average of 2 and 9.",
                                    [0.15, 0.18, 0.75, 0.215],
                                    "paragraph_title",
                                ),
                                "level": 2,
                            },
                            {
                                **text_block(
                                    2,
                                    "1.2 A Real Heading",
                                    [0.07, 0.31, 0.8, 0.36],
                                    "paragraph_title",
                                ),
                                "level": 2,
                            },
                            {
                                **text_block(
                                    3,
                                    "Calculate a genuinely bold heading.",
                                    [0.07, 0.45, 0.8, 0.485],
                                    "paragraph_title",
                                ),
                                "level": 2,
                            },
                        ],
                    }
                ],
            }
            original = copy.deepcopy(raw)
            layout, _ = collect_layout(raw, {"requestedPageIndices": [0]}, source)
            examples = [r for r in layout["inline"] if r.get("exampleAppearance")]
            self.assertEqual([r["blockIndex"] for r in examples], [1])
            self.assertEqual(examples[0]["exampleAppearance"]["fontSize"], 12)
            self.assertEqual(examples[0]["exampleAppearance"]["bodyFontSize"], 12)
            soup = self.render(raw, layout)
            example = soup.select_one(".pl-source-example")
            self.assertEqual(example["data-block-type"], "text")
            self.assertEqual(
                example.select_one("p > em").get_text(), "Calculate the average of 2 and 9."
            )
            self.assertFalse(example.find("h2"))
            self.assertTrue(examples[0]["exampleAppearance"]["applied"])
            self.assertEqual(len(soup.select("h2")), 2)
            self.assertEqual(raw, original)

    def test_uncertain_rows_are_left_intact_and_native_ambiguity_is_recorded(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            raw["pages"][3]["blocks"].append(copy.deepcopy(raw["pages"][3]["blocks"][0]))
            raw["pages"][3]["blocks"][-1]["index"] = 3
            raw["pages"][4]["blocks"][0]["content"][0]["content"] += "missing from PDF "
            layout, _ = collect_layout(raw, {"requestedPageIndices": list(range(5))}, source)
            self.assertTrue(layout["pages"][3]["ambiguousAssignments"])
            self.assertFalse(
                any(
                    r["parsedPageIndex"] == 3 and r["blockIndex"] in {0, 3}
                    for r in layout["paragraphs"]
                )
            )
            soup = self.render(raw, layout)
            self.assertIn("missing from PDF", soup.get_text())
            self.assertFalse(layout["definitions"][0]["applied"])
            self.assertEqual(
                layout["definitions"][0]["reason"], "native-dom-text-coverage-mismatch"
            )
            validate_native_ownership(layout["pages"])

    def test_letter_numbering_and_interleaved_continuation_belong_to_list(self):
        blocks = [
            text_block(0, "(a) First", [0.15, 0.1, 0.8, 0.15]),
            text_block(1, "Indented explanation", [0.19, 0.16, 0.8, 0.2]),
            text_block(2, "(b) Second", [0.15, 0.25, 0.8, 0.3]),
            text_block(3, "(c) Third", [0.15, 0.35, 0.8, 0.4]),
            text_block(4, "Outside prose", [0.1, 0.45, 0.8, 0.5]),
        ]
        layout = {"lists": list_records(blocks, 0, 0), "notation": [], "inline": []}
        self.assertEqual(layout["lists"][0]["items"][0]["continuationBlockIndices"], [1])
        soup = BeautifulSoup(
            '<section data-page-idx="0">'
            + "".join(
                f'<div class="docvortex-block" data-page-idx="0" data-block-index="{b["index"]}">'
                f"<p>{b['content'][0]['content']}</p></div>"
                for b in blocks
            )
            + "</section>",
            "html.parser",
        )
        apply_layout(soup, layout)
        root = soup.select_one(".pl-source-list")
        self.assertEqual(root.name, "ol")
        self.assertIn("lower-alpha", root["style"])
        self.assertEqual(len(root.find_all("li", recursive=False)), 3)
        self.assertIn("Indented explanation", root.li.get_text())
        self.assertNotIn("Outside prose", root.get_text())

    def test_versioned_evidence_has_valid_references_and_rejects_duplicate_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            run = {
                "runId": "fixture",
                "sourceSha256": "0" * 64,
                "requestedPageIndices": list(range(5)),
            }
            layout, _ = collect_layout(raw, run, source)
            self.render(raw, layout)
            evidence = source_layout(run, layout, [])
            self.assertEqual(evidence["status"], "experimental-supplement")
            self.assertTrue(evidence["containers"])
            self.assertTrue(all("nativeCharacterRanges" not in c for c in evidence["containers"]))
            bad = copy.deepcopy(evidence["pages"])
            bad[0]["blocks"][1]["nativeCharacterRanges"].extend(
                bad[0]["blocks"][0]["nativeCharacterRanges"]
            )
            with self.assertRaisesRegex(ValueError, "Overlapping native source ownership"):
                validate_native_ownership(bad)

    def test_nested_list_keeps_text_and_links_and_leaves_prose_outside(self):
        blocks = [
            text_block(0, "• Parent", [0.15, 0.1, 0.8, 0.15]),
            text_block(1, "• Child", [0.20, 0.2, 0.8, 0.25]),
            text_block(2, "• Next", [0.15, 0.3, 0.8, 0.35]),
            text_block(3, "Outside prose", [0.1, 0.4, 0.8, 0.45]),
        ]
        layout = {"lists": list_records(blocks, 0, 0), "notation": [], "inline": []}
        soup = BeautifulSoup(
            """<section data-page-idx="0">
            <div class="docvortex-block" data-page-idx="0" data-block-index="0">
            <p>• Parent</p></div>
            <div class="docvortex-block" data-page-idx="0" data-block-index="1">
            <p>• <a href="#source">Child</a></p></div>
            <div class="docvortex-block" data-page-idx="0" data-block-index="2"><p>• Next</p></div>
            <div class="docvortex-block" data-page-idx="0" data-block-index="3">
            <p>Outside prose</p></div>
            </section>""",
            "html.parser",
        )
        apply_layout(soup, layout)
        root = soup.select_one("section > .pl-source-list")
        self.assertEqual(len(root.find_all("li", recursive=False)), 2)
        self.assertEqual(root.select_one("li > ul > li a").get_text(), "Child")
        self.assertEqual(root.select_one("li > ul > li a")["href"], "#source")
        self.assertNotIn("•", root.get_text())
        self.assertNotIn("Outside prose", root.get_text())


if __name__ == "__main__":
    unittest.main()

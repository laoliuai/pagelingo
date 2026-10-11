"""Real PDF regressions for semantic rows, blank rules, colors and footnotes."""

import copy
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from preview_layout import apply_layout, collect_layout, list_records
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


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
            layout, regions = collect_layout(raw, {"requestedPageIndices": [0, 1, 2]}, source)
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
            layout, _ = collect_layout(raw, {"requestedPageIndices": [0, 1, 2]}, source)
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
            layout, _ = collect_layout(raw, {"requestedPageIndices": [0, 1, 2]}, source)
            soup = self.render(raw, layout)
            repair = layout["footnoteRepairs"][0]
            self.assertEqual(repair["removedIndices"], [0])
            self.assertEqual(repair["text"], "1 Words and punctuation: I, love, food.")
            self.assertEqual(len(soup.select('[data-page-idx="2"] .pl-reader-footnote')), 1)
            self.assertEqual(len(original["pages"][2]["blocks"]), 2)
            self.assertEqual(len(raw["pages"][2]["blocks"]), 1)

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

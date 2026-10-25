"""Native typography and uncertain math tests without retained book data."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from preview_layout import apply_layout, collect_layout
from preview_source import project_source
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


class TypographyTests(unittest.TestCase):
    def fixture(self, root):
        writer = PdfWriter()
        fonts = {}
        for i, name in enumerate(("Helvetica", "Helvetica-Oblique", "Helvetica-Bold", "CMEX10"), 1):
            fonts[NameObject(f"/F{i}")] = writer._add_object(DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/" + name),
            }))
        page = writer.add_blank_page(width=400, height=500)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject(fonts),
        })
        stream = DecodedStreamObject()
        stream.set_data(
            b"BT /F1 12 Tf 40 430 Td (A clear sentence stays ordinary text.) Tj ET "
            b"BT /F2 12 Tf 40 380 Td (A shorter prompt with an italic style.) Tj ET "
            b"BT /F1 12 Tf 40 320 Td (Underline the entire ordinary sentence.) Tj ET "
            b"40 314 m 270 314 l 0.8 w S "
            b"BT /F1 12 Tf 40 260 Td (We can rephrase this instruction into a simpler form) Tj ET "
            b"BT /F3 16 Tf 40 200 Td (4.2 A Real Heading) Tj ET "
            b"BT /F1 12 Tf 140 60 Td (Risk =) Tj ET "
            b"BT /F4 12 Tf 180 60 Td (X) Tj ET"
        )
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        values = [
            ("A clear sentence stays ordinary text.", [0.09, 0.12, 0.9, 0.15], "text"),
            ("A shorter prompt with an italic style.", [0.09, 0.22, 0.9, 0.26], "text"),
            ("Underline the entire ordinary sentence.", [0.09, 0.34, 0.9, 0.38], "text"),
            ("We can rephrase this instruction into a simpler form",
             [0.09, 0.46, 0.9, 0.5], "paragraph_title"),
            ("4.2 A Real Heading", [0.09, 0.56, 0.9, 0.62], "paragraph_title"),
            ("Risk = X", [0.34, 0.85, 0.6, 0.91], "page_footnote"),
        ]
        blocks = [{
            "index": i, "type": kind, "bbox": box,
            "content": [{"type": "text", "content": value}],
            **({"level": 2} if kind == "paragraph_title" else {}),
        } for i, (value, box, kind) in enumerate(values)]
        blocks[0]["content"][0]["styles"] = ["bold"]
        blocks[2]["content"] = [
            {"type": "text", "content": "Underline", "styles": ["underline"]},
            {"type": "text", "content": " the entire ordinary sentence."},
        ]
        return source, {
            "schema": "docvortex.middle", "schema_version": "2.0", "is_full_document": True,
            "metadata": {"file_suffix": "pdf", "producer": {"name": "typography", "version": "1"}},
            "pages": [{"page_idx": 0, "blocks": blocks}],
        }

    def process(self, root):
        source, raw = self.fixture(root)
        layout, _ = collect_layout(raw, {"requestedPageIndices": [0]}, source)
        soup = BeautifulSoup(render_html(MiddleJson.from_dict(raw), mode=RenderMode.FULL),
                             "html.parser")
        apply_layout(soup, layout)
        return source, raw, soup, layout

    def test_regular_native_text_does_not_inherit_parser_bold(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, _, soup, _ = self.process(Path(temporary))
            self.assertFalse(soup.select_one('[data-block-index="0"]').find("strong"))
            self.assertTrue(soup.select_one('[data-block-index="4"]').find("h2"))

    def test_native_italic_and_full_length_low_underline_are_restored(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, _, soup, _ = self.process(Path(temporary))
            self.assertEqual(soup.select_one('[data-block-index="1"] em').get_text(),
                             "A shorter prompt with an italic style.")
            paragraph = soup.select_one('[data-block-index="2"] p')
            self.assertTrue(all(
                leaf.find_parent("u") for leaf in paragraph.strings if leaf.strip()
            ))
            self.assertFalse(paragraph.select(".pl-completion-slot"))

    def test_a_regular_sentence_can_end_without_punctuation_and_stays_body_sized(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, _, soup, _ = self.process(Path(temporary))
            node = soup.select_one('[data-block-index="3"]')
            self.assertEqual(node["data-block-type"], "text")
            self.assertIsNotNone(node.p)
            self.assertIsNone(node.find("h2"))

    def test_invalid_embedded_weight_cannot_make_regular_glyphs_bold(self):
        with tempfile.TemporaryDirectory() as temporary, patch(
            "preview_typography.pdfium.raw.FPDFText_GetFontWeight", return_value=1472
        ):
            _, _, soup, _ = self.process(Path(temporary))
            self.assertFalse(soup.select_one('[data-block-index="0"]').find("strong"))
            self.assertTrue(soup.select_one('[data-block-index="4"]').find("h2"))

    def test_an_extension_font_letter_in_a_footnote_keeps_the_original_region(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            _, protected = project_source(raw, {"requestedPageIndices": [0]}, source)
            self.assertEqual(list(protected), [(0, 5)])
            record = protected[(0, 5)]
            self.assertEqual(record["reason"], "unmapped-native-math-operator")
            self.assertEqual(record["nativeGlyphEvidence"][0]["unicode"], "X")

    def test_a_wide_prose_footnote_is_not_rasterized_by_a_local_math_glyph(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            raw["pages"][0]["blocks"][5]["bbox"] = [0.1, 0.85, 0.9, 0.91]
            _, protected = project_source(raw, {"requestedPageIndices": [0]}, source)
            self.assertEqual(protected, {})


if __name__ == "__main__":
    unittest.main()

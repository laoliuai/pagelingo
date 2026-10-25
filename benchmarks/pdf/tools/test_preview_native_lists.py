"""Round markers omitted by a parser still require exact native text evidence."""

import copy
import tempfile
import unittest
from pathlib import Path

import pypdfium2 as pdfium
from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from preview_layout import apply_layout, collect_layout
from preview_lists import recover_list_markers
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


class NativeListTests(unittest.TestCase):
    def fixture(self, root, hanging=True):
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=400)
        font = writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }))
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
        })
        stream = DecodedStreamObject()
        stream.set_data(
            b"BT /F1 10 Tf 40 350 Td (\225) Tj ET "
            b"BT /F1 10 Tf 50 350 Td (A native list item keeps all its words.) Tj ET "
            + (f"BT /F1 10 Tf {50 if hanging else 40} 335 Td (Its continuation is aligned.) Tj ET "
               "BT /F1 10 Tf 40 300 Td (\\225) Tj ET "
               "BT /F1 10 Tf 50 300 Td (Another list item.) Tj ET").encode()
        )
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        blocks = [
            {"type": "text", "index": 0, "bbox": [0.12, 0.10, 0.9, 0.18], "content": [
                {"type": "text", "content": "A native list item keeps all its words. "
                 "Its continuation is aligned."}]},
            {"type": "text", "index": 1, "bbox": [0.12, 0.22, 0.9, 0.26], "content": [
                {"type": "text", "content": "• Another list item."}]},
        ]
        return source, {
            "schema": "docvortex.middle", "schema_version": "2.0", "is_full_document": True,
            "metadata": {"file_suffix": "pdf", "producer": {"name": "native-list", "version": "1"}},
            "pages": [{"page_idx": 0, "blocks": blocks}],
        }

    def recover(self, source, blocks):
        from preview_layout import native_chars

        with pdfium.PdfDocument(source) as pdf:
            page = pdf[0]
            textpage = page.get_textpage()
            try:
                return recover_list_markers(blocks, native_chars(page, textpage))
            finally:
                textpage.close()
                page.close()

    def test_missing_native_bullet_joins_the_existing_list_without_losing_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            layout, _ = collect_layout(raw, {"requestedPageIndices": [0]}, source)
            soup = BeautifulSoup(render_html(MiddleJson.from_dict(raw), mode=RenderMode.FULL),
                                 "html.parser")
            apply_layout(soup, layout)
            items = soup.select(".pl-source-list > li")
            self.assertEqual(len(items), 2)
            self.assertEqual(items[0].get_text(strip=True),
                             "A native list item keeps all its words. Its continuation is aligned.")
            self.assertEqual(items[1].get_text(strip=True), "Another list item.")
            self.assertEqual(layout["lists"][0]["items"][0]["nativeMarkerRepair"]["marker"], "•")
            self.assertEqual(self.recover(source, raw["pages"][0]["blocks"]), {})

    def test_text_mismatch_or_missing_hanging_indent_cannot_create_a_list_marker(self):
        for hanging in (True, False):
            with self.subTest(hanging=hanging), tempfile.TemporaryDirectory() as temporary:
                source, raw = self.fixture(Path(temporary), hanging=hanging)
                if hanging:
                    raw["pages"][0]["blocks"][0]["content"][0]["content"] += " EXTRA"
                before = copy.deepcopy(raw)
                self.assertEqual(self.recover(source, raw["pages"][0]["blocks"]), {})
                self.assertEqual(raw, before)

    def test_an_overlapping_owner_prevents_marker_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            blocks = raw["pages"][0]["blocks"]
            blocks.append({"type": "page_footnote", "index": 2, "bbox": [0.12, 0.10, 0.15, 0.15],
                           "content": [{"type": "text", "content": "A separate region"}]})
            self.assertEqual(self.recover(source, blocks), {})


if __name__ == "__main__":
    unittest.main()

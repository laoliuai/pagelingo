"""Dense unparsed footnote math needs original source, not bounded prose repair."""

import copy
import tempfile
import unittest
from pathlib import Path

from preview_source import project_source
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


class FootnoteBandTests(unittest.TestCase):
    def fixture(self, root, *, divider=True, math=True):
        writer = PdfWriter()
        page = writer.add_blank_page(width=400, height=500)
        fonts = {}
        for i, name in enumerate(("Helvetica", "CMEX10" if math else "Helvetica"), 1):
            fonts[NameObject(f"/F{i}")] = writer._add_object(DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/" + name),
            }))
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject(fonts),
        })
        stream = DecodedStreamObject()
        stream.set_data(
            (b"40 220 m 200 220 l 0.6 w S " if divider else b"")
            + b"BT /F1 10 Tf 40 300 Td (The body remains ordinary text.) Tj ET "
            b"BT /F1 9 Tf 40 205 Td (A note with a displayed equation.) Tj ET "
            b"BT /F2 12 Tf 100 170 Td (h P X h P X) Tj ET "
            b"BT /F1 9 Tf 40 100 Td (The note continues after the formula.) Tj ET"
        )
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        boxes = [
            [0.09, 0.575, 0.9, 0.60], [0.09, 0.62, 0.9, 0.70],
            [0.24, 0.635, 0.28, 0.675], [0.30, 0.635, 0.34, 0.675],
            [0.36, 0.635, 0.40, 0.675], [0.09, 0.73, 0.9, 0.84],
            [0.30, 0.78, 0.34, 0.82], [0.36, 0.78, 0.40, 0.82],
        ]
        blocks = [{"type": "page_footnote", "index": i, "bbox": box,
                   "content": [{"type": "text", "content": f"Fragment {i}"}]}
                  for i, box in enumerate(boxes)]
        blocks.append({"type": "text", "index": 8, "bbox": [0.09, 0.37, 0.9, 0.42],
                       "content": [{"type": "text", "content": "The body remains ordinary text."}]})
        return source, {"pages": [{"page_idx": 0, "blocks": blocks}]}

    def test_fragmented_footnote_becomes_one_protected_band_with_full_original_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.fixture(Path(temporary))
            original = copy.deepcopy(raw)
            _, protected = project_source(raw, {"requestedPageIndices": [0]}, source)
            self.assertEqual(list(protected), [(0, 0)])
            record = protected[(0, 0)]
            self.assertEqual(record["reason"], "unparsed-dense-footnote-math")
            self.assertEqual(record["blockIndices"], list(range(8)))
            self.assertEqual(record["originalBlocks"], original["pages"][0]["blocks"][:8])
            self.assertGreaterEqual(len(record["nativeGlyphEvidence"]), 6)
            self.assertTrue(0.55 < record["bbox"][1] <= 0.56)
            self.assertEqual([b["index"] for b in raw["pages"][0]["blocks"]], [0, 8])
            self.assertEqual(raw["pages"][0]["blocks"][-1], original["pages"][0]["blocks"][-1])

    def test_source_divider_and_multiple_unmapped_math_glyphs_are_both_required(self):
        for option in ("divider", "math"):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as temporary:
                source, raw = self.fixture(Path(temporary), **{option: False})
                original = copy.deepcopy(raw)
                _, protected = project_source(raw, {"requestedPageIndices": [0]}, source)
                self.assertFalse(any(r["reason"] == "unparsed-dense-footnote-math"
                                     for r in protected.values()))
                self.assertEqual(raw, original)

    def test_structured_formulas_or_body_overlap_prevent_whole_band_protection(self):
        for structured in (True, False):
            with self.subTest(structured=structured), tempfile.TemporaryDirectory() as temporary:
                source, raw = self.fixture(Path(temporary))
                blocks = raw["pages"][0]["blocks"]
                if structured:
                    blocks[1]["content"] = [{"type": "equation_inline", "content": r"\sum_i x_i"}]
                else:
                    blocks[-1]["bbox"] = [0.09, 0.64, 0.9, 0.66]
                original = copy.deepcopy(raw)
                _, protected = project_source(raw, {"requestedPageIndices": [0]}, source)
                self.assertFalse(any(r["reason"] == "unparsed-dense-footnote-math"
                                     for r in protected.values()))
                self.assertEqual(raw, original)


if __name__ == "__main__":
    unittest.main()

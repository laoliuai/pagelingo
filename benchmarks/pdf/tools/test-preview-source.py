"""Real PDF regression for painted text panels and uncertain-glyph protection."""

import copy
import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup
from preview_source import apply_callouts, project_source
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject


class SourceProjectionTests(unittest.TestCase):
    def fixture(self, root, body_color="0.97647"):
        writer = PdfWriter()
        page = writer.add_blank_page(width=200, height=300)
        stream = DecodedStreamObject()
        stream.set_data(f"0.4 g 20 40 160 210 re f {body_color} g 20.5 40.5 159 188 re f".encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
        path = root / "source.pdf"
        with path.open("wb") as target:
            writer.write(target)
        # Coordinates are independently specified in the displayed top-left frame.
        return path, {
            "pages": [
                {
                    "page_idx": 0,
                    "blocks": [
                        {
                            "type": "paragraph_title",
                            "index": 0,
                            "bbox": [0.15, 55 / 300, 0.4, 70 / 300],
                            "content": [{"type": "text", "content": "Example"}],
                        },
                        {
                            "type": "text",
                            "index": 1,
                            "bbox": [0.15, 85 / 300, 0.85, 100 / 300],
                            "content": [{"type": "text", "content": "Inside the panel"}],
                        },
                        {
                            "type": "text",
                            "index": 2,
                            "bbox": [0.15, 275 / 300, 0.85, 290 / 300],
                            "content": [{"type": "text", "content": "Outside the panel"}],
                        },
                    ],
                }
            ]
        }

    def test_titled_panel_keeps_html_text_and_does_not_absorb_outside_prose(self):
        for body_color, expected in [("0.97647", [249, 249, 249]), ("1", [255, 255, 255])]:
            with self.subTest(body_color=body_color), tempfile.TemporaryDirectory() as temporary:
                path, raw = self.fixture(Path(temporary), body_color)
                callouts, protected = project_source(raw, {"requestedPageIndices": [0]}, path)
                self.assertEqual(protected, {})
                self.assertEqual(len(callouts), 1)
                self.assertEqual(callouts[0]["blockIndices"], [0, 1])
                self.assertEqual(callouts[0]["bodyColor"], expected)
                self.assertEqual(callouts[0]["headerBlockIndex"], 0)
                soup = BeautifulSoup(
                    """<section>
                  <div class="docvortex-block" data-page-idx="0" data-block-index="0">
                    <h2>Example</h2></div>
                  <div class="docvortex-block" data-page-idx="0" data-block-index="1">
                    <p>Inside the panel</p></div>
                  <div class="docvortex-block" data-page-idx="0" data-block-index="2">
                    <p>Outside the panel</p></div></section>""",
                    "html.parser",
                )
                apply_callouts(soup, callouts)
                self.assertEqual(len(soup.select(".pl-callout")), 1)
                self.assertIn("Inside the panel", soup.select_one(".pl-callout").get_text())
                self.assertNotIn("Outside the panel", soup.select_one(".pl-callout").get_text())
                self.assertEqual(soup.select_one(".pl-callout-title h2").get_text(), "Example")
                self.assertEqual(len(soup.select(".docvortex-block")), 3)
                self.assertEqual(soup.select_one(".pl-callout").name, "section")
                self.assertFalse(soup.select("aside .docvortex-block"))

    def test_figure_shading_is_not_treated_as_a_text_panel(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, raw = self.fixture(Path(temporary))
            raw["pages"][0]["blocks"][1]["type"] = "image"
            callouts, _ = project_source(raw, {"requestedPageIndices": [0]}, path)
            self.assertEqual(callouts, [])

    def test_corrupt_formula_is_protected_but_code_whitespace_is_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, raw = self.fixture(Path(temporary))
            raw["pages"][0]["blocks"][1]["content"] = [
                {"type": "text", "content": "Vπ(s) = Eπ[ R \f\f S = s\x03"}
            ]
            raw["pages"][0]["blocks"][2].update(
                {"type": "code", "sub_type": "code", "content": "for x in xs:\n\tprint(x)"}
            )
            original = copy.deepcopy(raw)
            _, protected = project_source(raw, {"requestedPageIndices": [0]}, path)
            self.assertEqual(list(protected), [(0, 1)])
            self.assertEqual(protected[(0, 1)]["invalidGlyphCodes"], ["U+0003", "U+000C"])
            self.assertEqual(raw, original)

    def test_unknown_math_subscript_uses_original_but_plain_questions_do_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            path, raw = self.fixture(Path(temporary))
            raw["pages"][0]["blocks"][1]["content"] = [
                {"type": "equation_inline", "content": r"V^{\pi} {}_{?}^{\gamma}"}
            ]
            raw["pages"][0]["blocks"][2]["content"] = [
                {"type": "text", "content": "Which state?"},
                {"type": "equation_inline", "content": r"V^{\pi}(s)"},
            ]
            _, protected = project_source(raw, {"requestedPageIndices": [0]}, path)
            self.assertEqual(list(protected), [(0, 1)])
            self.assertEqual(protected[(0, 1)]["reason"], "uncertain-math-punctuation")


if __name__ == "__main__":
    unittest.main()

"""Merged template panels and colored empty answer slots, using generated PDFs."""

import tempfile
import unittest
from pathlib import Path

from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from pagelingo_parser.files import digest
from preview_evidence import source_layout
from preview_layout import apply_layout, collect_layout
from preview_prompts import apply_prompts, ensure_prompt_callouts, prepare_prompts
from preview_source import apply_callouts, project_source
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


class PanelFragmentTests(unittest.TestCase):
    def fixture(self, root, suffix="", language="txt"):
        writer = PdfWriter()
        page = writer.add_blank_page(width=400, height=500)
        font = writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }))
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
        })
        commands, texts = [], []
        for i, verb in enumerate(("Explain", "Simplify", "Summarize")):
            shift = 140 * i
            commands.append(f"0.95 g 20 {360-shift} 360 100 re f ")
            if i < 2:
                color = "1 0 0" if i == 0 else "0 0 1"
                commands.append(f"{color} rg 50 {381-shift} 40 14 re f ")
            commands.append(
                f"0 g BT /F1 12 Tf 50 {430-shift} Td ({verb} the following passage.) Tj ET "
                f"BT /F1 12 Tf 50 {400-shift} Td ({{*passage*}}) Tj ET "
                f"50 {380-shift} m 90 {380-shift} l 0.8 w S "
            )
            texts.extend((verb + " the following passage.", "{*passage*}"))
        stream = DecodedStreamObject()
        stream.set_data("".join(commands).encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        box = [0.045, 0.07, 0.96, 0.84]
        raw = {
            "schema": "docvortex.middle", "schema_version": "2.0", "is_full_document": True,
            "metadata": {"file_suffix": "pdf", "producer": {"name": "templates", "version": "1"}},
            "pages": [{"page_idx": 0, "blocks": [{
                "index": 0, "type": "code", "sub_type": "code", "guess_lang": language,
                "bbox": box, "content": [{"index": 0, "type": "code_body", "bbox": box,
                                         "content": "\n".join(texts) + suffix}],
            }]}],
        }
        run = {"runId": "panel-fragments", "sourceSha256": digest(source),
               "requestedPageIndices": [0]}
        return source, raw, run

    def process(self, root):
        source, raw, run = self.fixture(root)
        prompts = prepare_prompts(raw, run, source)
        callouts, _ = project_source(raw, run, source)
        ensure_prompt_callouts(callouts, prompts["prompts"])
        indices = {(0, i) for r in prompts["prompts"] for i in r["blockIndices"]}
        layout, _ = collect_layout(raw, run, source, callouts, indices)
        layout.update(prompts)
        soup = BeautifulSoup(render_html(MiddleJson.from_dict(raw), mode=RenderMode.FULL),
                             "html.parser")
        apply_callouts(soup, callouts)
        apply_layout(soup, layout)
        apply_prompts(soup, prompts)
        evidence = source_layout(run, layout, callouts)
        return soup, raw, prompts, evidence

    def test_three_native_panels_remain_distinct_without_renumbering_the_parser_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, raw, prompts, evidence = self.process(Path(temporary))
            self.assertEqual(len(soup.select(".pl-callout")), 3)
            self.assertEqual([len(p.select("p")) for p in soup.select(".pl-prompt")], [3, 3, 3])
            self.assertEqual([b["index"] for b in raw["pages"][0]["blocks"]], [0])
            self.assertTrue(all(r["splitFromParserBlocks"] for r in prompts["prompts"]))
            self.assertEqual(len(evidence["pages"][0]["readingOrder"]), 1)
            self.assertEqual(len(soup.select(".pl-prompt-placeholder")), 3)

    def test_empty_answer_slots_keep_their_painted_backgrounds(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, _, _, _ = self.process(Path(temporary))
            slots = soup.select(".pl-completion-slot")
            self.assertEqual(len(slots), 3)
            self.assertIn("background-color:#ff0000", slots[0]["style"])
            self.assertIn("background-color:#0000ff", slots[1]["style"])
            self.assertNotIn("background-color", slots[2]["style"])

    def test_uncovered_parser_text_or_a_real_code_language_prevents_splitting(self):
        for suffix, language in ((" unexplained extra text", "txt"), ("", "python")):
            with self.subTest(language=language), tempfile.TemporaryDirectory() as temporary:
                source, raw, run = self.fixture(Path(temporary), suffix, language)
                self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])
                self.assertEqual(raw["pages"][0]["blocks"][0]["type"], "code")


if __name__ == "__main__":
    unittest.main()

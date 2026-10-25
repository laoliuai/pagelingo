"""Native text coverage and field-template ordering, using generated PDFs."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from pagelingo_parser.files import digest
from preview_evidence import source_layout
from preview_layout import apply_layout, collect_layout
from preview_paragraphs import source_lines
from preview_prompts import apply_prompts, ensure_prompt_callouts, prepare_prompts, reconstruct_rows
from preview_source import apply_callouts, project_source
from preview_validation import check_prompt_coverage
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def text(index, value, box, kind="text"):
    return {
        "type": kind, "index": index, "bbox": box,
        "content": [{"type": "text", "content": value}],
    }


class PanelCoverageTests(unittest.TestCase):
    def test_wrapped_cjk_prose_does_not_gain_spaces_inside_a_word(self):
        page = Mock()
        page.get_width.return_value = 400
        page.get_height.return_value = 500
        for original in ("中文段落", "中文 段落"):
            with self.subTest(original=original):
                chars = []
                for row, value in enumerate(("中文", "段落")):
                    baseline = 0.22 + row * 0.026
                    for column, char in enumerate(value):
                        x = 0.1 + column * 0.03
                        chars.append({
                            "index": len(chars), "text": char, "color": [0, 0, 0, 255],
                            "bbox": [x, baseline - 0.024, x + 0.03, baseline],
                            "x": x + 0.015, "y": baseline - 0.012,
                            "baseline": [x, baseline], "fontSize": 12, "pageHeight": 500,
                        })
                rows, _, _ = reconstruct_rows(chars, source_lines(chars), [], original, page)
                self.assertEqual([r["text"] for r in rows], [original])

    def fixture(self, root, *, template=False, extra=False, columns=False, variables=True):
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
        commands = ["0.95 g 20 80 360 320 re f 0 g "]

        def line(x, y, value, gray=False):
            commands.append(
                f"{'0.5' if gray else '0'} g BT /F1 11 Tf {x} {y} Td ({value}) Tj ET "
            )

        if template:
            input_value = "{*sentence*}" if variables else "A sample sentence."
            output_value = "{*answer*}" if variables else "An example answer."
            for y, label, body in (
                (360, "Instruction", "Translate this sentence into another language."),
                (325, "User Input", input_value),
                (290, "Output", output_value),
            ):
                line(30, y, label, gray=True)
                line(110, y, body)
            commands.append("0 g 110 287 m 166 287 l 0.8 w S ")
            line(30, 450, "Introduce the following template.")
            line(30, 50, "Continue after this example.")
            box = [0.07, 0.26, 0.94, 0.44]
            blocks = [
                {"type": "code", "index": 0, "sub_type": "code", "guess_lang": "txt",
                 "bbox": box, "content": [{"type": "code_body", "index": 0, "bbox": box,
                    "content": "Instruction Translate this sentence into another language.\n"
                    f"User Input {input_value}\nOutput {output_value}"}]},
                text(1, "Introduce the following template.", [0.07, 0.08, 0.8, 0.11]),
                text(2, "Continue after this example.", [0.07, 0.88, 0.8, 0.91]),
            ]
        else:
            line(50, 360, "Explain the following computation:")
            line(50, 330, "First:")
            line(50, 310, "Numbers can be added in several useful ways.")
            line(200 if columns else 50, 260, "Second:")
            line(50, 240, "This answer is supported by a detailed example.")
            if extra:
                line(50, 200, "An unanchored extra paragraph.")
            blocks = [
                text(0, "Explain the following computation:", [0.12, 0.26, 0.9, 0.29]),
                text(1, "umbers can be added in several useful ways.", [0.12, 0.36, 0.9, 0.39]),
                text(2, "This answer is supported by a detailed example.", [0.12, 0.50, 0.9, 0.53]),
            ]
        stream = DecodedStreamObject()
        stream.set_data("".join(commands).encode())
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        raw = {
            "schema": "docvortex.middle", "schema_version": "2.0", "is_full_document": True,
            "metadata": {"file_suffix": "pdf", "producer": {"name": "coverage", "version": "1"}},
            "pages": [{"page_idx": 0, "blocks": blocks}],
        }
        run = {"runId": "panel-coverage", "sourceSha256": digest(source),
               "requestedPageIndices": [0]}
        return source, raw, run

    def render(self, source, raw, run):
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
        return soup, prompts, source_layout(run, layout, callouts)

    def test_missing_labels_and_first_letter_are_restored_from_native_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw, run = self.fixture(Path(temporary))
            original_hash = digest(source)
            soup, prompts, evidence = self.render(source, raw, run)
            self.assertEqual([p.get_text() for p in soup.select(".pl-prompt-line")], [
                "Explain the following computation:", "First:",
                "Numbers can be added in several useful ways.", "Second:",
                "This answer is supported by a detailed example.",
            ])
            repair = prompts["prompts"][0]["nativeCoverageRepair"]
            self.assertEqual(repair["method"], "native-labeled-panel-text-coverage")
            self.assertEqual([r["blockIndex"] for r in repair["blockRepairs"]], [1, 2])
            self.assertEqual([b["index"] for b in raw["pages"][0]["blocks"]], [0, 1, 2])
            self.assertEqual(evidence["pages"][0]["unassignedCharacterRanges"], [])
            self.assertEqual(digest(source), original_hash)

    def test_native_text_audit_rejects_missing_labels_and_duplicated_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, raw, run = self.fixture(root)
            soup, _, evidence = self.render(source, raw, run)
            preview = {"pages": [{"sourcePageIndex": 0, "path": "page.html"}]}
            (root / "page.html").write_text(str(soup))
            self.assertEqual(check_prompt_coverage(root, preview, evidence)["panelsChecked"], 1)
            for wrong in (str(soup).replace("First:", ""),
                          str(soup).replace("First:", "First: First:")):
                (root / "page.html").write_text(wrong)
                with self.assertRaisesRegex(ValueError, "Native prompt text differs"):
                    check_prompt_coverage(root, preview, evidence)

    def test_interior_character_changes_or_extra_parser_text_reject_recovery(self):
        for wrong in ("Numbers can be altered in several useful ways.",
                      "umbers can be added in several useful ways. EXTRA"):
            with self.subTest(wrong=wrong), tempfile.TemporaryDirectory() as temporary:
                source, raw, run = self.fixture(Path(temporary))
                raw["pages"][0]["blocks"][1]["content"][0]["content"] = wrong
                self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])

    def test_unanchored_prose_or_separate_columns_reject_recovery(self):
        for option in ("extra", "columns"):
            with self.subTest(option=option), tempfile.TemporaryDirectory() as temporary:
                source, raw, run = self.fixture(Path(temporary), **{option: True})
                self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])

    def test_competing_native_ownership_rejects_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw, run = self.fixture(Path(temporary))
            raw["pages"][0]["blocks"].append(
                text(3, "A separate overlapping region", [0.01, 0.30, 0.96, 0.35])
            )
            self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])

    def test_variable_template_retains_roles_and_is_between_its_surrounding_paragraphs(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw, run = self.fixture(Path(temporary), template=True)
            soup, prompts, evidence = self.render(source, raw, run)
            self.assertEqual([p.get_text() for p in soup.select(".pl-prompt-role")],
                             ["Instruction", "User Input", "Output"])
            visible = soup.select_one("article").get_text(" ", strip=True)
            self.assertLess(visible.index("Introduce"), visible.index("Instruction"))
            self.assertLess(visible.index("Instruction"), visible.index("Continue"))
            self.assertEqual(visible.count("Instruction"), 1)
            self.assertEqual(prompts["prompts"][0]["readingOrderRepair"]["after"], [1, 0, 2])
            self.assertEqual(evidence["pages"][0]["readingOrder"], [
                "panel-coverage/p0/b1", "panel-coverage/p0/b0", "panel-coverage/p0/b2",
            ])
            self.assertIsNotNone(soup.select_one(".pl-prompt-placeholder u"))

    def test_gray_field_labels_without_variable_values_are_not_treated_as_roles(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw, run = self.fixture(Path(temporary), template=True, variables=False)
            self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])

    def test_template_with_parser_mismatch_or_real_code_language_is_not_rewritten(self):
        for mismatch in (True, False):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as temporary:
                source, raw, run = self.fixture(Path(temporary), template=True)
                block = raw["pages"][0]["blocks"][0]
                if mismatch:
                    block["content"][0]["content"] += " unexplained extra text"
                else:
                    block["guess_lang"] = "python"
                self.assertEqual(prepare_prompts(raw, run, source)["prompts"], [])


if __name__ == "__main__":
    unittest.main()

"""Real-PDF prompt regressions independent of retained book inputs or models."""

import copy
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


def text(index, value, bbox, kind="text"):
    if kind == "code":
        return {
            "index": index,
            "type": kind,
            "bbox": bbox,
            "sub_type": "code",
            "guess_lang": "txt",
            "content": [{"type": "code_body", "index": index, "bbox": bbox, "content": value}],
        }
    return {
        "index": index,
        "type": kind,
        "bbox": bbox,
        "content": [{"type": "text", "content": value}],
    }


class PromptTests(unittest.TestCase):
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
        streams = [
            b"0.95 g 30 305 240 75 re f 0 g "
            b"BT /F1 12 Tf 0.8 0 0 rg 50 350 Td (Please suggest a fun weekend.) Tj ET 0 g "
            b"0.8 w 50 347 m 86 347 l S 50 328 m 75 328 l S "
            b"BT /F1 10 Tf 50 230 Td (premise = the weather is nice this weekend,) Tj ET",
            b"0.95 g 30 290 240 90 re f 30 145 240 55 re f 0 g "
            b"BT /F1 12 Tf 50 350 Td (Here is a sentence) Tj ET "
            b"BT /F1 12 Tf 50 328 Td ({*sentence*}) Tj ET "
            b"50 305 m 75 305 l 0.8 w S "
            b"BT /F1 12 Tf 40 250 Td (This introduces the question.) Tj ET "
            b"BT /F1 12 Tf 50 180 Td (Q: {*question*}) Tj ET "
            b"BT /F1 12 Tf 50 162 Td (A:) Tj ET 0.8 w 66 160 m 91 160 l S",
            b"0.95 g 30 245 240 135 re f 0 g "
            b"BT /F1 8 Tf 0.5 g 40 350 Td (SYSTEM) Tj ET 0 g "
            b"BT /F1 12 Tf 110 350 Td (You help with grammar.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 50 322 Td (USER) Tj ET 0 g "
            b"BT /F1 12 Tf 110 322 Td (Please correct this sentence.) Tj ET "
            b"BT /F1 12 Tf 110 299 Td (Input: A sample.) Tj ET "
            b"BT /F1 12 Tf 110 278 Td (Output:) Tj ET 0.8 w 155 276 m 180 276 l S",
            b"0.95 g 30 285 240 95 re f 0 g "
            b"BT /F1 8 Tf 0.5 g 50 350 Td (DEMO) Tj ET 0 g "
            b"BT /F1 12 Tf 110 350 Td (First example.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 50 322 Td (USER) Tj ET 0 g "
            b"BT /F1 12 Tf 110 322 Td ({*input*}) Tj ET "
            b"110 300 m 135 300 l 0.8 w S",
            b"0.95 g 30 285 240 95 re f 0 g "
            rb"BT /F1 12 Tf 50 350 Td (def train\(\):) Tj ET "
            b"BT /F1 12 Tf 60 330 Td (return 1) Tj ET "
            b"BT /F1 12 Tf 50 230 Td (x = a + b) Tj ET "
            b"BT /F1 12 Tf 50 200 Td (signal = a b c d) Tj ET",
            b"0.95 g 30 305 240 75 re f 0 g "
            b"BT /F1 12 Tf 50 350 Td (Important) Tj ET "
            b"BT /F1 12 Tf 125 350 Td (term) Tj ET "
            b"0.8 w 50 347 m 105 347 l S 105 347 m 125 347 l S "
            b"125 347 m 151 347 l S",
            b"0.95 g 30 280 240 100 re f 30 120 240 100 re f 0 g "
            rb"BT /F1 12 Tf 50 350 Td (def train\(\):) Tj ET "
            b"BT /F1 12 Tf 60 330 Td (return 1) Tj ET "
            b"0.8 w 60 300 m 85 300 l S "
            b"BT /F1 12 Tf 50 200 Td (Explain this equation) Tj ET "
            b"BT /F1 12 Tf 50 180 Td (x = y) Tj ET "
            b"0.8 w 50 150 m 75 150 l S",
            b"0.95 g 30 240 240 140 re f "
            b"0.6 0.96 0.68 rg 50 345 40 15 re f 90 345 130 15 re f 0 g "
            b"BT /F1 12 Tf 50 350 Td (Classify the following text.) Tj ET "
            b"BT /F1 12 Tf 50 326 Td (Text:) Tj ET "
            b"BT /F1 12 Tf 50 305 Td (The service was slow.) Tj ET "
            b"BT /F1 12 Tf 50 276 Td (The polarity is negative) Tj ET "
            b"0.8 w 130 273 m 177 273 l S",
            b"0.95 g 30 105 240 275 re f 0 g "
            b"BT /F1 8 Tf 0.5 g 40 350 Td (DEMO) Tj ET 0 g "
            b"BT /F1 12 Tf 110 350 Td (Q: Jerry games?) Tj ET "
            b"BT /F1 12 Tf 110 320 Td (A: Jerry plays 96 hours.) Tj ET "
            b"BT /F1 12 Tf 110 290 Td (Q: Mary apples?) Tj ET "
            b"BT /F1 12 Tf 110 260 Td (A: Mary eats 2 apples.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 50 230 Td (USER) Tj ET 0 g "
            b"BT /F1 12 Tf 110 230 Td (Q: Boris apples?) Tj ET "
            b"BT /F1 12 Tf 110 200 Td (A: Boris has 3 fewer.) Tj ET",
            b"0.95 g 30 140 240 240 re f 0 g "
            b"BT /F1 12 Tf 40 366 Td (Read first.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 40 340 Td (TASK) Tj ET 0 g "
            b"BT /F1 12 Tf 110 340 Td (Decompose a problem.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 40 310 Td (DEMO) Tj ET 0 g "
            b"BT /F1 12 Tf 110 310 Td (Q: A sample.) Tj ET "
            b"BT /F1 12 Tf 110 286 Td (A: First part.) Tj ET "
            b"BT /F1 12 Tf 110 262 Td (Q: Another.) Tj ET "
            b"BT /F1 12 Tf 110 238 Td (A: Next part.) Tj ET "
            b"BT /F1 8 Tf 0.5 g 50 210 Td (USER) Tj ET 0 g "
            b"BT /F1 12 Tf 110 210 Td (Q: New problem.) Tj ET "
            b"BT /F1 12 Tf 110 186 Td (A: New part.) Tj ET",
        ]
        for stream in streams:
            page = writer.add_blank_page(width=300, height=400)
            page[NameObject("/Resources")] = DictionaryObject(
                {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
            )
            contents = DecodedStreamObject()
            contents.set_data(stream)
            page[NameObject("/Contents")] = writer._add_object(contents)
        source = root / "source.pdf"
        with source.open("wb") as target:
            writer.write(target)
        raw = {
            "schema": "docvortex.middle",
            "schema_version": "2.0",
            "is_full_document": True,
            "metadata": {
                "file_suffix": "pdf",
                "producer": {"name": "prompt-fixture", "version": "1"},
            },
            "pages": [
                {
                    "page_idx": 0,
                    "blocks": [
                        text(
                            0,
                            "Please suggest a fun weekend.",
                            [0.14, 0.095, 0.82, 0.16],
                        ),
                        {
                            "index": 1,
                            "type": "equation",
                            "bbox": [0.14, 0.40, 0.90, 0.44],
                            "content": r"\mathrm{premise} = whether is nice this wenekend,",
                            "image_path": "wrong.jpg",
                        },
                    ],
                },
                {
                    "page_idx": 1,
                    "blocks": [
                        text(0, "Q: {*question*}\nA:", [0.14, 0.52, 0.72, 0.63], "code"),
                        text(
                            1,
                            "Here is a sentence\n{*sentence*}",
                            [0.14, 0.09, 0.75, 0.21],
                            "code",
                        ),
                        text(2, "This introduces the question.", [0.12, 0.35, 0.85, 0.40]),
                    ],
                },
                {
                    "page_idx": 2,
                    "blocks": [
                        text(
                            0,
                            "SYSTEM You help with grammar.\n"
                            "USER Please correct this sentence.\nInput: A sample.\nOutput:",
                            [0.12, 0.09, 0.90, 0.34],
                            "code",
                        )
                    ],
                },
                {
                    "page_idx": 3,
                    "blocks": [
                        {
                            "index": 0,
                            "type": "table",
                            "bbox": [0.12, 0.09, 0.85, 0.23],
                            "content": [
                                {
                                    "type": "table_body",
                                    "index": 0,
                                    "bbox": [0.12, 0.09, 0.85, 0.23],
                                    "content": (
                                        "<table><tr><td>DEMO</td>"
                                        "<td>First example.</td></tr></table>"
                                    ),
                                }
                            ],
                        }
                    ],
                },
                {
                    "page_idx": 4,
                    "blocks": [
                        text(
                            0,
                            "def train():\n    return 1",
                            [0.14, 0.09, 0.8, 0.2],
                            "code",
                        ),
                        {
                            "index": 1,
                            "type": "equation",
                            "bbox": [0.14, 0.4, 0.7, 0.45],
                            "content": "x=a+b",
                        },
                        {
                            "index": 2,
                            "type": "equation",
                            "bbox": [0.14, 0.48, 0.9, 0.52],
                            "content": "signal=a b c d",
                        },
                    ],
                },
                {
                    "page_idx": 5,
                    "blocks": [text(0, "Important term", [0.14, 0.095, 0.55, 0.16])],
                },
                {
                    "page_idx": 6,
                    "blocks": [
                        {
                            **text(
                                0,
                                "def train():\n    return 1",
                                [0.14, 0.09, 0.8, 0.2],
                                "code",
                            ),
                            "guess_lang": "python",
                        },
                        text(1, "Explain this equation", [0.14, 0.475, 0.8, 0.51]),
                        {
                            "type": "equation",
                            "index": 2,
                            "bbox": [0.14, 0.53, 0.8, 0.56],
                            "content": "x=y",
                        },
                    ],
                },
                {
                    "page_idx": 7,
                    "blocks": [
                        text(
                            0,
                            "Classify the following text.\nText:\n"
                            "The service was slow.\nThe polarity is negative",
                            [0.16, 0.10, 0.75, 0.32],
                            "code",
                        )
                    ],
                },
                {
                    "page_idx": 8,
                    "blocks": [
                        text(0, "DEMO Q: Jerry games?", [0.12, 0.10, 0.90, 0.13]),
                        text(1, "A: Boris has 3 fewer.", [0.36, 0.47, 0.90, 0.505]),
                    ],
                },
                {
                    "page_idx": 9,
                    "blocks": [
                        {
                            "type": "table",
                            "index": 0,
                            "bbox": [0.12, 0.06, 0.9, 0.54],
                            "content": [
                                {
                                    "type": "table_body",
                                    "index": 0,
                                    "bbox": [0.12, 0.06, 0.9, 0.54],
                                    "content": (
                                        "<table><tr><td>TASK</td><td>Decompose a problem.</td></tr>"
                                        "<tr><td>DEMO</td><td>Q: A sample.</td></tr>"
                                        "<tr><td>USER</td><td>Q: New problem.</td></tr></table>"
                                    ),
                                }
                            ],
                        }
                    ],
                },
            ],
        }
        run = {
            "runId": "prompt-fixture",
            "sourceSha256": digest(source),
            "requestedPageIndices": list(range(10)),
        }
        raw["pages"][1]["blocks"][2]["continues_prev"] = True
        raw["pages"][1]["blocks"][0]["guess_lang"] = "yaml"
        return source, raw, run

    def process(self, root):
        source, raw, run = self.fixture(root)
        original = copy.deepcopy(raw)
        supplement = prepare_prompts(raw, run, source)
        MiddleJson.from_dict(raw)  # Source identities still satisfy increasing parser indices.
        callouts, _ = project_source(raw, run, source)
        ensure_prompt_callouts(callouts, supplement["prompts"])
        indices = {
            (r["parsedPageIndex"], i) for r in supplement["prompts"] for i in r["blockIndices"]
        }
        layout, _ = collect_layout(raw, run, source, callouts, indices)
        layout.update(supplement)
        soup = BeautifulSoup(
            render_html(MiddleJson.from_dict(raw), mode=RenderMode.FULL, standalone=True),
            "html.parser",
        )
        apply_callouts(soup, callouts)
        apply_layout(soup, layout)
        apply_prompts(soup, supplement)
        evidence = source_layout(run, layout, callouts)
        return soup, supplement, raw, original, evidence

    def test_standalone_answer_line_and_prose_assignment_survive(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, records, raw, original, _ = self.process(Path(temporary))
            section = soup.select_one('section[data-page-idx="0"]')
            self.assertEqual(section.select_one(".pl-prompt-answer-line").get_text(), "____")
            self.assertEqual(section.select_one(".pl-completion-slot")["data-pl-preserve"], "blank")
            assignment = section.select_one("[data-source-prose-assignment]")
            self.assertEqual(
                assignment.get_text().strip(),
                "premise = the weather is nice this weekend,",
            )
            self.assertFalse(assignment.select_one(".docvortex-math"))
            self.assertEqual(
                section.select_one(".pl-prompt .pl-source-color")["style"],
                "color:#cc0000",
            )
            self.assertEqual(section.select_one(".pl-prompt u").get_text(), "Please")
            self.assertEqual(len(records["proseRepairs"]), 1)
            self.assertEqual(raw["pages"][0]["blocks"][1]["type"], "text")
            self.assertEqual(original["pages"][0]["blocks"][1]["type"], "equation")

    def test_question_panel_order_and_placeholder_line_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, supplement, raw, original, evidence = self.process(Path(temporary))
            self.assertEqual([b["index"] for b in raw["pages"][1]["blocks"]], [0, 1, 2])
            self.assertFalse(raw["pages"][1]["blocks"][2]["continues_prev"])
            self.assertTrue(original["pages"][1]["blocks"][2]["continues_prev"])
            self.assertTrue(
                all(
                    r["deferredContinuationBlockIndices"] == [2]
                    for r in supplement["prompts"]
                    if r["parsedPageIndex"] == 1
                )
            )
            section = soup.select_one('section[data-page-idx="1"]')
            paragraphs = [p.get_text() for p in section.select("p")]
            self.assertLess(
                paragraphs.index("This introduces the question."),
                paragraphs.index("Q: {*question*}"),
            )
            self.assertEqual(
                section.select_one(".pl-prompt-placeholder").get_text(), "{*sentence*}"
            )
            order = evidence["pages"][1]["readingOrder"]
            self.assertEqual([identity.rsplit("/b", 1)[1] for identity in order], ["1", "2", "0"])

    def test_role_gray_styles_and_body_boundaries_are_explicit(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, _, _, _, _ = self.process(Path(temporary))
            section = soup.select_one('section[data-page-idx="2"]')
            roles = section.select(".pl-prompt-role")
            self.assertEqual([r.get_text() for r in roles], ["SYSTEM", "USER"])
            self.assertTrue(all("color:#808080" in r["style"] for r in roles))
            self.assertTrue(all(r["translate"] == "no" for r in roles))
            user = section.select(".pl-prompt-value")[1]
            self.assertEqual(
                [p.get_text() for p in user.select("p")],
                ["Please correct this sentence.", "Input: A sample.", "Output:____"],
            )
            self.assertEqual(user.select_one(".pl-completion-slot")["data-pl-preserve"], "blank")

    def test_only_verified_prompt_table_is_reclassified_and_real_code_math_remain(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, _, raw, original, _ = self.process(Path(temporary))
            self.assertEqual(raw["pages"][3]["blocks"][0]["type"], "text")
            self.assertEqual(original["pages"][3]["blocks"][0]["type"], "table")
            self.assertEqual(len(soup.select('section[data-page-idx="3"] .pl-prompt-role')), 2)
            self.assertEqual(raw["pages"][4], original["pages"][4])
            self.assertFalse(soup.select_one('section[data-page-idx="4"] .pl-prompt'))
            self.assertEqual(raw["pages"][5], original["pages"][5])
            self.assertFalse(soup.select_one('section[data-page-idx="5"] .pl-prompt'))
            self.assertFalse(soup.select_one('section[data-page-idx="5"] .pl-completion-slot'))
            self.assertEqual(raw["pages"][6], original["pages"][6])
            self.assertFalse(soup.select_one('section[data-page-idx="6"] .pl-prompt'))

    def test_native_highlight_and_underlining_make_a_prose_prompt_translatable(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, supplement, raw, original, _ = self.process(Path(temporary))
            section = soup.select_one('section[data-page-idx="7"]')
            self.assertEqual(raw["pages"][7]["blocks"][0]["type"], "text")
            self.assertEqual(original["pages"][7]["blocks"][0]["type"], "code")
            highlight = section.select_one(".pl-source-highlight")
            self.assertEqual(highlight.get_text(), "Classify the following text.")
            self.assertIn("background-color:#99f5ad", highlight["style"])
            self.assertEqual(section.select_one("u").get_text(), "negative")
            self.assertFalse(section.find("code"))
            record = next(r for r in supplement["prompts"] if r["parsedPageIndex"] == 7)
            self.assertTrue(record["rows"][0]["highlights"])

    def test_omitted_demonstration_and_user_question_are_recovered_from_native_text(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            soup, supplement, raw, original, evidence = self.process(Path(temporary))
            section = soup.select_one('section[data-page-idx="8"]')
            self.assertEqual(
                [r.get_text() for r in section.select(".pl-prompt-role")],
                ["DEMO", "USER"],
            )
            bodies = section.select(".pl-prompt-value")
            self.assertEqual(
                [p.get_text() for p in bodies[0].select("p")],
                [
                    "Q: Jerry games?",
                    "A: Jerry plays 96 hours.",
                    "Q: Mary apples?",
                    "A: Mary eats 2 apples.",
                ],
            )
            self.assertEqual(
                [p.get_text() for p in bodies[1].select("p")],
                ["Q: Boris apples?", "A: Boris has 3 fewer."],
            )
            record = next(r for r in supplement["prompts"] if r["parsedPageIndex"] == 8)
            repair = record["nativeCoverageRepair"]
            self.assertEqual(repair["parserBBox"], original["pages"][8]["blocks"][0]["bbox"])
            self.assertEqual(repair["exportBBox"], raw["pages"][8]["blocks"][0]["bbox"])
            self.assertTrue(repair["sourceCharacterRanges"])
            owners = {
                i
                for b in evidence["pages"][8]["blocks"]
                for start, end in b["nativeCharacterRanges"]
                for i in range(start, end)
            }
            self.assertTrue(
                all(
                    i in owners
                    for start, end in repair["sourceCharacterRanges"]
                    for i in range(start, end)
                )
            )

    def test_native_recovery_rejects_a_mismatched_parser_anchor(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw, run = self.fixture(Path(temporary))
            raw["pages"][8]["blocks"][0]["content"][0]["content"] = "DEMO Q: A different question?"
            original = copy.deepcopy(raw["pages"][8])
            records = prepare_prompts(raw, run, source)
            self.assertFalse(any(r["parsedPageIndex"] == 8 for r in records["prompts"]))
            self.assertEqual(raw["pages"][8], original)

    def test_task_demo_user_each_keep_their_body_and_prologue_remains_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            soup, supplement, raw, original, _ = self.process(Path(temporary))
            section = soup.select_one('section[data-page-idx="9"]')
            self.assertEqual(
                [r.get_text() for r in section.select(".pl-prompt-role")], ["TASK", "DEMO", "USER"]
            )
            bodies = section.select(".pl-prompt-value")
            self.assertEqual(
                [p.get_text() for p in bodies[0].select("p")], ["Decompose a problem."]
            )
            self.assertEqual(
                [p.get_text() for p in bodies[1].select("p")],
                ["Q: A sample.", "A: First part.", "Q: Another.", "A: Next part."],
            )
            self.assertEqual(
                [p.get_text() for p in bodies[2].select("p")], ["Q: New problem.", "A: New part."]
            )
            self.assertEqual(section.select_one(".pl-prompt > p").get_text(), "Read first.")
            self.assertEqual(raw["pages"][9]["blocks"][0]["type"], "text")
            self.assertEqual(original["pages"][9]["blocks"][0]["type"], "table")


if __name__ == "__main__":
    unittest.main()

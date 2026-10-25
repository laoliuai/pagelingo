"""Shared-caption figure grouping and conservative rejection cases."""

import copy
import tempfile
import unittest
from pathlib import Path

from preview_figures import merge_figure_groups
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


class FigureTests(unittest.TestCase):
    def fixture(self):
        blocks = []
        for i, (x, y) in enumerate(((0.1, 0.1), (0.5, 0.1), (0.1, 0.35), (0.5, 0.35))):
            box = [x, y, x + 0.3, y + 0.15]
            blocks.append({
                "index": i * 2, "type": "chart", "bbox": box,
                "content": [
                    {"index": i * 2, "type": "chart_body", "bbox": box, "content": "",
                     "image_path": f"panel-{i}.png"},
                    {"index": i * 2 + 1, "type": "chart_caption",
                     "bbox": [x, y + 0.16, x + 0.3, y + 0.18],
                     "content": [{"type": "text", "content": f"({chr(97 + i)}) A subfigure"}]},
                ],
            })
        # A parser can attach (a) to the (c) block; native geometry still identifies the grid.
        blocks[2]["content"].append(blocks[0]["content"].pop())
        blocks[-1]["content"].append({
            "index": 8, "type": "chart_caption", "bbox": [0.1, 0.56, 0.8, 0.62],
            "content": [{"type": "text", "content": "Fig. 1: A shared description."}],
        })
        return {"pages": [{"page_idx": 0, "blocks": blocks}]}

    def test_grid_and_its_misattached_labels_share_one_crop_and_one_main_caption(self):
        raw = self.fixture()
        records = merge_figure_groups(raw, {"requestedPageIndices": [2]})
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]["rows"], records[0]["columns"]), (2, 2))
        self.assertEqual(records[0]["sourcePageIndex"], 2)
        self.assertEqual(records[0]["blockIndices"], [0, 2, 4, 6])
        block = raw["pages"][0]["blocks"][0]
        self.assertEqual(len(raw["pages"][0]["blocks"]), 1)
        self.assertEqual(len(block["content"]), 2)
        self.assertEqual(block["content"][1]["content"][0]["content"],
                         "Fig. 1: A shared description.")
        self.assertAlmostEqual(records[0]["bbox"][3], 0.53)

    def test_multiple_independent_figure_captions_prevent_merging(self):
        raw = self.fixture()
        caption = copy.deepcopy(raw["pages"][0]["blocks"][-1]["content"][-1])
        caption["content"][0]["content"] = "Fig. 2: Another figure."
        raw["pages"][0]["blocks"][0]["content"].append(caption)
        original = copy.deepcopy(raw)
        self.assertEqual(merge_figure_groups(raw, {"requestedPageIndices": [0]}), [])
        self.assertEqual(raw, original)

    def test_intervening_prose_prevents_merging(self):
        raw = self.fixture()
        raw["pages"][0]["blocks"].insert(2, {"type": "text", "index": 99})
        self.assertEqual(merge_figure_groups(raw, {"requestedPageIndices": [0]}), [])

    def test_overlapping_or_unaligned_columns_are_not_a_shared_grid(self):
        raw = self.fixture()
        raw["pages"][0]["blocks"][1]["content"][0]["bbox"] = [0.25, 0.1, 0.7, 0.25]
        self.assertEqual(merge_figure_groups(raw, {"requestedPageIndices": [0]}), [])

    def ragged_fixture(self):
        raw = self.fixture()
        blocks = raw["pages"][0]["blocks"]
        main = blocks[-1]["content"].pop()
        main["index"], main["bbox"] = 12, [0.1, 0.76, 0.8, 0.82]
        box = [0.3, 0.58, 0.6, 0.70]
        blocks.append({
            "type": "chart", "index": 8, "bbox": box,
            "content": [
                {"type": "chart_body", "index": 8, "bbox": box, "content": ""},
                {"type": "chart_caption", "index": 9, "bbox": [0.3, 0.71, 0.6, 0.73],
                 "content": [{"type": "text", "content": "(e) The final panel"}]},
                main,
            ],
        })
        return raw

    def test_a_centered_last_panel_preserves_two_two_one_rows(self):
        raw = self.ragged_fixture()
        records = merge_figure_groups(raw, {"requestedPageIndices": [0]})
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["rowLengths"], [2, 2, 1])
        self.assertEqual(records[0]["blockIndices"], [0, 2, 4, 6, 8])
        self.assertEqual(len(raw["pages"][0]["blocks"]), 1)

    def test_an_off_center_last_panel_or_an_incomplete_middle_row_prevents_merging(self):
        for off_center in (True, False):
            with self.subTest(off_center=off_center):
                raw = self.ragged_fixture()
                blocks = raw["pages"][0]["blocks"]
                if off_center:
                    blocks[-1]["content"][0]["bbox"] = [0.05, 0.58, 0.35, 0.70]
                else:
                    blocks.pop(2)
                self.assertEqual(merge_figure_groups(raw, {"requestedPageIndices": [0]}), [])

    def vertical_fixture(self, root, second_label="b"):
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
        stream = DecodedStreamObject()
        stream.set_data(
            rb"BT /F1 9 Tf 65 365 Td (\(a\) First panel) Tj ET "
            + f"BT /F1 9 Tf 65 255 Td (\\({second_label}\\) Next panel) Tj ET".encode()
        )
        page[NameObject("/Contents")] = writer._add_object(stream)
        source = root / "source.pdf"
        with source.open("wb") as output:
            writer.write(output)
        blocks = self.fixture()["pages"][0]["blocks"]
        first, last = copy.deepcopy(blocks[0]), copy.deepcopy(blocks[-1])
        first["bbox"] = first["content"][0]["bbox"] = [0.1, 0.1, 0.4, 0.25]
        first["content"].append({"type": "chart_caption", "index": 1,
                                 "bbox": [0.15, 0.25, 0.35, 0.28],
                                 "content": [{"type": "text", "content": "(a) First panel"}]})
        last["index"] = last["content"][0]["index"] = 2
        last["bbox"] = last["content"][0]["bbox"] = [0.1, 0.35, 0.4, 0.50]
        main = last["content"][-1]
        main["bbox"], main["index"] = [0.1, 0.53, 0.8, 0.59], 3
        last["content"] = [last["content"][0], main]
        return source, {"pages": [{"page_idx": 0, "blocks": [first, last]}]}

    def test_vertical_subfigures_need_native_letter_labels_even_inside_a_body_crop(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.vertical_fixture(Path(temporary))
            self.assertEqual(
                merge_figure_groups(copy.deepcopy(raw), {"requestedPageIndices": [0]}), []
            )
            records = merge_figure_groups(raw, {"requestedPageIndices": [0]}, source)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["rowLengths"], [1, 1])
            self.assertEqual([c["text"] for c in records[0]["nativeSubcaptions"]],
                             ["(a) First panel", "(b) Next panel"])

    def test_nonsequential_native_subfigure_labels_do_not_merge(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, raw = self.vertical_fixture(Path(temporary), second_label="c")
            original = copy.deepcopy(raw)
            self.assertEqual(merge_figure_groups(raw, {"requestedPageIndices": [0]}, source), [])
            self.assertEqual(raw, original)


if __name__ == "__main__":
    unittest.main()

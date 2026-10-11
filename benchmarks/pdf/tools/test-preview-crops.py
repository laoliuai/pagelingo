"""Model-free physical PDF regression for rotation, CropBox and excerpt mapping."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

spec = importlib.util.spec_from_file_location(
    "preview_export", Path(__file__).with_name("export-mineru-preview.py")
)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class OriginalVisualTests(unittest.TestCase):
    def test_physical_rectangle_survives_rotation_crop_and_excerpt_mapping(self):
        # Independent locations of the same PDF-user-space rectangle in each
        # rotated display frame; do not use production geometry to compute these.
        boxes = [
            [1 / 8, 6 / 11, 3 / 8, 9 / 11],
            [2 / 11, 1 / 8, 5 / 11, 3 / 8],
            [5 / 8, 2 / 11, 7 / 8, 5 / 11],
            [6 / 11, 5 / 8, 9 / 11, 7 / 8],
        ]
        colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (0, 0, 0)]
        commands = [b"1 0 0 rg", b"0 1 0 rg", b"0 0 1 rg", b"0 0 0 rg"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            writer = PdfWriter()
            for index, rotation in enumerate((0, 90, 180, 270)):
                page = writer.add_blank_page(width=200, height=300)
                page.cropbox.lower_left = (20, 40)
                page.cropbox.upper_right = (180, 260)
                page.rotate(rotation)
                stream = DecodedStreamObject()
                stream.set_data(commands[index] + b" 40 80 40 60 re f")
                page[NameObject("/Contents")] = writer._add_object(stream)
            with (root / "source.pdf").open("wb") as target:
                writer.write(target)
            for selection in ([0, 1, 2, 3], [1, 3]):
                with self.subTest(selection=selection):
                    raw = {"pages": []}
                    for parsed, source in enumerate(selection):
                        body = {
                            "type": "table_body",
                            "index": 0,
                            "bbox": boxes[source],
                            "content": "<table><tr><td>reconstructed</td></tr></table>",
                        }
                        raw["pages"].append(
                            {
                                "page_idx": parsed,
                                "blocks": [
                                    {
                                        "type": "table",
                                        "index": 0,
                                        "bbox": boxes[source],
                                        "content": [body],
                                    }
                                ],
                            }
                        )
                    run = {"sourcePageCount": 4, "requestedPageIndices": selection}
                    records = exporter.original_visuals(raw, run, root, root / str(selection), 3)
                    self.assertEqual([r["sourcePageIndex"] for r in records], selection)
                    for record in records:
                        source = record["sourcePageIndex"]
                        with Image.open(root / str(selection) / record["path"]) as crop:
                            center = crop.width // 2, crop.height // 2
                            self.assertEqual(crop.getpixel(center), colors[source])
                            self.assertEqual(crop.getpixel((0, 0)), (255, 255, 255))
                            colored = sum(
                                pixel == colors[source] for pixel in crop.get_flattened_data()
                            )
                            # The known 40x60 pt colored rectangle occupies 120x180 pixels.
                            self.assertGreater(colored, 21000)
                            self.assertLess(colored, 22000)
                        self.assertEqual(
                            raw["pages"][record["parsedPageIndex"]]["blocks"][0]["content"][0][
                                "content"
                            ],
                            "",
                        )

    def test_invalid_coordinates_are_rejected_instead_of_creating_a_wrong_crop(self):
        for box in ([0, 0, float("nan"), 1], [-0.1, 0, 1, 1], [0.5, 0, 0.2, 1]):
            with self.subTest(box=box), self.assertRaises(ValueError):
                exporter.crop_rectangle(box, (100, 200), 6)


if __name__ == "__main__":
    unittest.main()

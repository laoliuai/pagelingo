"""Explicit local-only Python verification; ordinary npm tests never start Python."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import RectangleObject

spec = importlib.util.spec_from_file_location(
    "reader_inspection", Path(__file__).parents[2] / "python" / "reader_inspection.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InspectionTest(unittest.TestCase):
    def test_effective_crop_and_four_rotations(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "owned.pdf"
            writer = PdfWriter()
            for rotation in [0, 90, 180, 270]:
                page = writer.add_blank_page(width=400, height=500)
                page.cropbox = RectangleObject([20, 40, 380, 460])
                page.rotate(rotation)
            writer.write(path)
            result = module.inspect_pdf(path)
            self.assertEqual([p["pdfToDisplay"] for p in result["pages"]], [
                [1, 0, 0, -1, -20, 460], [0, 1, 1, 0, -40, -20],
                [-1, 0, 0, 1, 380, -40], [0, -1, -1, 0, 460, 380],
            ])
            self.assertEqual([p["displayWidth"] for p in result["pages"]],
                             [360, 420, 360, 420])
            self.assertEqual(len(result["sourceSha256"]), 64)

    def test_crop_repair_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "owned.pdf"
            writer = PdfWriter()
            page = writer.add_blank_page(width=400, height=500)
            page.cropbox = RectangleObject([-20, 40, 600, 460])
            writer.write(path)
            result = module.inspect_pdf(path)
            self.assertEqual(result["pages"][0]["cropBox"], [-20, 40, 600, 460])
            self.assertEqual(result["pages"][0]["displayCropBox"], [0, 40, 400, 460])
            self.assertEqual(result["warnings"], ["display-crop-repaired:0"])


if __name__ == "__main__":
    unittest.main()

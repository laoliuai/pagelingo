import math

import pypdfium2 as pdfium
import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

from pagelingo_parser.geometry import display_box, normalized_pdf_box, validate_box
from pagelingo_parser.pdf import inspect_pdf, parse_page_selection


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_cropped_rotated_pdf_coordinates_match_rendered_pixels(tmp_path, rotation):
    # Independent physical reference: a real PDFium render of a known colored rectangle.
    path = tmp_path / "crop-rotation.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=300)
    page.cropbox.lower_left = (20, 40)
    page.cropbox.upper_right = (180, 260)
    page.rotate(rotation)
    stream = DecodedStreamObject()
    stream.set_data(b"1 0 0 rg 40 80 40 60 re f")
    page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as output:
        writer.write(output)
    metadata = inspect_pdf(path)["pages"][0]
    result = normalized_pdf_box([40, 80, 80, 140], metadata["cropBox"], rotation)
    with pdfium.PdfDocument(path) as pdf:
        p = pdf[0]
        bitmap = p.render(scale=1)
        image = bitmap.to_pil().convert("RGB")
        points = [
            (x, y)
            for y in range(image.height)
            for x in range(image.width)
            if image.getpixel((x, y))[0] > 240 and image.getpixel((x, y))[1] < 15
        ]
        actual = [
            min(p[0] for p in points),
            min(p[1] for p in points),
            max(p[0] for p in points) + 1,
            max(p[1] for p in points) + 1,
        ]
        expected = [
            result[0] * image.width,
            result[1] * image.height,
            result[2] * image.width,
            result[3] * image.height,
        ]
        assert actual == pytest.approx(expected, abs=1)
        bitmap.close()
        p.close()


def test_already_rotated_parser_frame_not_rotated_twice():
    assert display_box([10, 20, 50, 80], 100, 200) == [0.1, 0.1, 0.5, 0.4]
    assert display_box([10, 120, 50, 180], 100, 200, "BOTTOMLEFT") == [0.1, 0.1, 0.5, 0.4]


@pytest.mark.parametrize("box", [[0, 0, 0, 1], [0, 0, math.nan, 1], [-0.1, 0, 1, 1]])
def test_invalid_box_is_not_invented(box):
    with pytest.raises(ValueError):
        validate_box(box)


@pytest.mark.parametrize("selection", ["0", "1-10", "2,1", "1,1", "3-2", "", "1-2-3"])
def test_page_selection_rejects_invalid_or_ambiguous_ranges(selection):
    with pytest.raises(ValueError):
        parse_page_selection(selection, 5)


def test_full_page_set_and_explicit_sample():
    assert parse_page_selection("all", 15) == list(range(15))
    assert parse_page_selection("1,3-5", 8) == [0, 2, 3, 4]

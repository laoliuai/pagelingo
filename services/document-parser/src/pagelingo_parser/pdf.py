"""Native PDF inspection and preview rendering, independent of ML candidates."""

from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader


def inspect_pdf(path: Path) -> dict:
    reader = PdfReader(path)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported in P0")
    pages = []
    with pdfium.PdfDocument(path) as pdf:
        for index, pdf_page in enumerate(pdf):
            text_page = pdf_page.get_textpage()
            try:
                native_text = text_page.get_text_range()
                page = reader.pages[index]
                pages.append(
                    {
                        "pageIndex": index,
                        "mediaBox": list(map(float, page.mediabox)),
                        "cropBox": list(map(float, page.cropbox)),
                        "displayCropBox": list(map(float, pdf_page.get_bbox())),
                        "rotation": pdf_page.get_rotation(),
                        "displayWidth": pdf_page.get_width(),
                        "displayHeight": pdf_page.get_height(),
                        "nativeText": native_text,
                    }
                )
            finally:
                text_page.close()
                pdf_page.close()
        return {"pageCount": len(pdf), "metadata": pdf.get_metadata_dict(), "pages": pages}


def parse_page_selection(selection: str, page_count: int) -> list[int]:
    if selection == "all":
        return list(range(page_count))
    pages = []
    for part in selection.split(","):
        boundaries = part.strip().split("-")
        if len(boundaries) == 1:
            first = last = int(boundaries[0])
        elif len(boundaries) == 2:
            first, last = map(int, boundaries)
        else:
            raise ValueError("Use 1-based page numbers or ranges: 1,3-5")
        if first < 1 or last > page_count or last < first:
            raise ValueError("Page selection is outside the source PDF")
        pages.extend(range(first - 1, last))
    if len(pages) != len(set(pages)) or pages != sorted(pages):
        raise ValueError("Page selection must be unique and ascending")
    if not pages:
        raise ValueError("Page selection cannot be empty")
    return pages


def extract_pdf(source: Path, page_indices: list[int], target: Path) -> None:
    with pdfium.PdfDocument(source) as pdf, pdfium.PdfDocument.new() as excerpt:
        excerpt.import_pages(pdf, page_indices)
        excerpt.save(target)


def render_page(pdf, index: int, target: Path, scale: float = 1.0):
    page = pdf[index]
    bitmap = page.render(scale=scale)
    try:
        image = bitmap.to_pil().convert("RGB")
        image.save(target)
        return image
    finally:
        bitmap.close()
        page.close()

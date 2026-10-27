"""Read-only PDF geometry inspection; no parser/model imports or downloads."""
import hashlib
import json
import sys
from pathlib import Path

from pypdf import PdfReader


def inspect_pdf(source: Path) -> dict:
    pages, warnings = [], []
    for index, page in enumerate(PdfReader(source).pages):
        media, crop = [float(v) for v in page.mediabox], [float(v) for v in page.cropbox]
        x0, y0 = max(media[0], crop[0]), max(media[1], crop[1])
        x1, y1 = min(media[2], crop[2]), min(media[3], crop[3])
        if x0 >= x1 or y0 >= y1:
            x0, y0, x1, y1 = media
        display = [x0, y0, x1, y1]
        if display != crop:
            warnings.append(f"display-crop-repaired:{index}")
        rotation = int(page.rotation) % 360
        matrices = {0: [1, 0, 0, -1, -x0, y1], 90: [0, 1, 1, 0, -y0, -x0],
                    180: [-1, 0, 0, 1, x1, -y0], 270: [0, -1, -1, 0, y1, x1]}
        if rotation not in matrices:
            raise ValueError("Unsupported PDF rotation")
        swapped = rotation in (90, 270)
        pages.append({
            "pageIndex": index, "mediaBox": media, "cropBox": crop,
            "displayCropBox": display, "rotation": rotation,
            "displayWidth": y1 - y0 if swapped else x1 - x0,
            "displayHeight": x1 - x0 if swapped else y1 - y0,
            "pdfToDisplay": matrices[rotation],
        })
    with source.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"schemaVersion": "pagelingo-pdf-inspection/1", "sourceSha256": digest,
            "pages": pages, "warnings": warnings}


if __name__ == "__main__":
    print(json.dumps(inspect_pdf(Path(sys.argv[1]))))

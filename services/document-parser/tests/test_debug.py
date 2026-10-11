import pypdfium2 as pdfium

from pagelingo_parser.debug import build_debug
from pagelingo_parser.files import digest


def test_offline_debug_escapes_pdf_text_and_materializes_source_fallback(tmp_path):
    pdf_path = tmp_path / "source.pdf"
    with pdfium.PdfDocument.new() as pdf:
        page = pdf.new_page(100, 200)
        page.close()
        pdf.save(pdf_path)
    document = {
        "blocks": [{
            "id": "a", "parentId": None, "kind": "equation", "scope": "body",
            "text": '<script>alert("PDF text must never execute")</script>',
            "rawRef": "#/pages/0/blocks/0", "assetIds": [],
            "sourceRefs": [{"pageIndex": 0, "precision": "bbox", "bbox": [0.1, 0.2, 0.8, 0.6]}],
        }],
        "requestedPageIndices": [0], "sourcePageCount": 1, "coverage": "full",
        "status": "complete",
    }
    build_debug(pdf_path, tmp_path, document)
    html = (tmp_path / "debug.html").read_text()
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert 'href="#block-0"' in html
    assert 'href="source.pdf#page=1"' in html
    assert len(document["assets"]) == 2
    assert document["blocks"][0]["assetIds"] == ["crop-0-0"]
    for asset in document["assets"]:
        assert digest(tmp_path / asset["path"]) == asset["sha256"]

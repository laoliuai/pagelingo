"""Check rendered prompt text directly against bounded native PDF extraction."""

import re
import unicodedata
from collections import defaultdict

import pypdfium2 as pdfium
from bs4 import BeautifulSoup
from pagelingo_parser.files import relative_file
from preview_layout import native_bounds


def normalized_text(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).replace(
        "\x02", ""
    ).replace("\xad", "")


def check_prompt_coverage(root, preview, evidence):
    """Use the PDF's full panel text, not the projection's recorded row strings."""
    by_page = defaultdict(list)
    for record in evidence["supplements"].get("prompts", []):
        by_page[record["sourcePageIndex"]].append(record)
    files = {p["sourcePageIndex"]: p["path"] for p in preview["pages"]}
    checked, characters = 0, 0
    with pdfium.PdfDocument(root / "source.pdf") as pdf:
        for page_index, records in by_page.items():
            soup = BeautifulSoup(relative_file(root, files[page_index]).read_text(), "html.parser")
            page = pdf[page_index]
            textpage = page.get_textpage()
            try:
                for record in records:
                    block_index = record["blockIndices"][0]
                    block = soup.select_one(
                        f'.docvortex-block[data-block-index="{block_index}"]'
                    )
                    candidates = block.select(".pl-prompt") if block else []
                    fragments = record.get("splitFromParserBlocks", [])
                    ordinal = fragments[0]["panelOrdinal"] if fragments else 0
                    if ordinal >= len(candidates) or not fragments and len(candidates) != 1:
                        raise ValueError(f"Missing prompt on PDF page {page_index + 1}")
                    prompt = BeautifulSoup(str(candidates[ordinal]), "html.parser")
                    for slot in prompt.select(".pl-completion-slot"):
                        slot.decompose()  # Drawn answer rules are not native text glyphs.
                    left, bottom, right, top = native_bounds(record["bbox"], page)
                    expected = normalized_text(textpage.get_text_bounded(
                        left=left, bottom=bottom, right=right, top=top
                    ))
                    actual = normalized_text(prompt.get_text())
                    if actual != expected:
                        raise ValueError(
                            f"Native prompt text differs on PDF page {page_index + 1}, "
                            f"block {block_index}: {len(expected)} native / {len(actual)} rendered"
                        )
                    checked += 1
                    characters += len(expected)
            finally:
                textpage.close()
                page.close()
    return {"panelsChecked": checked, "nativeCharactersChecked": characters,
            "nativePromptText": "identical-after-whitespace-and-soft-hyphen-normalization"}

"""Offline, escaped layout/reading-order inspection with original-page fallbacks."""

import html
from collections import defaultdict
from pathlib import Path

import pypdfium2 as pdfium

from .files import digest
from .normalize import VISUAL_KINDS
from .pdf import render_page


def build_debug(source_path: Path, output: Path, document: dict, render_all: bool = True) -> None:
    assets, page_assets, regions = [], {}, defaultdict(list)
    images_dir = output / "assets"
    images_dir.mkdir()
    for order, block in enumerate(document["blocks"]):
        block["order"] = order
        for ref in block["sourceRefs"]:
            regions[ref["pageIndex"]].append((order, block, ref))
    selected = document["requestedPageIndices"]
    # Optional cap affects only debug previews; parse coverage remains explicit and unchanged.
    preview_indices = selected if render_all else selected[:12]
    with pdfium.PdfDocument(source_path) as pdf:
        for index in preview_indices:
            path = images_dir / f"page-{index + 1:04d}.png"
            image = render_page(pdf, index, path)
            asset_id = f"page-{index}"
            page_assets[index] = path.relative_to(output).as_posix()
            assets.append(
                {
                    "id": asset_id,
                    "kind": "page",
                    "path": page_assets[index],
                    "pageIndex": index,
                    "bbox": None,
                    "mediaType": "image/png",
                    "sha256": digest(path),
                }
            )
            for order, block, ref in regions[index]:
                if ref["bbox"] is None:
                    if block["kind"] in VISUAL_KINDS:
                        block["assetIds"].append(asset_id)
                    continue
                if block["kind"] not in VISUAL_KINDS:
                    continue
                x0, y0, x1, y1 = ref["bbox"]
                crop = image.crop(
                    (
                        int(x0 * image.width),
                        int(y0 * image.height),
                        max(int(x0 * image.width) + 1, int(x1 * image.width)),
                        max(int(y0 * image.height) + 1, int(y1 * image.height)),
                    )
                )
                crop_path = images_dir / f"block-{order:05d}-page-{index + 1:04d}.png"
                crop.save(crop_path)
                crop_id = f"crop-{order}-{index}"
                block["assetIds"].append(crop_id)
                assets.append(
                    {
                        "id": crop_id,
                        "kind": "crop",
                        "path": crop_path.relative_to(output).as_posix(),
                        "pageIndex": index,
                        "bbox": ref["bbox"],
                        "mediaType": "image/png",
                        "sha256": digest(crop_path),
                    }
                )
    document["assets"] = assets
    asset_map = {asset["id"]: asset for asset in assets}
    pieces = []
    for block in document["blocks"]:
        refs = block["sourceRefs"]
        pages = ", ".join(str(ref["pageIndex"] + 1) for ref in refs) or "unknown"
        order, text = block["order"], html.escape(block["text"])
        parent = ' class="child"' if block["parentId"] else ""
        images = "".join(
            f'<img loading="lazy" src="{html.escape(asset_map[asset]["path"], quote=True)}" '
            f'alt="Source region for block {order}">'
            for asset in block["assetIds"]
        )
        pieces.append(
            f'<section id="block-{order}"{parent}><small>#{order} · {block["kind"]} · '
            f"page {pages} · {html.escape(block['scope'])}</small>{images}<pre>{text}</pre>"
            f"<details><summary>Raw structure / source</summary><code>"
            f"{html.escape(block['rawRef'])}</code> · {len(refs)} source references"
            "</details></section>"
        )
    layouts = []
    for index in preview_indices:
        overlays = []
        for order, block, ref in regions[index]:
            if ref["bbox"] is None:
                continue
            x0, y0, x1, y1 = [v * 100 for v in ref["bbox"]]
            overlays.append(
                f'<a class="box {block["kind"]}" href="#block-{order}" '
                f'style="left:{x0}%;top:{y0}%;width:{x1 - x0}%;height:{y1 - y0}%" '
                f'title="#{order} {block["kind"]}"><span>{order}</span></a>'
            )
        layouts.append(
            f'<h3 id="page-{index + 1}">Page {index + 1} '
            f'<a href="source.pdf#page={index + 1}">Original PDF</a></h3>'
            f'<div class="page"><img loading="lazy" src="{page_assets[index]}" '
            f'alt="Original page {index + 1}">{"".join(overlays)}</div>'
        )
    status = (
        f"{document['coverage']} · {document['status']} · "
        f"{len(selected)}/{document['sourcePageCount']} pages"
    )
    (output / "debug.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>PageLingo PDF P0 inspection</title><style>"
        "*{box-sizing:border-box}"
        "body{margin:0;font:15px system-ui;background:#f5f5f7;color:#18202b}"
        "header{padding:16px 24px;background:#18202b;color:white;position:sticky;top:0;z-index:4}"
        "header a{color:#d4e5ff}"
        "main{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px}"
        "article{min-width:0}section{background:white;padding:16px;margin-bottom:12px;border-radius:6px;"
        "scroll-margin-top:100px}section:target{outline:3px solid #006de5}.child{margin-left:24px}"
        "small{color:#596d81}"
        "pre{white-space:pre-wrap;font:16px/1.65 system-ui;overflow-wrap:anywhere}"
        "details{font-size:12px;color:#596d81}"
        "section img{max-width:100%;display:block;margin:10px 0}"
        ".page{position:relative;background:white}.page>img{display:block;width:100%}"
        ".box{position:absolute;border:1px solid #1566d1;background:#1566d108;text-decoration:none}"
        ".box span{background:#1566d1;color:white;font:10px monospace;"
        "padding:1px;position:absolute;top:0}"
        ".box.equation,.box.figure,.box.table{border-color:#c22852}.box:hover{background:#1566d130}"
        "@media(max-width:800px){main{grid-template-columns:1fr}}"
        "</style><header><strong>PageLingo PDF P0 — provisional parser output</strong><br>"
        f"{status} · No translation / no paragraph reconstruction. "
        '<a href="normalized.json">JSON</a> · <a href="raw.json">Raw</a> · '
        '<a href="source.pdf">Source PDF</a></header><main><article>'
        + "".join(pieces)
        + "</article><aside>"
        + "".join(layouts)
        + "</aside></main></html>",
        encoding="utf-8",
    )

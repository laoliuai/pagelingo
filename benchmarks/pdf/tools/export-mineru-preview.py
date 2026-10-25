"""Export retained MinerU raw as paged offline HTML with original PDF visuals."""

import argparse
import base64
import copy
import html
import json
import math
import mimetypes
import re
import shutil
import subprocess
from importlib.metadata import distribution, version
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

import pypdfium2 as pdfium
from bs4 import BeautifulSoup
from docvortex.render.contracts import RenderMode
from docvortex.render.html import render_html
from docvortex.schema import MiddleJson
from pagelingo_parser.files import digest, read_json, relative_file, write_json
from pagelingo_parser.normalize import content_text
from PIL import Image
from preview_evidence import SCHEMA as SOURCE_LAYOUT_SCHEMA
from preview_evidence import source_layout
from preview_figures import merge_figure_groups
from preview_layout import apply_layout, collect_layout, toc_depth
from preview_prompts import apply_prompts, ensure_prompt_callouts, prepare_prompts
from preview_source import apply_callouts, project_source

TOOLS = Path(__file__).parent
VISUAL_TYPES = {"image", "table", "chart"}
PAGE_AUXILIARY_TYPES = {"header", "footer", "page_number"}


def crop_rectangle(bbox: list[float], size: tuple[int, int], padding: int) -> tuple[int, ...]:
    """MinerU bbox is already in the displayed, rotated CropBox top-left frame."""
    if len(bbox) != 4 or not all(math.isfinite(v) for v in bbox):
        raise ValueError("Visual crop requires a finite normalized bbox")
    x0, y0, x1, y1 = bbox
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError("Visual crop bbox must be inside the displayed source page")
    width, height = size
    return (
        max(0, math.floor(x0 * width) - padding),
        max(0, math.floor(y0 * height) - padding),
        min(width, math.ceil(x1 * width) + padding),
        min(height, math.ceil(y1 * height) + padding),
    )


def original_visuals(
    raw: dict,
    run: dict,
    run_dir: Path,
    output: Path,
    scale: float,
    protected: dict | None = None,
    source_regions: list | None = None,
) -> list:
    """Change only the export copy: body as a PDF crop, captions still separate text."""
    records = []
    protected = protected or {}
    padding_points = 2
    with pdfium.PdfDocument(run_dir / "source.pdf") as pdf:
        if len(pdf) != run["sourcePageCount"]:
            raise ValueError("Source PDF page count changed")
        for parsed_page in raw["pages"]:
            parsed_index = parsed_page["page_idx"]
            visuals = [
                b
                for b in parsed_page.get("blocks", [])
                if b["type"] in VISUAL_TYPES or (parsed_index, b["index"]) in protected
            ]
            extra = [r for r in (source_regions or []) if r["parsedPageIndex"] == parsed_index]
            if not visuals and not extra:
                continue
            source_index = run["requestedPageIndices"][parsed_index]
            page = pdf[source_index]
            bitmap = None
            image = None
            try:
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil().convert("RGB")
                for block in visuals:
                    protection = protected.get((parsed_index, block["index"]))
                    source_kind, block_index = block["type"], block["index"]
                    if protection:
                        bbox = protection["bbox"]
                    else:
                        body = next(
                            c for c in block["content"] if c["type"] == f"{block['type']}_body"
                        )
                        bbox = body.get("bbox") or block["bbox"]
                    rectangle = crop_rectangle(bbox, image.size, math.ceil(padding_points * scale))
                    name = f"page-{source_index + 1:04d}-{source_kind}-{block_index}.png"
                    path = f"assets/original/{name}"
                    target = relative_file(output, path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with image.crop(rectangle) as crop:
                        crop.save(target, format="PNG")
                        pixels = list(crop.size)
                    if protection:
                        # Only the private export copy changes type. Retained raw and
                        # structured text remain canonical, including the corrupt glyphs.
                        block.clear()
                        block.update(
                            {
                                "type": "image",
                                "index": block_index,
                                "bbox": bbox,
                                "content": [
                                    {
                                        "type": "image_body",
                                        "index": block_index,
                                        "bbox": bbox,
                                        "image_path": path,
                                        "content": "",
                                    }
                                ],
                            }
                        )
                    else:
                        body["content"] = ""
                        body["image_path"] = path
                        body.pop("image_base64", None)
                        body.pop("image_url", None)
                    records.append(
                        {
                            "parsedPageIndex": parsed_index,
                            "sourcePageIndex": source_index,
                            "blockIndex": block_index,
                            "kind": source_kind,
                            "role": protection["role"] if protection else "visual",
                            "protection": protection,
                            "bbox": bbox,
                            "scale": scale,
                            "paddingPoints": padding_points,
                            "pagePixels": list(image.size),
                            "cropPixels": list(rectangle),
                            "pixels": pixels,
                            "path": path,
                            "sha256": digest(target),
                        }
                    )
                for region in extra:
                    rectangle = crop_rectangle(
                        region["bbox"], image.size, math.ceil(padding_points * scale)
                    )
                    target = relative_file(output, region["path"])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with image.crop(rectangle) as crop:
                        crop.save(target, format="PNG")
                        pixels = list(crop.size)
                    records.append(
                        {
                            **region,
                            "protection": None,
                            "scale": scale,
                            "paddingPoints": padding_points,
                            "pagePixels": list(image.size),
                            "cropPixels": list(rectangle),
                            "pixels": pixels,
                            "sha256": digest(target),
                        }
                    )
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
    return records


def render_math(soup: BeautifulSoup, katex: Path) -> list:
    nodes = soup.select(".docvortex-math[data-docvortex-latex]")
    inputs = [
        {
            "latex": node["data-docvortex-latex"],
            "display": node.get("data-formula-display") == "block",
        }
        for node in nodes
    ]
    rendered = json.loads(
        subprocess.run(
            ["node", str(TOOLS / "render-math.cjs"), str(katex)],
            input=json.dumps(inputs),
            text=True,
            capture_output=True,
            check=True,
            timeout=120,
        ).stdout
    )
    failures = []
    for index, (node, result) in enumerate(zip(nodes, rendered, strict=True)):
        if result["error"]:
            node["class"] = [*node.get("class", []), "pl-math-fallback"]
            node["title"] = "Formula rendering fallback; verify against the original PDF"
            page = node.find_parent("section", attrs={"data-page-idx": True})
            failures.append(
                {
                    "mathIndex": index,
                    "parsedPageIndex": int(page["data-page-idx"]),
                    "latex": inputs[index]["latex"],
                    "error": result["error"],
                }
            )
        else:
            node.clear()
            node.append(BeautifulSoup(result["html"], "html.parser"))
    return failures


def shared_styles(soup: BeautifulSoup, katex: Path) -> str:
    styles = "\n".join(style.get_text() for style in soup.head.find_all("style"))
    css = (katex / "dist/katex.min.css").read_text()

    def embed_font(match):
        name = match.group(1).strip(" \"'")
        font = relative_file(katex / "dist", name)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return f"url(data:{mime};base64,{base64.b64encode(font.read_bytes()).decode()})"

    # Embedded fonts also work under file://. The large CSS is shared, not repeated
    # in every page; browser pages contain only the current PDF page's content.
    css = re.sub(r"url\(([^)]+)\)", embed_font, css)
    return styles + "\n" + css + "\n" + (TOOLS / "preview-reader.css").read_text()


def materialize_images(soup: BeautifulSoup, run_dir: Path, output: Path, visuals: list) -> int:
    originals = {record["path"]: record for record in visuals}
    copied = set()
    for image in soup.find_all("img"):
        name = image.get("src", "")
        parsed = urlsplit(name)
        if not name or parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("Preview requires materialized local image references")
        name = unquote(parsed.path)
        if name in originals:
            target = relative_file(output, name)
            record = originals[name]
            image["data-original-pdf"] = "true"
            image["data-original-role"] = record["role"]
            if record["role"] != "visual":
                display_width = round(record["pixels"][0] / record["scale"] * 2)
                image["style"] = f"max-width:min(100%,{display_width}px)"
                if record["role"] != "notation-symbol":
                    image["alt"] = (
                        "原 PDF 算法区域"
                        if record["role"] == "algorithm"
                        else "原 PDF 公式与正文区域"
                    )
                if record["protection"] and (
                    record["protection"]["invalidGlyphCodes"]
                    or record["protection"]["uncertainMath"]
                    or record["protection"]["reason"] == "unparsed-dense-footnote-math"
                ):
                    note = soup.new_tag("figcaption", attrs={"class": "pl-source-note"})
                    note.string = "此脚注含未可靠识别的公式，已按原 PDF 保留。" if (
                        record["protection"]["reason"] == "unparsed-dense-footnote-math"
                    ) else (
                        "此区域的文字 / 公式识别异常，已显示原 PDF。"
                        if record["protection"]["invalidGlyphCodes"]
                        else "此区域的公式识别待确认，已显示原 PDF。"
                    )
                    image.find_parent("figure").append(note)
            link = soup.new_tag("a", href=name, target="_blank", rel="noopener")
            link["class"] = "pl-original-link"
            link["title"] = "点击查看原 PDF 区域高清图"
            image.wrap(link)
        else:
            target_name = f"assets/native/{name}"
            target = relative_file(output, target_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            if name not in copied:
                shutil.copyfile(relative_file(run_dir / "native", name), target)
            image["src"] = target_name
        with Image.open(target) as pixels:
            image["width"], image["height"] = pixels.size
        image["loading"] = "lazy"
        image["decoding"] = "async"
        copied.add(name)
    return len(copied)


def document(title: str, body: str, *, in_pages: bool) -> str:
    prefix = "../" if in_pages else ""
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title>"
        f'<link rel="stylesheet" href="{prefix}assets/reader.css">'
        f'<script src="{prefix}assets/navigation.js" defer></script>'
        f'</head><body class="docvortex-html-body">{body}</body></html>'
    )


def navigation(title: str, pages: list, position: int, total: int) -> tuple[str, str]:
    current = pages[position]
    previous = (
        f'<a rel="prev" href="{pages[position - 1]["filename"]}">← 上一页</a>' if position else ""
    )
    following = (
        f'<a rel="next" href="{pages[position + 1]["filename"]}">下一页 →</a>'
        if position + 1 < len(pages)
        else ""
    )
    options = "".join(
        f'<option value="{p["filename"]}"{" selected" if i == position else ""}>'
        f"{p['sourcePageIndex'] + 1}</option>"
        for i, p in enumerate(pages)
    )
    source_link = f"../source.pdf#page={current['sourcePageIndex'] + 1}"
    book_label = (
        f'<span class="pl-book-page">书内 {html.escape(current["bookPageLabel"])}</span>'
        if current.get("bookPageLabel")
        else ""
    )
    top = (
        f'<nav class="pl-toolbar" aria-label="阅读导航">'
        f'<span class="pl-book-title">{html.escape(title)}</span>'
        f'<a href="../index.html">目录</a>{previous}{following}'
        f'<form class="pl-jump"><label>PDF 页码 <select aria-label="PDF 页码">'
        f"{options}</select></label><span>/ {total}</span>{book_label}<button>跳转</button></form>"
        f'<a href="{source_link}" target="_blank" rel="noopener">原 PDF 页</a></nav>'
    )
    bottom = (
        f'<nav class="pl-bottom" aria-label="页尾导航">{previous}{following}'
        f"<span>原 PDF 第 {current['sourcePageIndex'] + 1} 页 · 原文预览，未翻译</span></nav>"
    )
    return top, bottom


def export(run_dir: Path, output: Path, katex: Path, archive: Path, scale: float = 3) -> None:
    run_dir, output, katex = run_dir.resolve(), output.resolve(), katex.resolve()
    archive = archive.resolve()
    if output.exists() or archive.exists():
        raise ValueError("Use new output directory and archive; original outputs are immutable")
    if archive.is_relative_to(output):
        raise ValueError("Archive must be outside the exported directory")
    if not math.isfinite(scale) or not 1 <= scale <= 4:
        raise ValueError("Visual scale must be between 1 and 4 (72–288 dpi)")
    package = read_json(katex / "package.json")
    if package["name"] != "katex" or package["version"] != "0.19.0":
        raise ValueError("This preview requires the pinned KaTeX 0.19.0 package")
    run = read_json(run_dir / "run.json")
    if run["parser"] != "mineru" or run["status"] not in {"complete", "partial"}:
        raise ValueError("An existing completed/partial MinerU run is required")
    for entry in read_json(run_dir / "manifest.json")["files"]:
        if digest(relative_file(run_dir, entry["path"])) != entry["sha256"]:
            raise ValueError("Original run checksum changed")
    raw = copy.deepcopy(read_json(run_dir / "raw.json"))
    MiddleJson.from_dict(raw)  # Validate before producing assets.
    if any(p["page_idx"] >= len(run["requestedPageIndices"]) for p in raw["pages"]):
        raise ValueError("Parser page index is outside the requested-page mapping")
    title = run["input"].removesuffix(".pdf")
    output.mkdir(parents=True)
    figure_groups = merge_figure_groups(raw, run, run_dir / "source.pdf")
    prompt_layout = prepare_prompts(raw, run, run_dir / "source.pdf")
    callouts, protected = project_source(raw, run, run_dir / "source.pdf")
    ensure_prompt_callouts(callouts, prompt_layout["prompts"])
    prompt_blocks = {
        (r["parsedPageIndex"], i) for r in prompt_layout["prompts"] for i in r["blockIndices"]
    }
    layout, source_regions = collect_layout(
        raw, run, run_dir / "source.pdf", callouts, prompt_blocks
    )
    layout.update(prompt_layout)
    layout["figureGroups"] = figure_groups
    visuals = original_visuals(raw, run, run_dir, output, scale, protected, source_regions)
    # FULL prevents cross-page continuation merging and provides global anchors.
    # Page furniture is omitted from reading, as in the previous DEFAULT preview.
    soup = BeautifulSoup(
        render_html(
            MiddleJson.from_dict(raw),
            mode=RenderMode.FULL,
            standalone=True,
            document_title=title,
        ),
        "html.parser",
    )
    for script in soup.find_all("script"):
        script.decompose()
    for block in soup.select(".docvortex-block[data-block-type]"):
        if block["data-block-type"] in PAGE_AUXILIARY_TYPES:
            block.decompose()
    apply_callouts(soup, callouts)
    apply_layout(soup, layout)
    apply_prompts(soup, prompt_layout)
    failures = render_math(soup, katex)
    assets = output / "assets"
    assets.mkdir(exist_ok=True)
    (assets / "reader.css").write_text(shared_styles(soup, katex), encoding="utf-8")
    shutil.copyfile(TOOLS / "preview-navigation.js", assets / "navigation.js")
    image_count = materialize_images(soup, run_dir, output, visuals)
    sections = {int(s["data-page-idx"]): s for s in soup.select("section[data-page-idx]")}
    pages = [
        {"parsedPageIndex": i, "sourcePageIndex": source, "filename": f"page-{source + 1:04d}.html"}
        for i, source in enumerate(run["requestedPageIndices"])
    ]
    for page in raw["pages"]:
        labels = [
            content_text(b["content"]).strip()
            for b in page.get("blocks", [])
            if b["type"] == "page_number"
        ]
        if len(labels) == 1 and 0 < len(labels[0]) <= 20:
            pages[page["page_idx"]]["bookPageLabel"] = labels[0]
    anchors = {
        element["id"]: pages[index]["filename"]
        for index, section in sections.items()
        for element in section.select("[id]")
    }
    contents = []
    page_dir = output / "pages"
    page_dir.mkdir()
    for position, info in enumerate(pages):
        section = sections.get(info["parsedPageIndex"])
        if section is None:
            section = BeautifulSoup(
                '<section class="docvortex-page"></section>', "html.parser"
            ).section
        for heading in section.select("h1,h2,h3,h4,h5,h6"):
            if not heading.get("id"):
                heading["id"] = f"pl-heading-{info['sourcePageIndex']}-{len(contents)}"
            contents.append(
                {
                    "title": heading.get_text(" ", strip=True),
                    "level": int(heading.name[1]),
                    "href": f"pages/{info['filename']}#{heading['id']}",
                }
            )
        for link in section.find_all("a", href=True):
            href = link["href"]
            if href.startswith("#"):
                destination = anchors.get(unquote(href[1:]))
                if destination and destination != info["filename"]:
                    link["href"] = destination + href
            elif not urlsplit(href).scheme and not urlsplit(href).netloc:
                link["href"] = f"../{href}"
        for image in section.find_all("img"):
            image["src"] = f"../{image['src']}"
        info["renderedMathCount"] = len(section.select(".katex"))
        info["mathFallbackCount"] = len(section.select(".pl-math-fallback"))
        info["imageCount"] = len(section.select("img"))
        info["calloutCount"] = len(section.select(".pl-callout"))
        info["protectedSourceCount"] = len(
            section.select('img[data-original-role="source-fallback"]')
        )
        info["algorithmImageCount"] = len(section.select('img[data-original-role="algorithm"]'))
        info["listItemCount"] = len(section.select(".pl-source-list > li"))
        info["notationRowCount"] = len(section.select(".pl-notation-entry"))
        info["completionSlotCount"] = len(section.select(".pl-completion-slot"))
        info["coloredSpanCount"] = len(section.select(".pl-source-color"))
        info["sourceParagraphCount"] = len(section.select(".pl-source-paragraph"))
        info["sourceExampleCount"] = len(section.select(".pl-source-example"))
        info["figureGroupCount"] = sum(
            r["parsedPageIndex"] == info["parsedPageIndex"] for r in figure_groups
        )
        info["labelRowCount"] = len(section.select(".pl-label-row"))
        info["promptCount"] = len(section.select(".pl-prompt"))
        info["promptRoleCount"] = len(section.select(".pl-prompt-role"))
        info["highlightSpanCount"] = len(
            section.select('.pl-source-highlight,.pl-prompt-placeholder[style*="background-color"]')
        )
        info["nativePromptRecoveryCount"] = sum(
            r["parsedPageIndex"] == info["parsedPageIndex"] and bool(r.get("nativeCoverageRepair"))
            for r in prompt_layout["prompts"]
        )
        if not section.get_text(strip=True) and not section.find("img"):
            info["contentStatus"] = "no-reader-content"
            section.append(
                BeautifulSoup(
                    '<p class="pl-note">本页未生成可阅读正文；可查看原 PDF 页确认内容。</p>',
                    "html.parser",
                )
            )
        else:
            info["contentStatus"] = "rendered"
        top, bottom = navigation(title, pages, position, run["sourcePageCount"])
        warning = (
            f'<p class="pl-warning">本页有 {info["mathFallbackCount"]} 个公式未能排版，'
            "保留 LaTeX；请对照原 PDF。</p>"
            if info["mathFallbackCount"]
            else ""
        )
        body = top + '<main><article class="docvortex-document">' + warning + str(section)
        body += "</article></main>" + bottom
        markup = document(f"{title} · PDF {info['sourcePageIndex'] + 1}", body, in_pages=True)
        target = page_dir / info["filename"]
        target.write_text(markup, encoding="utf-8")
        info["htmlBytes"] = target.stat().st_size
        info["domElements"] = len(BeautifulSoup(markup, "html.parser").find_all(True))
        info["path"] = f"pages/{info['filename']}"
        if (position + 1) % 50 == 0:
            print(f"Exported {position + 1}/{len(pages)} pages", flush=True)
    toc = "".join(
        f'<li data-toc-depth="{toc_depth(item["title"], max(0, item["level"] - 1))}" '
        f'style="--pl-depth:{toc_depth(item["title"], max(0, item["level"] - 1))}">'
        f'<a href="{html.escape(item["href"], quote=True)}">'
        f"{html.escape(item['title'])}</a></li>"
        for item in contents
    )
    page_links = "".join(
        f'<a href="{p["path"]}">第 {p["sourcePageIndex"] + 1} 页</a>' for p in pages
    )
    home = (
        f'<main class="pl-home"><p>PageLingo · 原文阅读预览 · 未翻译</p>'
        f"<h1>{html.escape(title)}</h1><p>共 {len(pages)} 页。每次只加载一页正文，"
        "可按目录、PDF 页码或左右方向键切换。</p>"
        f"<p>图、表保留原 PDF 的外观，以 {scale * 72:g} dpi 高清区域图展示，"
        "点击图片可放大；图注保留独立文本。公式预排版，所有资源随包保存。</p>"
        f"<p>已补回 {len(callouts)} 个强调框。算法保留原件排版；识别异常的公式 / 文字"
        "区域显示原 PDF，相关页面有提示。</p>"
        f'<p><a class="pl-start" href="{pages[0]["path"]}">开始阅读 →</a></p>'
        '<p><a href="source.pdf" target="_blank" rel="noopener">打开原 PDF</a> · '
        '<a href="preview.json">产物说明</a></p>'
        f'<p class="pl-note">复用现有 MinerU basic CPU 解析，未重新解析或翻译。'
        f"公式排版失败 {len(failures)} 项，相关页面有提示；识别内容仍需对照原文。</p>"
        f'<details><summary>按 PDF 页码选择</summary><div class="pl-page-list">'
        f'{page_links}</div></details><h2>内容目录</h2><ul class="pl-toc">{toc}</ul></main>'
    )
    (output / "index.html").write_text(document(title, home, in_pages=False), encoding="utf-8")
    shutil.copyfile(run_dir / "source.pdf", output / "source.pdf")
    shutil.copyfile(katex / "LICENSE", output / "KaTeX-LICENSE.txt")
    dist = distribution("docvortex")
    for entry in dist.files:
        if str(entry).endswith(".dist-info/licenses/LICENSE.md"):
            shutil.copyfile(dist.locate_file(entry), output / "DocVortex-LICENSE.txt")
            break
    else:
        raise ValueError("DocVortex license file is required for the preview")
    rendered_count = sum(p["renderedMathCount"] for p in pages)
    write_json(output / "source-layout.json", source_layout(run, layout, callouts))
    shutil.copyfile(SOURCE_LAYOUT_SCHEMA, output / "source-layout.schema.json")
    write_json(
        output / "preview.json",
        {
            "schemaVersion": "pagelingo-static-preview/0.6",
            "sourceRunId": run["runId"],
            "sourceSha256": run["sourceSha256"],
            "sourceManifestSha256": digest(run_dir / "manifest.json"),
            "parserConfig": run["worker"]["config"],
            "sourceStatus": run["status"],
            "sourcePageCount": run["sourcePageCount"],
            "coverage": run["coverage"],
            "requestedPageIndices": run["requestedPageIndices"],
            "reparsed": False,
            "translated": False,
            "renderer": {
                "docvortex": version("docvortex"),
                "katex": package["version"],
                "pdfium": version("pypdfium2"),
                "offline": True,
                "exporterSha256": digest(Path(__file__)),
                "mathExporterSha256": digest(TOOLS / "render-math.cjs"),
                "styleSha256": digest(TOOLS / "preview-reader.css"),
                "navigationSha256": digest(TOOLS / "preview-navigation.js"),
                "sourceProjectionSha256": digest(TOOLS / "preview_source.py"),
                "layoutProjectionSha256": digest(TOOLS / "preview_layout.py"),
                "typographyProjectionSha256": digest(TOOLS / "preview_typography.py"),
                "figureProjectionSha256": digest(TOOLS / "preview_figures.py"),
                "paragraphProjectionSha256": digest(TOOLS / "preview_paragraphs.py"),
                "listProjectionSha256": digest(TOOLS / "preview_lists.py"),
                "sourceEvidenceSha256": digest(TOOLS / "preview_evidence.py"),
                "sourceEvidenceSchemaSha256": digest(SOURCE_LAYOUT_SCHEMA),
                "promptProjectionSha256": digest(TOOLS / "preview_prompts.py"),
                "katexPackage": read_json(katex.parent / "integrity.json"),
            },
            "loading": {
                "mode": "one-source-page-per-document",
                "liveSourcePages": 1,
                "maxPageHtmlBytes": max(p["htmlBytes"] for p in pages),
                "maxPageDomElements": max(p["domElements"] for p in pages),
            },
            "visualPolicy": {
                "mode": "original-pdf-region-png",
                "dpi": scale * 72,
                "paddingPoints": 2,
                "captions": "separate-text",
            },
            "renderedMathCount": rendered_count,
            "mathFallbacks": failures,
            "imageCount": image_count,
            "originalVisuals": visuals,
            "sourceStyles": {
                "callouts": callouts,
                "method": "direct-page-filled-rectangles",
                "nestedForms": "not-projected",
            },
            "sourceLayout": layout,
            "sourceEvidence": {
                "path": "source-layout.json",
                "schema": "source-layout.schema.json",
                "status": "experimental-supplement",
            },
            "pages": [{k: v for k, v in p.items() if k != "filename"} for p in pages],
        },
    )
    write_json(
        output / "manifest.json",
        {
            "schemaVersion": "pagelingo-static-preview-files/1",
            "files": [
                {
                    "path": p.relative_to(output).as_posix(),
                    "bytes": p.stat().st_size,
                    "sha256": digest(p),
                }
                for p in sorted(output.rglob("*"))
                if p.is_file()
            ],
        },
    )
    archive.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as zipped:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                zipped.write(path, path.relative_to(output))
    print(
        f"{title}: {len(pages)} pages, {rendered_count} formulas typeset, "
        f"{len(failures)} fallbacks, {len(visuals)} original PDF visuals; archive {archive}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--katex", type=Path, required=True, help="Verified unpacked KaTeX package")
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--visual-scale", type=float, default=3, help="PDF crop scale; 3 = 216 dpi")
    args = parser.parse_args()
    export(args.run_dir, args.output, args.katex, args.archive, args.visual_scale)

"""Runs in one candidate's virtualenv; controller supplies a whitelisted environment."""

import importlib.metadata
import sys
import time
from pathlib import Path

from .files import read_json, write_json


def docling_parse(request: dict, output: Path) -> dict:
    import torch
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    threads = request["threads"]
    torch.set_num_threads(threads)
    options = PdfPipelineOptions(
        do_ocr=False,
        do_table_structure=True,
        do_formula_enrichment=False,
        do_code_enrichment=False,
        generate_page_images=False,
        generate_picture_images=False,
        enable_remote_services=False,
        artifacts_path=Path(request["modelDir"]) / "docling",
        accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=threads),
    )
    options.layout_options.model_spec.revision = request["weights"]["models"][0]["revision"]
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_options=options, backend=PyPdfiumDocumentBackend
            ),
        }
    )
    started = time.perf_counter()
    result = converter.convert(Path(request["parseInput"]), raises_on_error=False)
    elapsed = time.perf_counter() - started
    write_json(output / "raw.json", result.document.export_to_dict())
    (output / "raw.md").write_text(result.document.export_to_markdown(), encoding="utf-8")
    return {
        "parserStatus": result.status.value,
        "parseSeconds": elapsed,
        "config": {
            "backend": "PyPdfiumDocumentBackend",
            "device": "cpu",
            "threads": threads,
            "ocr": False,
            "tableStructure": True,
            "formulaEnrichment": False,
            "codeEnrichment": False,
            "vlm": False,
            "layout": "heron",
            "formulaFallback": "source page/region image",
        },
        "errors": [error.model_dump(mode="json") for error in result.errors],
    }


def mineru_parse(request: dict, output: Path) -> dict:
    from mineru import MinerUParser
    from mineru.parser.writer import FileBasedDataWriter

    started = time.perf_counter()
    with MinerUParser(tier="basic", parse_mode="txt", image_analysis=True) as parser:
        result = parser.parse(request["parseInput"], page_range="all")
        result.save(FileBasedDataWriter(str(output / "native")))
        raw = read_json(output / "native/middle_json.json")
        write_json(output / "raw.json", raw)
        (output / "raw.md").write_text(result.markdown(), encoding="utf-8")
    return {
        "parserStatus": "success",
        "parseSeconds": time.perf_counter() - started,
        "config": {
            "tier": "basic",
            "smallBackend": "onnx",
            "device": "cpu",
            "parseMode": "txt",
            "imageAnalysis": True,
            "vlm": False,
            "pageRange": "all",
            "threadsRequested": request["threads"],
            "onnxIntraOpThreadsRequested": request["threads"],
            "onnxInterOpThreadsRequested": 1,
        },
        "errors": [],
    }


def main():
    request = read_json(Path(sys.argv[1]))
    output = Path(request["output"])
    parser = request["parser"]
    packages = [parser, "pypdfium2", "pypdf"]
    packages += (
        ["torch", "docling-core", "docling-ibm-models", "transformers"]
        if parser == "docling"
        else ["docvortex", "onnxruntime"]
    )
    versions = {name: importlib.metadata.version(name) for name in packages}
    write_json(output / "worker-start.json", {"versions": versions})
    result = (docling_parse if parser == "docling" else mineru_parse)(request, output)
    write_json(output / "worker-result.json", {**result, "versions": versions})


if __name__ == "__main__":
    main()

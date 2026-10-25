"""Check extracted packages, source evidence and every original-region pixel."""

import argparse
import hashlib
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile

import pypdfium2 as pdfium
from jsonschema import Draft202012Validator
from pagelingo_parser.files import digest, read_json, relative_file, write_json
from PIL import Image
from preview_paragraphs import validate_native_ownership
from preview_validation import check_prompt_coverage


def check_bundle(root, archive):
    preview = read_json(root / "preview.json")
    manifest = read_json(root / "manifest.json")
    files = {entry["path"]: entry for entry in manifest["files"]}
    if len(files) != len(manifest["files"]):
        raise ValueError("Duplicate manifest path")
    with ZipFile(archive) as zipped:
        if sorted(zipped.namelist()) != sorted([*files, "manifest.json"]):
            raise ValueError("Archive and manifest file sets disagree")
        for entry in manifest["files"]:
            target = relative_file(root, entry["path"])
            if target.stat().st_size != entry["bytes"] or digest(target) != entry["sha256"]:
                raise ValueError("Extracted file checksum differs from manifest")
            if hashlib.sha256(zipped.read(entry["path"])).hexdigest() != entry["sha256"]:
                raise ValueError("Archive file checksum differs from extracted file")
    if digest(root / "source.pdf") != preview["sourceSha256"]:
        raise ValueError("Source PDF differs from retained parse source")
    evidence = read_json(root / "source-layout.json")
    schema = read_json(root / "source-layout.schema.json")
    Draft202012Validator(schema).validate(evidence)
    validate_native_ownership(evidence["pages"])
    if evidence["sourceRunId"] != preview["sourceRunId"]:
        raise ValueError("Evidence references a different parse run")
    known = {b["id"] for p in evidence["pages"] for b in p["blocks"]}
    known.update(c["id"] for c in evidence["containers"])
    if any(child not in known for c in evidence["containers"] for child in c["children"]):
        raise ValueError("Unknown container member")
    if preview["reparsed"] or preview["translated"]:
        raise ValueError("These checks apply to retained, untranslated previews")
    by_page = defaultdict(list)
    for visual in preview["originalVisuals"]:
        by_page[visual["sourcePageIndex"]].append(visual)
    pixels_checked = 0
    with pdfium.PdfDocument(root / "source.pdf") as pdf:
        for page_index, records in by_page.items():
            page = pdf[page_index]
            try:
                for scale in sorted({r["scale"] for r in records}):
                    bitmap = page.render(scale=scale)
                    image = bitmap.to_pil().convert("RGB")
                    try:
                        for record in [r for r in records if r["scale"] == scale]:
                            if list(image.size) != record["pagePixels"]:
                                raise ValueError("Source raster size changed")
                            with Image.open(relative_file(root, record["path"])) as actual:
                                expected = image.crop(tuple(record["cropPixels"]))
                                try:
                                    if (
                                        expected.size != actual.size
                                        or expected.tobytes() != actual.convert("RGB").tobytes()
                                    ):
                                        raise ValueError(
                                            "Original-region pixels differ from source PDF"
                                        )
                                finally:
                                    expected.close()
                            pixels_checked += 1
                    finally:
                        image.close()
                        bitmap.close()
            finally:
                page.close()
    prompt_coverage = check_prompt_coverage(root, preview, evidence)
    return {
        "bundle": root.name,
        "archive": archive.name,
        "archiveSha256": digest(archive),
        "sourceRunId": preview["sourceRunId"],
        "sourceSha256": preview["sourceSha256"],
        "filesVerified": len(files),
        "sourceEvidenceSchema": "passed",
        "exclusiveNativeOwnership": "passed",
        "containerReferences": "passed",
        "originalRegionPixelsChecked": pixels_checked,
        "originalRegionPixels": "identical",
        "promptCoverage": prompt_coverage,
        "pages": len(preview["pages"]),
        "reparsed": False,
        "translated": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("bundles", nargs="+", type=Path)
    parser.add_argument("--archive-dir", type=Path, default=Path("releases/pdf-previews"))
    args = parser.parse_args()
    results = []
    for bundle in args.bundles:
        archive_name = bundle.name.removesuffix("-final") + ".zip"
        result = check_bundle(bundle.resolve(), (args.archive_dir / archive_name).resolve())
        results.append(result)
        print(f"{bundle.name}: checksums, schema, source ownership and pixels passed", flush=True)
    write_json(
        args.report,
        {
            "schemaVersion": "pagelingo-preview-package-validation/1",
            "scope": "Archive integrity and source projection; not parser accuracy acceptance",
            "bundles": results,
        },
    )

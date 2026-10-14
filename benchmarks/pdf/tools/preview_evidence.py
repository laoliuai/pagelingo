"""Versioned, inspectable supplement; intentionally not the canonical Reader IR."""

from pathlib import Path

from jsonschema import Draft202012Validator
from pagelingo_parser.files import read_json
from preview_paragraphs import validate_native_ownership

SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "document-contracts"
    / "schemas"
    / "pdf-source-layout.schema.json"
)


def source_layout(run, layout, callouts):
    containers = []
    for record in layout.get("prompts", []):
        repair = record.get("readingOrderRepair")
        if repair:
            page = next(
                p for p in layout["pages"] if p["parsedPageIndex"] == record["parsedPageIndex"]
            )
            page["readingOrder"] = [
                b["id"]
                for index in repair["after"]
                for b in page["blocks"]
                if b["blockIndex"] == index and b["role"] == "content"
            ]
    for page in layout["pages"]:
        roots = {}
        for block in page["blocks"]:
            if "/c" in block["id"]:
                roots.setdefault(block["id"].rsplit("/c", 1)[0], []).append(block["id"])
        containers.extend(
            {"id": identity, "kind": "parser-visual", "children": children}
            for identity, children in roots.items()
        )
    for kind, records in (
        ("callout", callouts),
        ("list", layout["lists"]),
        ("label-rows", layout["definitions"]),
        ("notation", layout["notation"]),
        ("prompt", layout.get("prompts", [])),
    ):
        for ordinal, record in enumerate(records):
            prefix = f"{run['runId']}/p{record['sourcePageIndex']}"
            if kind == "list":
                indices = [
                    index
                    for item in record["items"]
                    for index in [item["blockIndex"], *item["continuationBlockIndices"]]
                ]
            else:
                indices = record.get("blockIndices", [record.get("blockIndex")])
            containers.append(
                {
                    "id": f"{prefix}/{kind}-{ordinal}",
                    "kind": kind,
                    "children": [f"{prefix}/b{i}" for i in dict.fromkeys(indices)],
                    "applied": record.get("applied", True),
                }
            )
    result = {
        "schemaVersion": "pagelingo-pdf-source-layout/2",
        "status": "experimental-supplement",
        "sourceRunId": run["runId"],
        "sourceSha256": run["sourceSha256"],
        "nativeIndexSpace": "pdfium-text-page-character-index",
        "coordinateSpace": "normalized-displayed-crop-box-top-left",
        "rangeConvention": "half-open",
        "readingOrderSource": (
            "retained-parser-with-local-geometric-repairs"
            if any(r.get("readingOrderRepair") for r in layout.get("prompts", []))
            else "retained-parser-block-order"
        ),
        "pages": layout["pages"],
        "containers": containers,
        "supplements": {k: v for k, v in layout.items() if k != "pages"},
        "callouts": callouts,
        "limitations": [
            "Geometric assignments expose ambiguity; they are not calibrated confidence scores.",
            "Native indices identify PDFium text-page characters, not PDF stream glyphs.",
            "Containers reference source leaves; they do not own another copy of their characters.",
            "Rendered line wrapping may differ after translation or changing viewport width.",
            "This supplement is not the formal Reader IR or a parser accuracy acceptance report.",
        ],
    }
    schema = read_json(SCHEMA)
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(result)
    validate_native_ownership(result["pages"])
    known = {b["id"] for p in result["pages"] for b in p["blocks"]}
    known.update(c["id"] for c in containers)
    if any(child not in known for container in containers for child in container["children"]):
        raise ValueError("Source container refers to an unknown source leaf")
    return result

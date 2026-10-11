"""Rebuild a projection from immutable parser artifacts without rerunning inference."""

import shutil
import time
import uuid
from pathlib import Path

from jsonschema import Draft202012Validator

from .controller import PROJECT, SCHEMA, diagnostics
from .debug import build_debug
from .files import digest, read_json, relative_file, write_json
from .normalize import normalize


def reproject(source_run: Path, output: Path) -> dict:
    source_run, output = source_run.resolve(), output.resolve()
    if output.exists():
        raise ValueError("Projection output already exists; use a new directory")
    original = read_json(source_run / "run.json")
    if original["status"] not in {"complete", "partial"}:
        raise ValueError("Only a run with completed parser output can be reprojected")
    for entry in read_json(source_run / "manifest.json")["files"]:
        path = relative_file(source_run, entry["path"])
        if digest(path) != entry["sha256"]:
            raise ValueError("Original run changed; cannot reuse its parse measurement")
    started = time.perf_counter()
    output.mkdir(parents=True)
    for name in (
        "source.pdf",
        "source-inspection.json",
        "raw.json",
        "raw.md",
        "worker-result.json",
    ):
        shutil.copyfile(source_run / name, output / name)
    if (source_run / "native").is_dir():
        shutil.copytree(source_run / "native", output / "native")
    source = read_json(output / "source-inspection.json")
    selected = original["requestedPageIndices"]
    document = normalize(
        original["parser"],
        read_json(output / "raw.json"),
        selected,
        source,
        original["sourceSha256"],
    )
    if original["worker"]["parserStatus"] != "success" or original["worker"]["errors"]:
        document["status"] = "partial"
    document["pages"] = [
        {key: value for key, value in source["pages"][index].items() if key != "nativeText"}
        for index in selected
    ]
    build_debug(output / "source.pdf", output, document)
    Draft202012Validator(read_json(SCHEMA)).validate(document)
    write_json(output / "normalized.json", document)
    result = {
        **original,
        "runId": str(uuid.uuid4()),
        "status": document["status"],
        "diagnostics": diagnostics(document, source),
        "warnings": document["warnings"],
        "reprojection": {
            "sourceRunId": original["runId"],
            "sourceManifestSha256": digest(source_run / "manifest.json"),
            "sourceRun": str(source_run),
            "projectionSeconds": round(time.perf_counter() - started, 3),
            "codeFiles": {
                p.relative_to(PROJECT).as_posix(): digest(p)
                for p in sorted((PROJECT / "src").rglob("*.py"))
            },
            "schemaSha256": digest(SCHEMA),
            "resourcesOrigin": "Copied from original parser run; inference was not rerun",
        },
    }
    write_json(output / "run.json", result)
    write_json(
        output / "manifest.json",
        {
            "schemaVersion": "pagelingo-run-files/1",
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
    print(f"Reprojected {original['parser']} → {output}; original inference unchanged", flush=True)
    return result

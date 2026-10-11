"""Dependency-isolated, time-bounded parser runs with auditable coverage and resources."""

import hashlib
import math
import os
import platform
import shutil
import signal
import subprocess
import time
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import psutil
from jsonschema import Draft202012Validator

from .debug import build_debug
from .files import digest, read_json, write_json
from .models import verify_prepared_models
from .normalize import TEXT_KINDS, normalize
from .pdf import extract_pdf, inspect_pdf, parse_page_selection

PROJECT = Path(__file__).resolve().parents[2]
REPO = PROJECT.parent.parent
MODEL_LOCK = REPO / "benchmarks/pdf/models.lock.json"
SCHEMA = REPO / "packages/document-contracts/schemas/parser-evaluation.schema.json"


def worker_environment(model_dir: Path, threads: int) -> dict:
    # Copy only process/OS settings. Never pass .env.local, DATABASE_URL, OPENAI_* or HF tokens.
    inherited = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR")
    env = {key: os.environ[key] for key in inherited if key in os.environ}
    env.update(
        {
            "PYTHONUNBUFFERED": "1",
            "HF_HOME": str(model_dir / "hf"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "CUDA_VISIBLE_DEVICES": "",
            "OMP_NUM_THREADS": str(threads),
            "MKL_NUM_THREADS": str(threads),
            "OPENBLAS_NUM_THREADS": str(threads),
            "MINERU_HOME": str(model_dir / "mineru"),
            "MINERU_MODEL_SOURCE": "local",
            "MINERU_MODEL_BASE_DIR": str(model_dir / "mineru/models"),
            "MINERU_MODEL_SMALL_BACKEND": "onnx",
            "MINERU_DEVICE_MODE": "cpu",
            "MINERU_TABLE_DEVICE": "cpu",
            "MINERU_INTRA_OP_NUM_THREADS": str(threads),
            "MINERU_INTER_OP_NUM_THREADS": "1",
            "MINERU_LOG_LEVEL": "info",
            "TOKENIZERS_PARALLELISM": "false",
        }
    )
    return env


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=5)


def monitor_worker(command: list[str], log: Path, env: dict, timeout: float) -> dict:
    started = time.perf_counter()
    peak = 0
    timed_out = False
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(
            command,
            stdout=stream,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=os.name == "posix",
            cwd=PROJECT,
        )
        try:
            while process.poll() is None:
                if time.perf_counter() - started > timeout:
                    timed_out = True
                    stop_process(process)
                    break
                try:
                    root = psutil.Process(process.pid)
                    resident = sum(
                        member.memory_info().rss
                        for member in [root, *root.children(recursive=True)]
                        if member.is_running()
                    )
                    peak = max(peak, resident)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
                time.sleep(0.2)
        finally:
            stop_process(process)
    return {
        "workerSeconds": round(time.perf_counter() - started, 3),
        "peakProcessTreeRssMiB": round(peak / 1024**2, 1),
        "rssSamplingIntervalMs": 200,
        "exitCode": process.returncode,
        "timedOut": timed_out,
        "gpu": "disabled; CPU-only profile",
        "cacheState": "weights prepared; fresh worker process",
    }


def diagnostics(document: dict, source: dict) -> dict:
    top = [b for b in document["blocks"] if b["parentId"] is None]
    native_chars = sum(
        len(source["pages"][i]["nativeText"]) for i in document["requestedPageIndices"]
    )
    text_chars = sum(len(b["text"]) for b in top)
    return {
        "selectedPages": len(document["requestedPageIndices"]),
        "parsedPages": len(document["parsedPageIndices"]),
        "topLevelBlocks": len(top),
        "allBlocksIncludingChildren": len(document["blocks"]),
        "topLevelKinds": dict(Counter(b["kind"] for b in top)),
        "nativeTextChars": native_chars,
        "parserTopLevelTextChars": text_chars,
        "translatableBlocksWithoutSource": sum(
            b["kind"] in TEXT_KINDS and not b["sourceRefs"] for b in top
        ),
        "bboxSourceRefs": sum(r["precision"] == "bbox" for b in top for r in b["sourceRefs"]),
        "pageOnlySourceRefs": sum(r["precision"] == "page" for b in top for r in b["sourceRefs"]),
        "qualityMetrics": {
            "textRetention": None,
            "adjacentReadingOrder": None,
            "formulaAccuracy": None,
            "reason": "Requires annotated golden corpus",
        },
        "note": "Counts and native text lengths are diagnostics, not completeness/accuracy scores.",
    }


def run_parse(
    input_path: Path,
    parser: str,
    output: Path,
    model_dir: Path,
    pages: str = "all",
    threads: int = 4,
    timeout: float = 1800,
    previews: bool = True,
) -> dict:
    input_path, output, model_dir = input_path.resolve(), output.resolve(), model_dir.resolve()
    if output.exists():
        raise ValueError("Output already exists; each run must be immutable and separate")
    if threads < 1 or timeout <= 0 or not math.isfinite(timeout):
        raise ValueError("Threads and timeout must be positive")
    python = PROJECT / f".venv-{parser}/bin/python"
    if not python.exists():
        raise ValueError(f"Candidate environment missing: uv sync --extra {parser}")
    weights = verify_prepared_models(MODEL_LOCK, model_dir, parser)
    source = inspect_pdf(input_path)
    selected = parse_page_selection(pages, source["pageCount"])
    output.mkdir(parents=True)
    source_hash = digest(input_path)
    shutil.copyfile(input_path, output / "source.pdf")
    if digest(output / "source.pdf") != source_hash:
        raise ValueError("Source changed while creating the run snapshot")
    parse_input = output / "source.pdf"
    if selected != list(range(source["pageCount"])):
        parse_input = output / "parse-input.pdf"
        extract_pdf(output / "source.pdf", selected, parse_input)
    write_json(output / "source-inspection.json", source)
    request = {
        "runId": str(uuid.uuid4()),
        "parser": parser,
        "output": str(output),
        "parseInput": str(parse_input),
        "modelDir": str(model_dir),
        "sourceSha256": source_hash,
        "parseInputSha256": digest(parse_input),
        "sourcePageCount": source["pageCount"],
        "requestedPageIndices": selected,
        "threads": threads,
        "weights": weights,
    }
    write_json(output / "request.json", request)
    result = {
        "schemaVersion": "pagelingo-benchmark-run/1",
        "runId": request["runId"],
        "createdAt": datetime.now(UTC).isoformat(),
        "parser": parser,
        "input": input_path.name,
        "sourceSha256": source_hash,
        "sourcePageCount": source["pageCount"],
        "requestedPageIndices": selected,
        "coverage": "full" if len(selected) == source["pageCount"] else "sample",
        "status": "failed",
        "modelLockSha256": digest(MODEL_LOCK),
        "pythonLockSha256": digest(PROJECT / "uv.lock"),
        "schemaSha256": digest(SCHEMA),
        "adapterCodeSha256": hashlib.sha256(
            "\n".join(
                f"{p.relative_to(PROJECT).as_posix()}:{digest(p)}"
                for p in sorted((PROJECT / "src").rglob("*.py"))
            ).encode()
        ).hexdigest(),
        "host": {
            "os": platform.platform(),
            "cpuThreads": os.cpu_count(),
            "ramGiB": round(psutil.virtual_memory().total / 1024**3, 1),
        },
    }
    print(f"{parser}: {len(selected)}/{source['pageCount']} pages → {output.name}", flush=True)
    try:
        result["resources"] = monitor_worker(
            [str(python), "-m", "pagelingo_parser.worker", str(output / "request.json")],
            output / "worker.log",
            worker_environment(model_dir, threads),
            timeout,
        )
        if result["resources"]["timedOut"]:
            result["status"] = "timeout"
        elif result["resources"]["exitCode"] != 0:
            result["status"] = "failed"
        else:
            worker = read_json(output / "worker-result.json")
            result["worker"] = worker
            document = normalize(
                parser, read_json(output / "raw.json"), selected, source, source_hash
            )
            if worker["parserStatus"] != "success" or worker["errors"]:
                document["status"] = "partial"
                document["warnings"].append(
                    {"code": "parser_partial", "status": worker["parserStatus"]}
                )
            document["pages"] = [
                {k: v for k, v in source["pages"][i].items() if k != "nativeText"} for i in selected
            ]
            build_debug(output / "source.pdf", output, document, render_all=previews)
            Draft202012Validator(read_json(SCHEMA)).validate(document)
            write_json(output / "normalized.json", document)
            result.update(
                {
                    "status": document["status"],
                    "diagnostics": diagnostics(document, source),
                    "warnings": document["warnings"],
                    "debug": "debug.html",
                }
            )
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        # A failure still leaves logs, resources, inputs and any raw output for inspection.
        write_json(output / "run.json", result)
        files = [
            {
                "path": p.relative_to(output).as_posix(),
                "bytes": p.stat().st_size,
                "sha256": digest(p),
            }
            for p in sorted(output.rglob("*"))
            if p.is_file()
        ]
        write_json(
            output / "manifest.json", {"schemaVersion": "pagelingo-run-files/1", "files": files}
        )
    print(f"{parser}: {result['status']} — see {output / 'run.json'}", flush=True)
    return result

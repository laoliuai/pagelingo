"""Sequential smoke/full corpus runs; downloaded public samples are explicitly requested."""

import urllib.parse
import urllib.request
from pathlib import Path

from .controller import REPO, run_parse
from .files import digest, read_json, relative_file, write_json


def corpus_samples(corpus: Path, sample_ids: list[str] | None = None) -> list[dict]:
    samples = read_json(corpus)["samples"]
    known = {sample["id"] for sample in samples}
    if sample_ids and set(sample_ids) - known:
        raise ValueError("Unknown corpus sample id")
    return [sample for sample in samples if not sample_ids or sample["id"] in sample_ids]


def fetch_corpus(corpus: Path, sample_ids: list[str] | None = None):
    for sample in corpus_samples(corpus, sample_ids):
        path = relative_file(REPO, sample["path"])
        if path.exists():
            if digest(path) != sample["sha256"]:
                raise ValueError(f"Corpus checksum changed: {sample['id']}")
            print(f"Verified {sample['id']}", flush=True)
            continue
        if not sample.get("downloadUrl"):
            print(f"User-supplied sample missing: {sample['path']}", flush=True)
            continue
        url = sample["downloadUrl"]
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != "arxiv.org":
            raise ValueError("P0 downloader only accepts public arxiv.org HTTPS sources")
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".part")
        try:
            print(f"Downloading {sample['id']} from arXiv", flush=True)
            with urllib.request.urlopen(url, timeout=30) as response, temp.open("wb") as stream:
                while chunk := response.read(1024 * 1024):
                    stream.write(chunk)
            if digest(temp) != sample["sha256"]:
                raise ValueError("Downloaded PDF differs from pinned corpus bytes")
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def benchmark(
    corpus: Path,
    parsers: list[str],
    output: Path,
    model_dir: Path,
    mode: str,
    sample_ids: list[str] | None,
    timeout: float,
    threads: int,
) -> dict:
    if output.exists():
        raise ValueError("Benchmark directory already exists; choose a new run directory")
    samples = corpus_samples(corpus, sample_ids)
    # Validate every input before starting a batch. No implicit network/download side effects.
    for sample in samples:
        path = relative_file(REPO, sample["path"])
        if not path.is_file() or digest(path) != sample["sha256"]:
            raise ValueError(f"Missing/changed input {sample['id']}; use fetch-corpus explicitly")
    output.mkdir(parents=True)
    summary = {
        "schemaVersion": "pagelingo-pdf-benchmark/1",
        "mode": mode,
        "corpusSha256": digest(corpus),
        "runs": [],
    }
    for parser in parsers:
        for sample in samples:
            run_dir = output / f"{parser}-{sample['id']}"
            try:
                result = run_parse(
                    relative_file(REPO, sample["path"]),
                    parser,
                    run_dir,
                    model_dir,
                    sample["smokePages"] if mode == "smoke" else "all",
                    threads,
                    timeout,
                )
            except Exception as error:
                result = {
                    "status": "failed",
                    "error": {"type": type(error).__name__, "message": str(error)},
                }
            summary["runs"].append(
                {"sampleId": sample["id"], "parser": parser, "path": run_dir.name, "result": result}
            )
            write_json(output / "summary.json", summary)
    return summary

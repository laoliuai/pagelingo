import argparse
import json
from pathlib import Path

from .benchmark import benchmark, fetch_corpus
from .controller import MODEL_LOCK, REPO, run_parse
from .models import prepare_models
from .pdf import inspect_pdf
from .reproject import reproject


def main():
    cli = argparse.ArgumentParser(description="PageLingo PDF P0 (local CPU profiles, no LLM calls)")
    sub = cli.add_subparsers(dest="command", required=True)
    inspect = sub.add_parser("inspect", help="List source metadata/page counts without ML models")
    inspect.add_argument("input", type=Path)
    weights = sub.add_parser("prepare-models", help="Explicitly download pinned public model files")
    weights.add_argument("--parser", choices=["docling", "mineru"], required=True)
    weights.add_argument("--model-dir", type=Path, default=REPO / "data/models")
    parse = sub.add_parser("parse", help="Run a parser and export raw/normalized/debug artifacts")
    parse.add_argument("input", type=Path)
    parse.add_argument("--parser", choices=["docling", "mineru"], required=True)
    parse.add_argument("--output", type=Path, required=True)
    parse.add_argument("--model-dir", type=Path, default=REPO / "data/models")
    parse.add_argument("--pages", default="all", help="all (default) or explicit 1-based 1,3-5")
    parse.add_argument("--threads", type=int, default=4)
    parse.add_argument("--timeout", type=float, default=1800, help="Worker timeout in seconds")
    parse.add_argument(
        "--limit-previews", action="store_true", help="Preview only first 12 selected pages"
    )
    for name in ("fetch-corpus", "benchmark"):
        command = sub.add_parser(name)
        command.add_argument("--corpus", type=Path, default=REPO / "benchmarks/pdf/corpus.json")
        command.add_argument(
            "--sample", action="append", help="Corpus id; repeat to select several"
        )
        if name == "benchmark":
            command.add_argument(
                "--parser", action="append", choices=["docling", "mineru"], required=True
            )
            command.add_argument("--output", type=Path, required=True)
            command.add_argument("--model-dir", type=Path, default=REPO / "data/models")
            command.add_argument("--mode", choices=["smoke", "full"], default="smoke")
            command.add_argument("--timeout", type=float, default=1800)
            command.add_argument("--threads", type=int, default=4)
    projection = sub.add_parser("reproject", help="Rebuild from existing raw output; no inference")
    projection.add_argument("source_run", type=Path)
    projection.add_argument("--output", type=Path, required=True)
    args = cli.parse_args()
    if args.command == "inspect":
        data = inspect_pdf(args.input)
        for page in data["pages"]:
            page["nativeTextChars"] = len(page.pop("nativeText"))
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "prepare-models":
        prepare_models(MODEL_LOCK, args.model_dir.resolve(), args.parser)
    elif args.command == "fetch-corpus":
        fetch_corpus(args.corpus, args.sample)
    elif args.command == "benchmark":
        summary = benchmark(
            args.corpus,
            args.parser,
            args.output,
            args.model_dir,
            args.mode,
            args.sample,
            args.timeout,
            args.threads,
        )
        if any(run["result"]["status"] != "complete" for run in summary["runs"]):
            raise SystemExit(1)
    elif args.command == "reproject":
        reproject(args.source_run, args.output)
    else:
        result = run_parse(
            args.input,
            args.parser,
            args.output,
            args.model_dir,
            args.pages,
            args.threads,
            args.timeout,
            not args.limit_previews,
        )
        if result["status"] != "complete":
            raise SystemExit(1)


if __name__ == "__main__":
    main()

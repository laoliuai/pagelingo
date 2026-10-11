"""Explicit weight preparation. Parsing itself always runs offline with pinned files."""

import hashlib
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .files import digest, read_json, relative_file, write_json


def prepare_models(lock_path: Path, model_dir: Path, candidate: str) -> None:
    lock = read_json(lock_path)
    prepared = []
    for repo in lock["models"]:
        if repo["candidate"] != candidate:
            continue
        root = relative_file(model_dir, repo["directory"])
        root.mkdir(parents=True, exist_ok=True)
        recorded_files = []
        for entry in repo["files"]:
            target = relative_file(root, entry["path"])
            if not target.exists() or not valid_model_file(target, entry):
                print(f"Downloading {repo['repoId']}: {entry['path']}", flush=True)
                target.parent.mkdir(parents=True, exist_ok=True)
                url = (
                    f"https://huggingface.co/{repo['repoId']}/resolve/{repo['revision']}/"
                    + urllib.parse.quote(entry["path"], safe="/")
                )
                temporary = target.with_name(target.name + ".part")
                for attempt in range(3):
                    try:
                        request = urllib.request.Request(
                            url, headers={"User-Agent": "PageLingo-P0"}
                        )
                        with urllib.request.urlopen(request, timeout=30) as response:
                            with temporary.open("wb") as stream:
                                while chunk := response.read(1024 * 1024):
                                    stream.write(chunk)
                        if not valid_model_file(temporary, entry):
                            raise ValueError("Downloaded model failed its size/content checksum")
                        temporary.replace(target)
                        break
                    except Exception:
                        temporary.unlink(missing_ok=True)
                        if attempt == 2:
                            raise
                        time.sleep(attempt + 1)
            recorded_files.append(
                {"path": entry["path"], "bytes": target.stat().st_size, "sha256": digest(target)}
            )
        prepared.append(
            {**{k: v for k, v in repo.items() if k != "files"}, "files": recorded_files}
        )
    if not prepared:
        raise ValueError("No model profile for this candidate")
    write_json(
        model_dir / f"{candidate}-weights.json",
        {
            "schemaVersion": "pagelingo-weights/1",
            "modelLockSha256": digest(lock_path),
            "models": prepared,
        },
    )
    print(f"Prepared {candidate} weights; subsequent parsing is offline.", flush=True)


def valid_model_file(path: Path, entry: dict) -> bool:
    if path.stat().st_size != entry["bytes"]:
        return False
    if entry.get("sha256"):
        return digest(path) == entry["sha256"]
    # HF's Git blob digest for small non-LFS files, not a plain SHA-1 of contents.
    value = hashlib.sha1(usedforsecurity=False)
    value.update(f"blob {path.stat().st_size}\0".encode())
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest() == entry["gitBlobId"]


def verify_prepared_models(lock_path: Path, model_dir: Path, candidate: str) -> dict:
    manifest = read_json(model_dir / f"{candidate}-weights.json")
    if manifest["modelLockSha256"] != digest(lock_path):
        raise ValueError("Weights were prepared with another model lock")
    for repo in manifest["models"]:
        root = relative_file(model_dir, repo["directory"])
        for entry in repo["files"]:
            file = relative_file(root, entry["path"])
            if file.stat().st_size != entry["bytes"] or digest(file) != entry["sha256"]:
                raise ValueError("Prepared model file has changed; prepare weights again")
    return manifest

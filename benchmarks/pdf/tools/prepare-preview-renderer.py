"""Explicitly prepare an integrity-checked KaTeX package for static P0 exports."""

import argparse
import base64
import hashlib
import io
import json
import tarfile
import urllib.request
from pathlib import Path


def prepare(output: Path) -> None:
    lock = json.loads(Path(__file__).with_name("preview-renderer.lock.json").read_text())
    if output.exists():
        raise ValueError("Use a new dependency directory")
    with urllib.request.urlopen(lock["source"], timeout=60) as response:
        data = response.read()
    actual = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != lock["integrity"]:
        raise ValueError("KaTeX package integrity mismatch")
    output.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as package:
        package.extractall(output, filter="data")
    (output / "integrity.json").write_text(json.dumps(lock, indent=2) + "\n")
    print(f"Verified {lock['name']} {lock['version']} → {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    prepare(parser.parse_args().output)

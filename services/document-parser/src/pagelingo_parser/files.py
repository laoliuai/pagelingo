"""Small file helpers shared by the controller and dependency-isolated workers."""

import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def relative_file(root: Path, name: str) -> Path:
    """Reject absolute paths, traversal and existing symlinks escaping a run root."""
    if not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("Asset path must be relative and contained in its run")
    target = root / name
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Asset path escapes its run")
    return target

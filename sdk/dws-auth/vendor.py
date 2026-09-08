#!/usr/bin/env python3
"""Vendor the canonical build sources so plugin CI needs only its own checkout."""

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ("plugin-auth", "plugin-auth-go", "dws-auth")
SUFFIXES = {".py", ".go", ".md", ".tmpl", ".inc"}
INVENTORY = "account-auth-build.json"


def source_files() -> dict[str, bytes]:
    files = {}
    for component in COMPONENTS:
        for path in sorted((ROOT / component).rglob("*")):
            if "__pycache__" in path.parts:
                continue
            if path.is_symlink():
                raise ValueError("Build sources must not contain symbolic links")
            if path.is_file() and (
                path.suffix in SUFFIXES or path.name in {"LICENSE", "NOTICE", "go.mod"}
            ):
                files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    return files


def bundle(repository: Path, *, check: bool = False) -> None:
    files = source_files()
    inventory = {
        "schemaVersion": 1,
        "source": "Wegent/sdk",
        "files": {
            name: hashlib.sha256(content).hexdigest() for name, content in files.items()
        },
    }
    files[INVENTORY] = (json.dumps(inventory, indent=2) + "\n").encode()
    target = repository / "plugins/dingtalk/.wework-build"
    if target.is_symlink():
        raise ValueError("Build support destination must not be a symbolic link")
    actual = set()
    for path in target.rglob("*"):
        if "__pycache__" in path.parts:
            continue
        if path.is_symlink():
            raise ValueError("Build support destination contains a symbolic link")
        if path.is_file():
            actual.add(path.relative_to(target).as_posix())
    if check:
        if actual != set(files) or any(
            (target / name).read_bytes() != content for name, content in files.items()
        ):
            raise ValueError("Vendored build sources differ from the canonical SDK")
        return
    if actual - set(files):
        raise ValueError("Build support destination contains unexpected files")
    for name, content in files.items():
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    bundle(arguments.repository, check=arguments.check)


if __name__ == "__main__":
    main()

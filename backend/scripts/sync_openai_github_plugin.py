#!/usr/bin/env python3
"""Synchronize the pinned OpenAI GitHub plugin with the Wegent adapter."""

from __future__ import annotations

import argparse
import io
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.plugin_package_scanner import scan_plugin_package  # noqa: E402
from app.services.plugin_upstream_adapter import (  # noqa: E402
    OPENAI_GITHUB_MARKETPLACE,
    OPENAI_GITHUB_REMOTE_PLUGIN_ID,
    adapt_upstream_package,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TARGET = REPOSITORY_ROOT / "curated-plugins" / "openai" / "github"
LOCK_FILE = TARGET / "upstream.lock.json"
PRESERVED_FILES = {"UPSTREAM.md", "upstream.lock.json"}


def _download_archive(repository: str, commit: str) -> bytes:
    url = f"{repository.rstrip('/')}/archive/{commit}.zip"
    with httpx.Client(
        timeout=30,
        follow_redirects=True,
        headers={"User-Agent": "wegent-plugin-sync"},
    ) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.content


def _extract_plugin_package(package: bytes, subdirectory: str) -> bytes:
    subdirectory_parts = PurePosixPath(subdirectory).parts
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as selected:
            for member in archive.infolist():
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts:
                    raise ValueError(f"Unsafe upstream archive path: {member.filename}")
                parts = path.parts
                if len(parts) <= len(subdirectory_parts):
                    continue
                if tuple(parts[1 : 1 + len(subdirectory_parts)]) != subdirectory_parts:
                    continue
                relative = PurePosixPath(*parts[1 + len(subdirectory_parts) :])
                if member.is_dir() or not relative.parts:
                    continue
                copied = zipfile.ZipInfo(relative.as_posix(), member.date_time)
                copied.create_system = member.create_system
                copied.external_attr = member.external_attr
                copied.internal_attr = member.internal_attr
                copied.flag_bits = member.flag_bits
                copied.compress_type = zipfile.ZIP_DEFLATED
                selected.writestr(copied, archive.read(member))
    return output.getvalue()


def _extract_package(package: bytes, destination: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        for member in archive.infolist():
            path = PurePosixPath(member.filename)
            if path.is_absolute() or ".." in path.parts or member.is_dir():
                continue
            output = destination.joinpath(*path.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(archive.read(member))


def _tree_digest(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name not in PRESERVED_FILES
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail when the pinned upstream snapshot differs from the working tree",
    )
    args = parser.parse_args()
    lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
    package = _download_archive(lock["repository"], lock["commit"])
    selected = _extract_plugin_package(package, lock["subdirectory"])
    scan_plugin_package(selected)
    adapted = adapt_upstream_package(
        provider="codex",
        marketplace_name=OPENAI_GITHUB_MARKETPLACE,
        remote_plugin_id=OPENAI_GITHUB_REMOTE_PLUGIN_ID,
        package=selected,
    )
    if adapted.upstream_version != str(lock["upstreamVersion"]):
        raise ValueError(
            "Pinned upstream version does not match upstream.lock.json: "
            f"{adapted.upstream_version}"
        )
    if adapted.adapter_version != str(lock["adapterVersion"]):
        raise ValueError("GitHub adapter version does not match upstream.lock.json")
    with tempfile.TemporaryDirectory(prefix="wegent-openai-github-") as directory:
        generated = Path(directory)
        _extract_package(adapted.package, generated)
        if args.check:
            if _tree_digest(generated) != _tree_digest(TARGET):
                raise SystemExit("OpenAI GitHub plugin snapshot is out of date")
            return 0
        preserved = {
            name: (TARGET / name).read_bytes()
            for name in PRESERVED_FILES
            if (TARGET / name).exists()
        }
        shutil.rmtree(TARGET)
        shutil.copytree(generated, TARGET)
        for name, content in preserved.items():
            (TARGET / name).write_bytes(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

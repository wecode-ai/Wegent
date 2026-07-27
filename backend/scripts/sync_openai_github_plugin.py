#!/usr/bin/env python3
"""Synchronize the pinned OpenAI GitHub plugin with the Wegent adapter."""

from __future__ import annotations

import argparse
import io
import json
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

import httpx

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


def _extract_plugin(package: bytes, subdirectory: str, destination: Path) -> None:
    subdirectory_parts = PurePosixPath(subdirectory).parts
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        for member in archive.infolist():
            path = PurePosixPath(member.filename)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"Unsafe upstream archive path: {member.filename}")
            parts = path.parts
            if len(parts) <= len(subdirectory_parts):
                continue
            if tuple(parts[1 : 1 + len(subdirectory_parts)]) != subdirectory_parts:
                continue
            relative = Path(*parts[1 + len(subdirectory_parts) :])
            if member.is_dir():
                (destination / relative).mkdir(parents=True, exist_ok=True)
                continue
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(archive.read(member))


def _apply_adapter(
    root: Path,
    *,
    expected_upstream_version: str,
    adapter_version: str,
) -> None:
    required = {
        ".codex-plugin/plugin.json",
        "skills/github/SKILL.md",
        "skills/gh-address-comments/LICENSE.txt",
        "skills/gh-fix-ci/LICENSE.txt",
        "skills/yeet/LICENSE.txt",
    }
    missing = sorted(path for path in required if not (root / path).is_file())
    if missing:
        raise ValueError(f"Upstream GitHub plugin is missing: {', '.join(missing)}")
    manifest_path = root / ".codex-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    upstream_version = str(manifest["version"])
    if upstream_version != expected_upstream_version:
        raise ValueError(
            "Pinned upstream version does not match upstream.lock.json: "
            f"{upstream_version}"
        )
    manifest["version"] = f"{upstream_version}+wegent.{adapter_version}"
    manifest.pop("apps", None)
    manifest.pop("mcpServers", None)
    manifest["connectors"] = [{"slug": "github", "authPolicy": "on_install"}]
    interface = manifest.get("interface")
    if isinstance(interface, dict):
        interface["logo"] = "./assets/github-small.svg"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (root / ".app.json").unlink(missing_ok=True)
    (root / ".mcp.json").unlink(missing_ok=True)


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
    with tempfile.TemporaryDirectory(prefix="wegent-openai-github-") as directory:
        generated = Path(directory)
        _extract_plugin(package, lock["subdirectory"], generated)
        _apply_adapter(
            generated,
            expected_upstream_version=str(lock["upstreamVersion"]),
            adapter_version=str(lock["adapterVersion"]),
        )
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

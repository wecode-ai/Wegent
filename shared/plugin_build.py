"""Declarative plugin builds shared by local publication and repository CI."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Mapping

DECLARATION = ".wework-build.json"
MAX_ARCHIVE = 50 * 1024 * 1024
MAX_EXPANDED = 200 * 1024 * 1024
IGNORED = {".git", "__pycache__", ".pytest_cache", "node_modules", ".DS_Store"}


def _relative(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("Plugin build paths must be relative POSIX paths")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value:
        raise ValueError("Plugin build paths must be normalized and contained")
    return value


def declaration(files: Mapping[str, bytes]) -> dict | None:
    raw = files.get(DECLARATION)
    if raw is None:
        return None
    if len(raw) > 16384:
        raise ValueError("Plugin build declaration is too large")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "entrypoint",
        "outputs",
    }:
        raise ValueError("Invalid plugin build declaration")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise ValueError("Unsupported plugin build schema")
    entry = _relative(value["entrypoint"])
    if (
        not entry.startswith(".wework-build/")
        or not entry.endswith(".py")
        or entry not in files
    ):
        raise ValueError("Plugin build entrypoint must be bundled under .wework-build")
    outputs = value["outputs"]
    if not isinstance(outputs, list) or not 1 <= len(outputs) <= 16:
        raise ValueError("Plugin build outputs must declare 1 to 16 directories")
    for output in outputs:
        output = _relative(output)
        if output.split("/")[0].startswith(".") or output in {
            "scripts",
            "skills",
            "assets",
        }:
            raise ValueError(
                "Plugin build output cannot replace source or metadata roots"
            )
    if len(set(outputs)) != len(outputs) or any(
        a.startswith(b + "/") for a in outputs for b in outputs if a != b
    ):
        raise ValueError("Plugin build output directories overlap")
    return value


def source_paths(
    files: Mapping[str, bytes], *, require_outputs: bool = False
) -> set[str]:
    value = declaration(files)
    if value is None:
        return set(files)
    outputs = value["outputs"]
    if require_outputs and any(
        not any(p.startswith(d + "/") for p in files) for d in outputs
    ):
        raise ValueError("Plugin build output is missing; publish the completed build")
    return {
        p for p in files if not any(p == d or p.startswith(d + "/") for d in outputs)
    }


def read_source(root: Path) -> dict[str, tuple[bytes, int]]:
    files = {}
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part in IGNORED or part.endswith(".pyc") for part in relative.parts):
            continue
        if path.is_symlink():
            raise ValueError("Plugin build source contains a symbolic link")
        if path.is_dir():
            continue
        if not path.is_file() or path.stat().st_size > MAX_EXPANDED:
            raise ValueError("Plugin build source must contain bounded regular files")
        content = path.read_bytes()
        total += len(content)
        if total > MAX_EXPANDED or len(files) >= 10000:
            raise ValueError("Plugin build source exceeds package limits")
        files[relative.as_posix()] = (
            content,
            0o755 if path.stat().st_mode & 0o111 else 0o644,
        )
    return files


def archive_files(path: Path) -> dict[str, tuple[bytes, int]]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ARCHIVE:
        raise ValueError("Plugin build output must be a bounded regular ZIP")
    files = {}
    total = 0
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            name = _relative(member.filename)
            mode = member.external_attr >> 16
            total += member.file_size
            if (
                member.is_dir()
                or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                or name in files
                or total > MAX_EXPANDED
                or len(files) >= 10000
            ):
                raise ValueError("Invalid plugin build archive member")
            files[name] = (archive.read(member), 0o755 if mode & 0o111 else 0o644)
    return files


def run_build(source: Path, output: Path) -> bool:
    """Build in an isolated copy, preserving every reviewed input byte and mode."""
    original = read_source(source)
    content = {p: item[0] for p, item in original.items()}
    value = declaration(content)
    if value is None:
        return False
    if source_paths(content) != set(content):
        raise ValueError("Generated plugin outputs must not be checked into source")
    with tempfile.TemporaryDirectory(prefix="wework-plugin-build-") as temporary:
        root = Path(temporary)
        staged = root / "source"
        for name, (data, mode) in original.items():
            destination = staged / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(mode)
        candidate = root / "plugin.zip"
        # Build code is contributor-controlled. No CI or publication credentials
        # are inherited, and the build HOME contains no personal provider state.
        allowed = {
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "LANG",
            "LC_ALL",
            "TZ",
        }
        environment = {k: v for k, v in os.environ.items() if k in allowed}
        home = root / "home"
        home.mkdir()
        environment.update(
            {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUTF8": "1",
            }
        )
        # These caches contain compiler inputs/outputs, never provider credentials.
        for name in ("GOCACHE", "GOMODCACHE"):
            if os.environ.get(name):
                environment[name] = os.environ[name]
        subprocess.run(
            [
                sys.executable,
                str(staged / value["entrypoint"]),
                "--plugin",
                str(staged),
                "--output",
                str(candidate),
            ],
            cwd=staged,
            env=environment,
            check=True,
            timeout=1800,
        )
        built = archive_files(candidate)
        kept = source_paths(
            {p: item[0] for p, item in built.items()}, require_outputs=True
        )
        if {p: built[p] for p in kept} != original:
            raise ValueError("Plugin build changed reviewed source files")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(candidate.read_bytes())
    return True


def extract_archive(archive: Path, destination: Path) -> None:
    """Restore validated release files, including native executable permissions."""
    if destination.is_symlink():
        raise ValueError("Plugin extraction destination must not be a symbolic link")
    root = destination.resolve()
    for name, (data, mode) in archive_files(archive).items():
        target = root / name
        if not target.resolve().is_relative_to(root):
            raise ValueError("Plugin archive entry escapes its destination")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(mode)

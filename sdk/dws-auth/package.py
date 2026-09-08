#!/usr/bin/env python3
"""Build a self-contained DingTalk plugin with all supported native companions."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from build import prepare_source_archive
from toolchain import ensure_go
from verify import verify_artifacts, verify_native_entry

ROOT = Path(__file__).resolve().parent
TARGETS = (
    "darwin/arm64",
    "darwin/amd64",
    "linux/amd64",
    "linux/arm64",
    "windows/amd64",
)


def assemble(plugin: Path, output: Path, source_archive: Path | None) -> None:
    with tempfile.TemporaryDirectory(prefix="wegent-dws-package-") as temporary:
        staged = Path(temporary) / "dingtalk"
        shutil.copytree(
            plugin,
            staged,
            symlinks=True,
            ignore=shutil.ignore_patterns(
                "__pycache__", "*.pyc", ".DS_Store", "native"
            ),
        )
        for path in staged.rglob("*"):
            if path.is_symlink() or path.name in {".env", ".git"}:
                raise ValueError(
                    "Plugin source must not contain links or private state"
                )
        manifest = json.loads((staged / ".codex-plugin/plugin.json").read_text())
        if (
            manifest.get("name") != "dingtalk"
            or not (staged / "scripts/account-auth.py").is_file()
        ):
            raise ValueError(
                "Expected the DingTalk plugin with its native adapter entry"
            )
        connector = next(
            item for item in manifest["connectors"] if item["slug"] == "dingtalk"
        )
        if connector.get("accountAuth", {}).get("exportMode") != "exclusive":
            raise ValueError("DingTalk source must declare its account authentication")
        if (staged / "scripts/account-auth.py").read_bytes() != (
            ROOT / "entry.py"
        ).read_bytes():
            raise ValueError("DingTalk launcher differs from the reviewed build input")
        ensure_go(Path(temporary))
        source_archive = prepare_source_archive(Path(temporary), source_archive)
        for target in TARGETS:
            operating_system, architecture = target.split("/")
            destination = (
                staged
                / "scripts/native"
                / target.replace("/", "-")
                / "dws-account-auth"
            )
            command = [
                sys.executable,
                str(ROOT / "build.py"),
                "--output",
                str(destination),
            ]
            host_os = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(
                platform.system()
            )
            host_arch = {
                "x86_64": "amd64",
                "AMD64": "amd64",
                "aarch64": "arm64",
                "arm64": "arm64",
            }.get(platform.machine())
            if target == f"{host_os}/{host_arch}":
                command.append("--test")
            command.extend(["--source-archive", str(source_archive)])
            environment = {
                **os.environ,
                "GOOS": operating_system,
                "GOARCH": architecture,
                "CGO_ENABLED": "0",
            }
            subprocess.run(command, env=environment, check=True)
        verify_artifacts(staged, TARGETS)
        verify_native_entry(staged)
        output.parent.mkdir(parents=True, exist_ok=True)
        candidate = Path(temporary) / "dingtalk.zip"
        files = sorted(path for path in staged.rglob("*") if path.is_file())
        if sum(path.stat().st_size for path in files) > 200 * 1024 * 1024:
            raise ValueError("Expanded plugin exceeds Wegent's package limit")
        with zipfile.ZipFile(
            candidate, "w", zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for path in files:
                entry = zipfile.ZipInfo(
                    path.relative_to(staged).as_posix(), (1980, 1, 1, 0, 0, 0)
                )
                entry.create_system = 3
                entry.external_attr = (
                    stat.S_IFREG | (0o755 if path.stat().st_mode & 0o111 else 0o644)
                ) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, path.read_bytes(), compresslevel=9)
        if candidate.stat().st_size > 50 * 1024 * 1024:
            raise ValueError("Plugin archive exceeds Wegent's upload limit")
        shutil.copyfile(candidate, output)
        checksum = hashlib.sha256(candidate.read_bytes()).hexdigest()
        output.with_name(output.name + ".sha256").write_text(
            checksum + "  " + output.name + "\n"
        )
        print(
            json.dumps(
                {
                    "plugin": str(output.resolve()),
                    "targets": TARGETS,
                    "bytes": output.stat().st_size,
                    "sha256": checksum,
                }
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-archive", type=Path)
    arguments = parser.parse_args()
    assemble(arguments.plugin, arguments.output, arguments.source_archive)


if __name__ == "__main__":
    main()

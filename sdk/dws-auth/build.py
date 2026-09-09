#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Build the DWS native companion from a pinned archive plus additive sources."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "1.0.58"
SOURCE_SHA256 = "f6b2dcf16b34492d7be25ce63fc81c7155d6a857af21c0604ae16bf4fa96f1e2"
ROOT = Path(__file__).resolve().parent


def prepare_source_archive(directory: Path, provided: Path | None) -> Path:
    archive = provided
    if archive is None:
        archive = directory / "source.tar.gz"
        url = f"https://codeload.github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tar.gz/refs/tags/v{VERSION}"
        with urllib.request.urlopen(url, timeout=30) as response:
            archive.write_bytes(response.read(100 * 1024 * 1024 + 1))
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("DWS source archive checksum mismatch")
    return archive.resolve()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    if (
        os.environ.get("GOOS", "windows" if os.name == "nt" else "") == "windows"
        and output.suffix != ".exe"
    ):
        output = output.with_name(output.name + ".exe")
    with tempfile.TemporaryDirectory(prefix="wegent-dws-build-") as temporary:
        directory = Path(temporary)
        archive = prepare_source_archive(directory, args.source_archive)
        with tarfile.open(archive) as source:
            source.extractall(directory, filter="data")
        source_root = directory / f"dingtalk-workspace-cli-{VERSION}"
        target = source_root / "cmd/wegent-account-auth"
        shutil.copytree(ROOT / "overlay", target)
        for path in (ROOT / "auth-overlay").glob("*.go"):
            shutil.copyfile(path, source_root / "internal/auth" / path.name)
        sdk = source_root / "internal/wegentpluginauth"
        sdk.mkdir()
        for path in (ROOT.parent / "plugin-auth-go").glob("*.go"):
            shutil.copyfile(path, sdk / path.name)
        if args.test:
            subprocess.run(
                ["go", "test", "./internal/auth", "-run", "^TestWegentTransfer"],
                cwd=source_root,
                check=True,
            )
            subprocess.run(
                [
                    "go",
                    "test",
                    "./internal/wegentpluginauth",
                    "./cmd/wegent-account-auth",
                ],
                cwd=source_root,
                check=True,
            )
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "go",
                "build",
                "-trimpath",
                "-ldflags=-s -w",
                "-o",
                str(output),
                "./cmd/wegent-account-auth",
            ],
            cwd=source_root,
            check=True,
        )
        for name in ("LICENSE", "NOTICE"):
            shutil.copyfile(
                source_root / name, output.with_name(output.name + "." + name)
            )
        compiled_sources = {}
        for label, folder in (
            ("overlay", ROOT / "overlay"),
            ("auth-overlay", ROOT / "auth-overlay"),
            ("sdk", ROOT.parent / "plugin-auth-go"),
        ):
            for path in sorted(folder.glob("*.go")):
                if not path.name.endswith("_test.go"):
                    compiled_sources[f"{label}/{path.name}"] = hashlib.sha256(
                        path.read_bytes()
                    ).hexdigest()
        target = subprocess.check_output(
            ["go", "env", "GOOS", "GOARCH"], text=True
        ).split()
        metadata = {
            "upstreamVersion": VERSION,
            "upstreamSourceSha256": SOURCE_SHA256,
            "nativeProtocolVersion": 1,
            "buildFlags": ["-trimpath", "-ldflags=-s -w"],
            "target": "/".join(target),
            "sources": compiled_sources,
            "binarySha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        }
        output.with_name(output.name + ".json").write_text(
            json.dumps(metadata, indent=2) + "\n"
        )
        print(json.dumps({"binary": str(output), "target": metadata["target"]}))


if __name__ == "__main__":
    main()

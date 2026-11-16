"""Build real, pinned DingTalk releases for the existing authentication checkpoints."""

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

RELEASES = {
    "0.3.5": (
        "3f9e664f0af7fb294981d2d2ca23550595fe7ce3",
        "de858bcaf086b60e90faa42daf50883b31c9aea7f856ab9c5b8106c2d1b92a41",
    ),
    "0.3.6": (
        "04125234eddc4589534c38b8fba5e1cbb513aff4",
        "e2eb9c63bb4bbf91e4b7538ed5f58790a19accff2ecafed768211cc11bf3ba86",
    ),
}


def prepare(directory: Path, versions: list[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    target = {
        ("Darwin", "arm64"): "darwin/arm64",
        ("Darwin", "x86_64"): "darwin/amd64",
        ("Linux", "x86_64"): "linux/amd64",
    }[(platform.system(), platform.machine())]
    evidence = {}
    for version in versions:
        revision, checksum = RELEASES[version]
        archive = directory / f"{revision}.tar.gz"
        if not archive.exists():
            url = f"https://codeload.github.com/wecode-ai/wework-plugins/tar.gz/{revision}"
            with urllib.request.urlopen(url, timeout=30) as response:
                archive.write_bytes(response.read(30 * 1024 * 1024 + 1))
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise ValueError("DingTalk source checksum mismatch")
        with tarfile.open(archive) as source:
            source.extractall(directory, filter="data")
        plugin = directory / f"wework-plugins-{revision}/plugins/dingtalk"
        builder = plugin / ".wework-build/dws-auth"
        if (
            json.loads((plugin / ".codex-plugin/plugin.json").read_text())["version"]
            != version
        ):
            raise ValueError("DingTalk release version mismatch")
        # Use each release's unmodified assembler and native sources. Restrict
        # architecture only; both releases reuse the existing Go module/build cache.
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import package,sys; package.TARGETS=(sys.argv[3],); "
                "package.assemble(package.Path(sys.argv[1]), "
                "package.Path(sys.argv[2]), None)",
                str(plugin),
                str(directory / f"dingtalk-{version}.zip"),
                target,
            ],
            cwd=builder,
            env={**os.environ, "CGO_ENABLED": "0"},
            check=True,
        )
        evidence[version] = {
            "commit": revision,
            "sourceSha256": checksum,
            "target": target,
            "packageSha256": hashlib.sha256(
                (directory / f"dingtalk-{version}.zip").read_bytes()
            ).hexdigest(),
        }
    (directory / "sources.json").write_text(json.dumps(evidence))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--versions", nargs="+", choices=RELEASES, required=True)
    arguments = parser.parse_args()
    prepare(arguments.directory.resolve(), arguments.versions)

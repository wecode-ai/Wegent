#!/usr/bin/env python3
"""Prepare the exact, patched iSH source declared by the native source lock."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1]


def git(directory: Path, *arguments: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(directory), *arguments],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def verify_inputs(lock: dict) -> bytes:
    patch = (MODULE / lock["patch"]["path"]).read_bytes()
    if digest(patch) != lock["patch"]["sha256"]:
        raise ValueError("The iSH patch does not match the source lock")
    for license in lock["licenses"]:
        if digest((MODULE / license["path"]).read_bytes()) != license["sha256"]:
            raise ValueError(f"License checksum mismatch: {license['path']}")
    return patch


def prepare(output: Path, source_cache: Path | None, lock: dict, patch: bytes) -> None:
    upstream = lock["upstream"]
    if not (output / ".git").exists():
        if output.exists() and any(output.iterdir()):
            raise ValueError(
                "Source output must be empty or an existing verified checkout"
            )
        output.mkdir(parents=True, exist_ok=True)
        git(output, "init", "--quiet")
        git(output, "remote", "add", "origin", upstream["repository"])
        source = str(source_cache) if source_cache else "origin"
        git(
            output,
            "fetch",
            "--quiet",
            "--no-tags",
            "--depth=1",
            source,
            upstream["revision"],
        )
        git(output, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        git(output, "apply", "--index", str(MODULE / lock["patch"]["path"]))
    if git(output, "rev-parse", "HEAD").decode().strip() != upstream["revision"]:
        raise ValueError("Existing checkout has a different upstream revision")
    git(output, "diff", "--exit-code", "--quiet")
    if git(output, "ls-files", "--others", "--exclude-standard").strip():
        raise ValueError("Existing checkout contains untracked source files")
    if git(output, "diff", "--cached", "--binary", "--full-index") != patch:
        raise ValueError("Existing checkout has a different staged compatibility patch")
    for license in lock["licenses"]:
        if "upstreamPath" in license:
            content = git(output, "show", f"HEAD:{license['upstreamPath']}")
            if digest(content) != license["sha256"]:
                raise ValueError(f"Upstream license changed: {license['upstreamPath']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--source-cache", type=Path, help="Optional local Git object source"
    )
    args = parser.parse_args()
    lock = json.loads((MODULE / "native/ish-source-lock.json").read_text())
    patch = verify_inputs(lock)
    output = args.output.expanduser().resolve()
    cache = args.source_cache.expanduser().resolve() if args.source_cache else None
    prepare(output, cache, lock, patch)
    print(json.dumps({"source": str(output), "revision": lock["upstream"]["revision"]}))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Execute the checksum-verified companion bundled in the installed plugin."""

import hashlib
import json
import os
import platform
import sys
from pathlib import Path

from wegent_plugin_auth import AuthError, local_configuration


def companion() -> Path:
    operating_system = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(
        platform.system()
    )
    architecture = {
        "x86_64": "amd64",
        "AMD64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(platform.machine())
    if not operating_system or not architecture:
        raise ValueError
    root = Path(__file__).resolve().parent
    directory = root / "native" / f"{operating_system}-{architecture}"
    executable = directory / (
        "dws-account-auth.exe" if operating_system == "windows" else "dws-account-auth"
    )
    metadata = executable.with_name(executable.name + ".json")
    if (
        executable.is_symlink()
        or metadata.is_symlink()
        or not executable.resolve().is_relative_to(root)
    ):
        raise ValueError
    if metadata.stat().st_size > 65536 or not executable.is_file():
        raise ValueError
    value = json.loads(metadata.read_text(encoding="utf-8"))
    if (
        type(value["nativeProtocolVersion"]) is not int
        or value["nativeProtocolVersion"] != 1
        or value["target"] != f"{operating_system}/{architecture}"
    ):
        raise ValueError
    with executable.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != value["binarySha256"]:
        raise ValueError
    return executable


if __name__ == "__main__":
    try:
        executable = companion()
        settings = local_configuration()
        # Only these declared provider settings may select the source auth store.
        for name in ("DWS_CONFIG_DIR", "DWS_KEYCHAIN_DIR", "DWS_DISABLE_KEYCHAIN"):
            if name in settings:
                os.environ[name] = settings[name]
        # exec preserves the host's private stdin nonce and socket environment.
        os.execv(str(executable), [str(executable), *sys.argv[1:]])
    except (OSError, ValueError, KeyError, TypeError, AuthError):
        print(
            json.dumps({"status": "error", "code": "plugin_auth_package_sync_required"})
        )
        raise SystemExit(1)

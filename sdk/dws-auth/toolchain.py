"""Use the pinned Go compiler, bootstrapping the Linux CI image when needed."""

import hashlib
import os
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

GO_VERSION = "go1.25.9"
ARCHIVES = {
    "darwin/amd64": {
        "filename": "go1.25.9.darwin-amd64.tar.gz",
        "sha256": "92cb78fba4796e218c1accb0ea0a214ef2094c382049a244ad6505505d015fbe",
    },
    "darwin/arm64": {
        "filename": "go1.25.9.darwin-arm64.tar.gz",
        "sha256": "9528be7329b9770631a6bd09ca2f3a73ed7332bec01d87435e75e92d8f130363",
    },
    "linux/amd64": {
        "filename": "go1.25.9.linux-amd64.tar.gz",
        "sha256": "00859d7bd6defe8bf84d9db9e57b9a4467b2887c18cd93ae7460e713db774bc1",
    },
    "linux/arm64": {
        "filename": "go1.25.9.linux-arm64.tar.gz",
        "sha256": "ec342e7389b7f489564ed5463c63b16cf8040023dabc7861256677165a8c0e2b",
    },
    "windows/amd64": {
        "filename": "go1.25.9.windows-amd64.zip",
        "sha256": "a7a710e225467b34e9e09fb432b829c86c9b2da5821ee5418f7eb2e8ae1a22cc",
    },
}


def ensure_go(directory: Path) -> None:
    executable = shutil.which("go")
    if executable:
        probe_environment = {k: v for k, v in os.environ.items() if k != "GOROOT"}
        probe_environment.update({"GOENV": "off", "GOTOOLCHAIN": "local"})
        result = subprocess.run(
            [executable, "env", "GOVERSION", "GOROOT"],
            env=probe_environment,
            capture_output=True,
            text=True,
            check=True,
        )
        installed = result.stdout.strip().splitlines()
        if len(installed) == 2 and installed[0] == GO_VERSION:
            os.environ["GOROOT"] = installed[1]
            os.environ["GOTOOLCHAIN"] = "local"
            return
    system = {"Darwin": "darwin", "Linux": "linux", "Windows": "windows"}.get(
        platform.system()
    )
    arch = {
        "x86_64": "amd64",
        "AMD64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(platform.machine())
    release = ARCHIVES.get(f"{system}/{arch}")
    if release is None:
        raise ValueError(f"Unsupported Go build host: {system}/{arch}")
    archive = directory / release["filename"]
    with urllib.request.urlopen(
        f"https://go.dev/dl/{release['filename']}", timeout=60
    ) as response:
        data = response.read(80 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != release["sha256"]:
        raise ValueError("Go toolchain checksum mismatch")
    archive.write_bytes(data)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as source:
            source.extractall(directory)
    else:
        with tarfile.open(archive) as source:
            source.extractall(directory, filter="data")
    os.environ["PATH"] = (
        str(directory / "go/bin") + os.pathsep + os.environ.get("PATH", "")
    )
    # The selected compiler and standard library must come from the same archive.
    os.environ["GOROOT"] = str(directory / "go")
    os.environ["GOTOOLCHAIN"] = "local"

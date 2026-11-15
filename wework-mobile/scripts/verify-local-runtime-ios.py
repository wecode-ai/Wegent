"""Verify a signed iPhone build before delivering phone-local execution.

This packaging gate checks Expo registration in generated source and the actual
unstripped Release executable, the device bridge, and all runtime resources.
It does not replace starting the runtime through the normal app on a real phone.
Run with uv run --no-project.
"""

import argparse
import hashlib
import json
import plistlib
import re
import subprocess
import tarfile
from pathlib import Path
from typing import Any

MOBILE = Path(__file__).resolve().parents[1]
MODULE = MOBILE / "modules/wework-local-runtime"
PROVIDER = (
    MOBILE / "ios/Pods/Target Support Files/Pods-Wegent/ExpoModulesProvider.swift"
)


def require(condition: Any, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read(*args: str | Path) -> str:
    return subprocess.run(
        [str(value) for value in args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def digest(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def disassemble(binary: Path, symbol: str) -> str:
    return read(
        "xcrun",
        "llvm-objdump",
        "--no-show-raw-insn",
        "--disassemble-symbols=" + symbol,
        binary,
    )


def verify_registration(binary: Path, provider: Path) -> str:
    source = provider.read_text()
    require(
        re.search(r"^\s*(?:internal )?import WeworkLocalRuntime\s*$", source, re.M),
        "Generated Expo provider does not import WeworkLocalRuntime; rerun pod install",
    )
    require(
        source.count("WeworkLocalRuntimeModule.self") == 1,
        "Generated Expo provider must register WeworkLocalRuntimeModule exactly once",
    )
    symbols = read("xcrun", "nm", "-j", binary).splitlines()
    providers = [
        name
        for name in symbols
        if "ExpoModulesProviderC16getModuleClasses" in name and name.endswith("F")
    ]
    modules = [
        name
        for name in symbols
        if "WeworkLocalRuntime" in name and name.endswith("ModuleCMa")
    ]
    require(
        len(providers) == 1 and len(modules) == 1,
        "Expected Expo provider/native module metadata missing from device executable",
    )
    require(
        modules[0] in disassemble(binary, providers[0]),
        "Compiled Expo provider does not register the runtime; rebuild the app",
    )
    return digest(provider)


def verify_device_bridge(binary: Path) -> None:
    output = disassemble(binary, "_ww_runtime_available")
    require(
        "file format mach-o arm64" in output,
        "Local runtime delivery requires an ARM64 iPhone executable",
    )
    instructions = re.findall(r"^[0-9a-f]+:\s+([^;\n]+)", output, re.M)
    instructions = [" ".join(value.split()) for value in instructions]
    require(
        instructions in (["mov w0, #0x1", "ret"], ["mov w0, #1", "ret"]),
        "Device executable does not contain the supported runtime bridge",
    )


def verify_rootfs(resources: Path, manifest: dict[str, Any]) -> None:
    archive_path = resources / "runtime-rootfs.tar.gz"
    require(
        digest(archive_path) == manifest["rootfsSha256"],
        "Packaged rootfs checksum differs from the manifest",
    )
    with tarfile.open(archive_path, mode="r:gz") as archive:
        executors = [
            entry
            for entry in archive
            if entry.name.removeprefix("./") == "opt/wegent-executor"
        ]
        require(
            len(executors) == 1 and executors[0].isfile(),
            "Rootfs must contain exactly one executor binary",
        )
        require(executors[0].mode & 0o111, "Packaged executor is not executable")
        with archive.extractfile(executors[0]) as executor:
            actual = hashlib.file_digest(executor, "sha256").hexdigest()
        require(
            actual == manifest["executorSha256"],
            "Packaged executor checksum differs from the manifest",
        )


def verify_resources(app: Path) -> dict[str, Any]:
    resources = app / "WeworkLocalRuntimeResources.bundle"
    manifest = json.loads((resources / "manifest.json").read_text())
    lock = json.loads((MODULE / "native/ish-source-lock.json").read_text())
    require(
        manifest["schemaVersion"] == 1 and manifest["jitEmission"] is False,
        "Unsupported runtime manifest or JIT emission enabled",
    )
    require(
        manifest["ishRevision"] == lock["upstream"]["revision"],
        "Packaged iSH revision differs from the source lock",
    )
    require(
        digest(resources / "ish-source-lock.json")
        == digest(MODULE / "native/ish-source-lock.json"),
        "Packaged source lock differs from the reviewed source",
    )
    require(
        manifest["ishPatchSha256"]
        == lock["patch"]["sha256"]
        == digest(resources / "ish-embedding.patch"),
        "Packaged iSH compatibility patch checksum mismatch",
    )
    for license in lock["licenses"]:
        require(
            digest(resources / "licenses" / Path(license["path"]).name)
            == license["sha256"],
            "Packaged license checksum mismatch: " + license["path"],
        )
    verify_rootfs(resources, manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--provider", type=Path, default=PROVIDER)
    args = parser.parse_args()
    app = args.app.resolve()
    with (app / "Info.plist").open("rb") as file:
        info = plistlib.load(file)
    require(
        info["CFBundleSupportedPlatforms"] == ["iPhoneOS"],
        "This gate requires a device build, not a simulator app",
    )
    read("codesign", "--verify", "--deep", "--strict", app)
    binary = app / info["CFBundleExecutable"]
    provider_hash = verify_registration(binary, args.provider)
    verify_device_bridge(binary)
    manifest = verify_resources(app)
    print(
        json.dumps(
            {
                "path": str(app),
                "bundle": info["CFBundleIdentifier"],
                "version": info["CFBundleShortVersionString"],
                "build": info["CFBundleVersion"],
                "expoProviderSha256": provider_hash,
                "compiledExpoRegistration": True,
                "deviceBridgeSupported": True,
                "executableSha256": digest(binary),
                "ishPatchSha256": manifest["ishPatchSha256"],
                "rootfsSha256": manifest["rootfsSha256"],
                "executorSha256": manifest["executorSha256"],
                "jsSha256": digest(app / "main.jsbundle"),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

"""Verify delivered image upgrades with the real Darwin iSH and executor, offline."""

import argparse
import platform
import subprocess
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "modules/wework-local-runtime"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--previous-resources", type=Path, action="append", required=True
    )
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--native-source", type=Path, required=True)
    parser.add_argument("--native-build", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("The upgrade integration requires an Apple ARM64 host")
    args.output.mkdir(parents=True, exist_ok=False)
    objects = []
    for source in [
        MODULE / "ios/WWRuntime.c",
        MODULE / "ios/RuntimeStorage.c",
        MODULE / "ios/RuntimeMemory.c",
        MODULE / "vendor/importer/fakefs.c",
        MODULE / "vendor/importer/fchdir.c",
    ]:
        target = args.output / (source.stem + ".o")
        subprocess.run(
            [
                "xcrun",
                "clang",
                "-c",
                "-DWWR_EMBEDDED_ISH=1",
                "-DGUEST_ARM64=1",
                "-DENGINE_ASBESTOS=1",
                "-DISH_JIT=1",
                "-DISH_JIT_NO_EMIT=1",
                "-fblocks",
                "-I" + str(args.native_source),
                "-I" + str(args.native_build),
                "-I" + str(MODULE / "vendor/include/archive"),
                str(source),
                "-o",
                str(target),
            ],
            check=True,
        )
        objects.append(str(target))
    binary = args.output / "runtime-image-upgrade"
    subprocess.run(
        [
            "xcrun",
            "swiftc",
            "-warnings-as-errors",
            "-import-objc-header",
            str(MODULE / "ios/WWRuntime.h"),
            str(MODULE / "ios/RuntimeImageInstaller.swift"),
            str(MODULE / "ios/RuntimePipeReader.swift"),
            str(MODULE / "tests/RuntimeImageUpgradeIntegration.swift"),
            *objects,
            *(
                str(args.native_build / name)
                for name in ["libish.a", "libish_emu.a", "libfakefs.a"]
            ),
            "-lsqlite3",
            "-larchive",
            "-lresolv",
            "-lpthread",
            "-o",
            str(binary),
        ],
        check=True,
    )
    for index, previous in enumerate(args.previous_resources):
        subprocess.run(
            [
                str(binary),
                str(previous.resolve()),
                str(args.resources.resolve()),
                str((args.output / f"profile-{index}").resolve()),
            ],
            check=True,
            timeout=180,
        )


if __name__ == "__main__":
    main()

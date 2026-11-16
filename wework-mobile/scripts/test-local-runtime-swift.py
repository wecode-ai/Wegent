"""Run focused native runtime tests on macOS without installing an iPhone app."""

import platform
import subprocess
import tempfile
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "modules/wework-local-runtime"
SUITES = [
    "RuntimeEventJournal",
    "RuntimeWorkLeaseRevisions",
    "RuntimePipeReader",
    "RuntimeProfiles",
]


def main() -> None:
    if platform.system() != "Darwin":
        raise RuntimeError(
            "Native runtime pipe tests require Darwin Foundation on macOS"
        )
    with tempfile.TemporaryDirectory(prefix="wework-native-tests-") as temporary:
        for suite in SUITES:
            executable = Path(temporary) / suite
            subprocess.run(
                [
                    "xcrun",
                    "swiftc",
                    "-warnings-as-errors",
                    str(MODULE / "ios" / f"{suite}.swift"),
                    str(MODULE / "tests" / f"{suite}Tests.swift"),
                    "-o",
                    str(executable),
                ],
                check=True,
            )
            subprocess.run([str(executable)], check=True, timeout=30)


if __name__ == "__main__":
    main()

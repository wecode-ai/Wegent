# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Offline PEP 660 fixture exposing source copies made by non-editable builds."""

from pathlib import Path
from zipfile import ZipFile

DIST_INFO = "artifact_dependency-1.0.0.dist-info"
METADATA = "Metadata-Version: 2.1\nName: artifact-dependency\nVersion: 1.0.0\n"
WHEEL = "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"


def prepare_metadata_for_build_wheel(
    metadata_directory: str, config_settings: object = None
) -> str:
    destination = Path(metadata_directory) / DIST_INFO
    destination.mkdir()
    (destination / "METADATA").write_text(METADATA, encoding="utf-8")
    return DIST_INFO


prepare_metadata_for_build_editable = prepare_metadata_for_build_wheel


def _build(wheel_directory: str, editable: bool) -> str:
    filename = "artifact_dependency-1.0.0-py3-none-any.whl"
    with ZipFile(Path(wheel_directory) / filename, "w") as wheel:
        wheel.writestr(f"{DIST_INFO}/METADATA", METADATA)
        wheel.writestr(f"{DIST_INFO}/WHEEL", WHEEL)
        wheel.writestr(f"{DIST_INFO}/RECORD", "")
        if editable:
            wheel.writestr("artifact_dependency.pth", f"{Path.cwd()}\n")
        else:
            # Match setuptools' wheel-build side effect in the watched checkout.
            source = Path("artifact_dependency.py").read_bytes()
            destination = Path("build/lib/artifact_dependency.py")
            destination.parent.mkdir(parents=True)
            destination.write_bytes(source)
            wheel.writestr("artifact_dependency.py", source)
    return filename


def build_wheel(
    wheel_directory: str,
    config_settings: object = None,
    metadata_directory: str | None = None,
) -> str:
    return _build(wheel_directory, editable=False)


def build_editable(
    wheel_directory: str,
    config_settings: object = None,
    metadata_directory: str | None = None,
) -> str:
    return _build(wheel_directory, editable=True)

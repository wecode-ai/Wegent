# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Legacy Office conversion helpers.

MinerU's HTTP API accepts OOXML Office files (docx/pptx/xlsx), but not the
older OLE2 formats (doc/ppt/xls). Normalize legacy files with LibreOffice
before handing them to MinerU.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

LEGACY_OFFICE_TARGET_EXTENSIONS = {
    "doc": "docx",
    "ppt": "pptx",
    "xls": "xlsx",
}

_SOFFICE_CANDIDATES = (
    "soffice",
    "libreoffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
)


def is_legacy_office_extension(file_extension: str) -> bool:
    """Return whether extension needs LibreOffice normalization."""

    return file_extension.strip().lstrip(".").lower() in LEGACY_OFFICE_TARGET_EXTENSIONS


@lru_cache(maxsize=1)
def resolve_soffice_path() -> str | None:
    """Resolve a runnable LibreOffice/soffice binary."""

    configured = os.getenv("SOFFICE_PATH") or os.getenv("LIBREOFFICE_PATH")
    candidates = (configured,) if configured else ()
    candidates = candidates + _SOFFICE_CANDIDATES

    for candidate in candidates:
        if not candidate:
            continue

        resolved = shutil.which(candidate) or candidate
        try:
            result = subprocess.run(
                [resolved, "--version"],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return resolved

    return None


def convert_legacy_office_to_openxml(
    binary_data: bytes,
    file_extension: str,
    *,
    timeout_seconds: int = 120,
) -> tuple[bytes, str]:
    """Convert doc/ppt/xls bytes to docx/pptx/xlsx bytes."""

    source_ext = file_extension.strip().lstrip(".").lower()
    target_ext = LEGACY_OFFICE_TARGET_EXTENSIONS.get(source_ext)
    if not target_ext:
        raise RuntimeError(f"Legacy Office conversion does not support '{source_ext}'")

    soffice = resolve_soffice_path()
    if not soffice:
        raise RuntimeError(
            "Legacy Office conversion requires LibreOffice/soffice. "
            f"Cannot convert .{source_ext} to .{target_ext}."
        )

    with tempfile.TemporaryDirectory(prefix="wegent-office-convert-") as tmpdir:
        tmp_path = Path(tmpdir)
        input_path = tmp_path / f"document.{source_ext}"
        input_path.write_bytes(binary_data)

        result = subprocess.run(
            [
                soffice,
                "--headless",
                "--convert-to",
                target_ext,
                "--outdir",
                tmpdir,
                str(input_path),
            ],
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()
            stdout = result.stdout.decode("utf-8", errors="replace").strip()
            detail = stderr or stdout or "unknown error"
            raise RuntimeError(
                f"LibreOffice failed to convert .{source_ext} to .{target_ext}: "
                f"{detail[:500]}"
            )

        output_path = tmp_path / f"document.{target_ext}"
        if not output_path.exists():
            converted_files = list(tmp_path.glob(f"*.{target_ext}"))
            if len(converted_files) == 1:
                output_path = converted_files[0]
            else:
                raise RuntimeError(
                    f"LibreOffice did not produce a .{target_ext} output file"
                )

        converted = output_path.read_bytes()
        logger.info(
            "[OfficeLegacy] Converted .%s to .%s using LibreOffice: bytes=%s",
            source_ext,
            target_ext,
            len(converted),
        )
        return converted, target_ext

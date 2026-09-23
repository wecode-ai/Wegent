# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral filename extension classification."""

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Collection


@dataclass(frozen=True)
class FileImportDecision:
    importable: bool
    normalized_extension: str = ""
    reason: str | None = None


def classify_importable_file(
    filename: str,
    *,
    allowed_extensions: Collection[str],
) -> FileImportDecision:
    name = PurePosixPath(str(filename or "")).name.strip()
    if not name or name in {".", ".."}:
        return FileImportDecision(False, reason="invalid_file_name")
    suffix = PurePosixPath(name).suffix.lower().lstrip(".")
    if not suffix:
        return FileImportDecision(False, reason="missing_file_extension")
    if suffix not in allowed_extensions:
        return FileImportDecision(
            False,
            normalized_extension=suffix,
            reason="unsupported_file_type",
        )
    return FileImportDecision(True, normalized_extension=suffix)

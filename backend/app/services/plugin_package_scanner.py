# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared ZIP safety checks for marketplace plugin packages."""

from __future__ import annotations

import stat
import zipfile
from io import BytesIO
from pathlib import PurePosixPath

MAX_EXPANDED_PACKAGE_SIZE_BYTES = 200 * 1024 * 1024
MAX_PACKAGE_ENTRY_COUNT = 10_000
SENSITIVE_FILENAMES = {
    ".env",
    ".netrc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ed25519",
    "id_rsa",
    "session.json",
}
SENSITIVE_SUFFIXES = (".key", ".p12", ".pfx", ".pem")


class PluginPackageScanError(ValueError):
    """Raised when a plugin archive fails marketplace safety checks."""


def scan_plugin_package(package: bytes) -> dict:
    """Reject unsafe archives and report executable capabilities for review."""
    executable_paths: list[str] = []
    expanded_size = 0
    normalized_paths: set[str] = set()
    try:
        with zipfile.ZipFile(BytesIO(package)) as archive:
            members = archive.infolist()
            if len(members) > MAX_PACKAGE_ENTRY_COUNT:
                raise PluginPackageScanError("Plugin package contains too many files")
            for member in members:
                path = PurePosixPath(member.filename)
                if path.is_absolute() or ".." in path.parts:
                    raise PluginPackageScanError(
                        f"Unsafe path in plugin ZIP: {member.filename}"
                    )
                normalized_path = path.as_posix().rstrip("/")
                if normalized_path in normalized_paths:
                    raise PluginPackageScanError(
                        f"Duplicate path in plugin ZIP: {member.filename}"
                    )
                normalized_paths.add(normalized_path)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise PluginPackageScanError(
                        f"Symbolic links are not allowed: {member.filename}"
                    )
                if member.flag_bits & 0x1:
                    raise PluginPackageScanError(
                        f"Encrypted files are not allowed: {member.filename}"
                    )
                expanded_size += member.file_size
                if expanded_size > MAX_EXPANDED_PACKAGE_SIZE_BYTES:
                    raise PluginPackageScanError("Expanded plugin package is too large")
                basename = path.name.lower()
                if basename in SENSITIVE_FILENAMES or basename.endswith(
                    SENSITIVE_SUFFIXES
                ):
                    raise PluginPackageScanError(
                        f"Sensitive file is not allowed: {member.filename}"
                    )
                if mode and stat.S_ISREG(mode) and mode & 0o111:
                    executable_paths.append(member.filename)
    except zipfile.BadZipFile as exc:
        raise PluginPackageScanError("Invalid plugin ZIP") from exc
    return {
        "entryCount": len(members),
        "expandedSizeBytes": expanded_size,
        "executablePaths": executable_paths[:200],
    }

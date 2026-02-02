# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Version utilities - reads version from pyproject.toml or embedded value."""

import importlib.metadata
from pathlib import Path
from typing import Optional

# Cache the version to avoid repeated file reads
_version_cache: Optional[str] = None

# Embedded version for PyInstaller builds (set by build script)
# This will be replaced during the build process
_EMBEDDED_VERSION: Optional[str] = None


def get_version() -> str:
    """Get executor version.

    Priority:
    1. Embedded version (for PyInstaller builds)
    2. Package metadata (for installed packages)
    3. pyproject.toml (for development)

    Returns:
        Version string (e.g., "1.0.0")
    """
    global _version_cache

    if _version_cache is not None:
        return _version_cache

    # Priority 1: Embedded version (for PyInstaller builds)
    if _EMBEDDED_VERSION is not None:
        _version_cache = _EMBEDDED_VERSION
        return _version_cache

    # Priority 2: Package metadata (for installed packages)
    try:
        _version_cache = importlib.metadata.version("wegent-executor")
        return _version_cache
    except importlib.metadata.PackageNotFoundError:
        pass

    # Priority 3: pyproject.toml (for development)
    _version_cache = _read_from_pyproject()
    return _version_cache


def _read_from_pyproject() -> str:
    """Read version directly from pyproject.toml (dev fallback).

    Returns:
        Version string from pyproject.toml, or "unknown" if not found
    """
    try:
        import tomllib
    except ImportError:
        # Python < 3.11 fallback
        try:
            import tomli as tomllib  # type: ignore
        except ImportError:
            return "unknown"

    # Try multiple possible locations for pyproject.toml
    possible_paths = [
        Path(__file__).parent / "pyproject.toml",
        Path(__file__).parent.parent / "pyproject.toml",
    ]

    for pyproject_path in possible_paths:
        if pyproject_path.exists():
            try:
                with open(pyproject_path, "rb") as f:
                    data = tomllib.load(f)
                return data.get("project", {}).get("version", "unknown")
            except Exception:
                continue

    return "unknown"

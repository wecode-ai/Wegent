# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic packaging and controlled publication for WeWork plugins."""

from __future__ import annotations

import hashlib
import io
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.services.claude_plugin_parser import claude_plugin_parser
from app.services.plugin_marketplace_service import (
    SEMVER_PATTERN,
    SLUG_PATTERN,
    PluginMarketplaceService,
    PublishedRelease,
    plugin_marketplace_service,
)
from app.services.plugin_package_scanner import scan_plugin_package

IGNORED_DIRECTORY_NAMES = {".git", ".pytest_cache", "__pycache__", "node_modules"}
IGNORED_FILE_NAMES = {".DS_Store"}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class OfficialPluginPackage:
    """A reproducible package ready for dry-run or publication."""

    package: bytes
    name: str
    version: str
    sha256: str
    size_bytes: int
    scan_report: dict[str, Any]


class OfficialPluginPublisher:
    """Build official source directories and publish them through Marketplace V2."""

    def __init__(
        self, marketplace_service: PluginMarketplaceService | None = None
    ) -> None:
        self.marketplace_service = marketplace_service or plugin_marketplace_service

    def build_package(self, source_directory: Path) -> OfficialPluginPackage:
        root = source_directory.resolve()
        if not root.is_dir():
            raise ValueError(f"Official plugin source is not a directory: {root}")
        output = io.BytesIO()
        with zipfile.ZipFile(
            output,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for path in self._source_files(root):
                relative = path.relative_to(root).as_posix()
                info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
                info.create_system = 3
                executable = bool(path.stat().st_mode & 0o111)
                permissions = 0o755 if executable else 0o644
                info.external_attr = (permissions & 0xFFFF) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes(), compresslevel=9)
        package = output.getvalue()
        scan_report = scan_plugin_package(package)
        parsed = claude_plugin_parser.parse_package(package)
        if not parsed.version:
            raise ValueError("Official plugin manifest must include a version")
        if not SLUG_PATTERN.fullmatch(parsed.name):
            raise ValueError("Official plugin manifest name must be a valid slug")
        if not SEMVER_PATTERN.fullmatch(parsed.version):
            raise ValueError("Official plugin manifest version must be SemVer")
        return OfficialPluginPackage(
            package=package,
            name=parsed.name,
            version=parsed.version,
            sha256=hashlib.sha256(package).hexdigest(),
            size_bytes=len(package),
            scan_report=scan_report,
        )

    def publish_directory(
        self,
        db: Session,
        *,
        source_directory: Path,
        slug: str | None = None,
        listing_type: str = "plugin",
        visibility: str = "workspace",
        featured_rank: int | None = None,
        created_by_user_id: int | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> tuple[OfficialPluginPackage, PublishedRelease]:
        built = self.build_package(source_directory)
        result = self.publish_package(
            db,
            built=built,
            slug=slug,
            listing_type=listing_type,
            visibility=visibility,
            featured_rank=featured_rank,
            created_by_user_id=created_by_user_id,
            provenance=provenance,
        )
        return built, result

    def publish_package(
        self,
        db: Session,
        *,
        built: OfficialPluginPackage,
        slug: str | None = None,
        listing_type: str = "plugin",
        visibility: str = "workspace",
        featured_rank: int | None = None,
        created_by_user_id: int | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> PublishedRelease:
        """Publish an already-built package without rebuilding CI input."""
        result = self.marketplace_service.publish_official_release(
            db,
            slug=slug or built.name,
            package=built.package,
            listing_type=listing_type,
            visibility=visibility,
            featured_rank=featured_rank,
            created_by_user_id=created_by_user_id,
            provenance=provenance,
        )
        return result

    def _source_files(self, root: Path) -> list[Path]:
        files: list[Path] = []
        for directory, directory_names, file_names in os.walk(
            root, topdown=True, followlinks=False
        ):
            current = Path(directory)
            retained_directories: list[str] = []
            for name in sorted(directory_names):
                path = current / name
                if name in IGNORED_DIRECTORY_NAMES:
                    continue
                if path.is_symlink():
                    raise ValueError(f"Symbolic links are not allowed: {path}")
                retained_directories.append(name)
            directory_names[:] = retained_directories
            for name in sorted(file_names):
                if name in IGNORED_FILE_NAMES:
                    continue
                path = current / name
                if path.is_symlink():
                    raise ValueError(f"Symbolic links are not allowed: {path}")
                if path.is_file():
                    files.append(path)
        return sorted(files, key=lambda path: path.relative_to(root).as_posix())


official_plugin_publisher = OfficialPluginPublisher()

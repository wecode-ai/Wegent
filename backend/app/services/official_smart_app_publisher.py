# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Deterministic packaging and trusted publication for official Smart apps."""

import hashlib
import io
import json
import os
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any

from sqlalchemy.orm import Session

from app.services.smart_app_marketplace_service import smart_app_marketplace_service
from app.services.smart_app_package_parser import smart_app_package_parser

IGNORED_DIRECTORIES = {".git", ".pytest_cache", "__pycache__", "node_modules"}
IGNORED_FILES = {".DS_Store"}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
MAX_MARKETPLACE_ASSET_SIZE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class OfficialSmartAppPackage:
    package: bytes
    name: str
    version: str
    sha256: str
    metadata: dict[str, Any]
    icon: bytes | None
    icon_content_type: str | None
    screenshots: list[tuple[bytes, str]]
    has_marketplace_metadata: bool


class OfficialSmartAppPublisher:
    def build_package(self, source: Path) -> OfficialSmartAppPackage:
        root = source.resolve()
        if not root.is_dir():
            raise ValueError(f"Official Smart app source is not a directory: {root}")
        metadata_path = root / "smart-app-marketplace.json"
        if not metadata_path.is_file():
            raise ValueError("smart-app-marketplace.json is required")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        self._validate_metadata(metadata)
        icon_path = self._asset_path(root, str(metadata["icon"]))
        icon_content_type = self._image_content_type(icon_path, icon=True)
        screenshot_paths = [
            self._asset_path(root, str(value))
            for value in list(metadata.get("screenshots") or [])
        ]
        if len(screenshot_paths) > 5:
            raise ValueError("Official Smart app supports at most five screenshots")
        screenshots = [
            (path.read_bytes(), self._image_content_type(path, icon=False))
            for path in screenshot_paths
        ]
        output = io.BytesIO()
        with zipfile.ZipFile(
            output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for path in self._source_files(root):
                relative = path.relative_to(root).as_posix()
                info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
                info.create_system = 3
                info.external_attr = (
                    (0o755 if path.stat().st_mode & 0o111 else 0o644) & 0xFFFF
                ) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes(), compresslevel=9)
        package = output.getvalue()
        parsed = smart_app_package_parser.parse(package)
        return OfficialSmartAppPackage(
            package=package,
            name=parsed.name,
            version=parsed.version,
            sha256=hashlib.sha256(package).hexdigest(),
            metadata=metadata,
            icon=icon_path.read_bytes(),
            icon_content_type=icon_content_type,
            screenshots=screenshots,
            has_marketplace_metadata=True,
        )

    def build_uploaded_package(self, package: bytes) -> OfficialSmartAppPackage:
        parsed = smart_app_package_parser.parse(package)
        try:
            with zipfile.ZipFile(BytesIO(package)) as archive:
                metadata_path = self._marketplace_metadata_path(archive)
                if metadata_path is None:
                    metadata = {}
                    icon = None
                    icon_content_type = None
                    screenshots = []
                else:
                    metadata = json.loads(archive.read(metadata_path))
                    self._validate_metadata(metadata)
                    root = PurePosixPath(metadata_path).parent
                    icon_path = self._archive_asset_path(root, str(metadata["icon"]))
                    icon = self._read_archive_asset(archive, icon_path)
                    icon_content_type = self._image_content_type(
                        PurePosixPath(icon_path), icon=True
                    )
                    screenshots = self._archive_screenshots(archive, root, metadata)
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("smart-app-marketplace.json is invalid") from exc
        return OfficialSmartAppPackage(
            package=package,
            name=parsed.name,
            version=parsed.version,
            sha256=hashlib.sha256(package).hexdigest(),
            metadata=metadata,
            icon=icon,
            icon_content_type=icon_content_type,
            screenshots=screenshots,
            has_marketplace_metadata=metadata_path is not None,
        )

    def publish_package(
        self,
        db: Session,
        *,
        built: OfficialSmartAppPackage,
        featured_rank: int = 0,
    ):
        return smart_app_marketplace_service.publish_official_package(
            db,
            package=built.package,
            summary=(
                str(built.metadata["summary"])
                if built.has_marketplace_metadata
                else None
            ),
            description_md=(
                str(built.metadata["descriptionMd"])
                if built.has_marketplace_metadata
                else None
            ),
            tags=(
                list(built.metadata["tags"]) if built.has_marketplace_metadata else None
            ),
            icon=built.icon,
            icon_content_type=built.icon_content_type,
            screenshots=built.screenshots,
            release_notes=str(built.metadata.get("releaseNotes") or ""),
            featured_rank=featured_rank,
            extensions=dict(built.metadata.get("extensions") or {}),
            release_extensions=dict(built.metadata.get("releaseExtensions") or {}),
        )

    def _source_files(self, root: Path) -> list[Path]:
        files = []
        for directory, names, filenames in os.walk(
            root, topdown=True, followlinks=False
        ):
            current = Path(directory)
            kept = []
            for name in sorted(names):
                path = current / name
                if name in IGNORED_DIRECTORIES:
                    continue
                if path.is_symlink():
                    raise ValueError(f"Symbolic links are not allowed: {path}")
                kept.append(name)
            names[:] = kept
            for name in sorted(filenames):
                if name in IGNORED_FILES:
                    continue
                path = current / name
                if path.is_symlink():
                    raise ValueError(f"Symbolic links are not allowed: {path}")
                if path.is_file():
                    files.append(path)
        return sorted(files, key=lambda path: path.relative_to(root).as_posix())

    @staticmethod
    def _marketplace_metadata_path(archive: zipfile.ZipFile) -> str | None:
        candidates = [
            value
            for value in archive.namelist()
            if PurePosixPath(value).name == "smart-app-marketplace.json"
            and len(PurePosixPath(value).parts) <= 2
        ]
        if len(candidates) > 1:
            raise ValueError(
                "Official Smart app ZIP contains multiple smart-app-marketplace.json files"
            )
        return candidates[0] if candidates else None

    @staticmethod
    def _validate_metadata(metadata: Any) -> None:
        if not isinstance(metadata, dict):
            raise ValueError("smart-app-marketplace.json must contain an object")
        for field in ("summary", "descriptionMd", "tags", "icon"):
            if not metadata.get(field):
                raise ValueError(f"Official Smart app metadata requires {field}")
        for field, limit in (("summary", 500), ("descriptionMd", 8192)):
            value = metadata[field]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"Official Smart app metadata {field} must be a string"
                )
            if len(value) > limit:
                raise ValueError(
                    f"Official Smart app metadata {field} exceeds {limit} characters"
                )
        if not isinstance(metadata["tags"], list) or not all(
            isinstance(value, str) and value.strip() for value in metadata["tags"]
        ):
            raise ValueError("Official Smart app tags must be a string array")
        screenshots = metadata.get("screenshots", [])
        if not isinstance(screenshots, list) or not all(
            isinstance(value, str) and value.strip() for value in screenshots
        ):
            raise ValueError("Official Smart app screenshots must be a string array")
        if len(screenshots) > 5:
            raise ValueError("Official Smart app supports at most five screenshots")

    @staticmethod
    def _archive_asset_path(root: PurePosixPath, relative: str) -> str:
        path = PurePosixPath(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Marketplace asset must stay inside the ZIP: {relative}")
        return (root / path).as_posix()

    def _archive_screenshots(
        self,
        archive: zipfile.ZipFile,
        root: PurePosixPath,
        metadata: dict[str, Any],
    ) -> list[tuple[bytes, str]]:
        screenshots = []
        for relative in metadata.get("screenshots", []):
            path = self._archive_asset_path(root, relative)
            screenshots.append(
                (
                    self._read_archive_asset(archive, path),
                    self._image_content_type(PurePosixPath(path), icon=False),
                )
            )
        return screenshots

    @staticmethod
    def _read_archive_asset(archive: zipfile.ZipFile, path: str) -> bytes:
        info = archive.getinfo(path)
        if info.is_dir() or info.file_size > MAX_MARKETPLACE_ASSET_SIZE_BYTES:
            raise ValueError("Official Smart app marketplace asset is too large")
        return archive.read(info)

    @staticmethod
    def _asset_path(root: Path, relative: str) -> Path:
        path = (root / relative).resolve()
        if root not in path.parents or not path.is_file():
            raise ValueError(f"Marketplace asset must be inside the source: {relative}")
        return path

    @staticmethod
    def _image_content_type(path: Path | PurePosixPath, *, icon: bool) -> str:
        content_type = {
            ".png": "image/png",
            ".webp": "image/webp",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }.get(path.suffix.lower())
        if not content_type or (icon and content_type == "image/jpeg"):
            raise ValueError("Icon must be PNG/WebP; screenshots must be PNG/WebP/JPEG")
        return content_type


official_smart_app_publisher = OfficialSmartAppPublisher()

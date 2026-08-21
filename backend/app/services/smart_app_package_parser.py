# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Parse and validate Wework Smart app ZIP packages on the cloud control plane."""

import json
import re
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any

from fastapi import HTTPException

from app.services.plugin_package_scanner import scan_plugin_package

MAX_SMART_APP_PACKAGE_SIZE_BYTES = 50 * 1024 * 1024
SMART_APP_PACKAGE_TYPE = "deepseek-harness-plugin-bundle"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


@dataclass(frozen=True)
class ParsedSmartAppPackage:
    manifest: dict[str, Any]
    name: str
    display_name: str
    version: str
    description: str
    scan_report: dict[str, Any]


class SmartAppPackageParser:
    def parse(self, package: bytes) -> ParsedSmartAppPackage:
        if len(package) > MAX_SMART_APP_PACKAGE_SIZE_BYTES:
            raise HTTPException(
                status_code=413, detail="Smart app package is too large"
            )
        scan_report = scan_plugin_package(package)
        try:
            with zipfile.ZipFile(BytesIO(package)) as archive:
                manifest_path = self._manifest_path(archive)
                manifest = json.loads(archive.read(manifest_path))
        except zipfile.BadZipFile as exc:
            raise HTTPException(
                status_code=400, detail="Invalid Smart app ZIP"
            ) from exc
        except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=400, detail="Smart app manifest is invalid"
            ) from exc
        if not isinstance(manifest, dict):
            raise HTTPException(
                status_code=400, detail="Smart app manifest must be an object"
            )
        self._validate_manifest(manifest)
        return ParsedSmartAppPackage(
            manifest=manifest,
            name=str(manifest["name"]).strip(),
            display_name=str(manifest["displayName"]).strip(),
            version=str(manifest["version"]).strip(),
            description=str(manifest["description"]).strip(),
            scan_report=scan_report,
        )

    def _manifest_path(self, archive: zipfile.ZipFile) -> str:
        candidates = []
        for raw in archive.namelist():
            path = PurePosixPath(raw)
            if path.name == "plugin-manifest.json" and len(path.parts) <= 2:
                candidates.append(raw)
        if len(candidates) != 1:
            raise HTTPException(
                status_code=400,
                detail="Smart app ZIP must contain one plugin-manifest.json",
            )
        return candidates[0]

    def _validate_manifest(self, manifest: dict[str, Any]) -> None:
        if manifest.get("type") != SMART_APP_PACKAGE_TYPE:
            raise HTTPException(
                status_code=400, detail="Unsupported Smart app package type"
            )
        name = str(manifest.get("name") or "").strip()
        display_name = str(manifest.get("displayName") or "").strip()
        version = str(manifest.get("version") or "").strip()
        description = str(manifest.get("description") or "").strip()
        if not NAME_PATTERN.fullmatch(name):
            raise HTTPException(status_code=400, detail="Smart app name is invalid")
        if not display_name or not description:
            raise HTTPException(
                status_code=400,
                detail="Smart app displayName and description are required",
            )
        if not SEMVER_PATTERN.fullmatch(version):
            raise HTTPException(
                status_code=400, detail="Smart app version must be SemVer"
            )
        entry = manifest.get("entry")
        requirements = manifest.get("requirements")
        if not isinstance(entry, dict) or not all(
            str(entry.get(key) or "").strip() for key in ("installPackage", "profile")
        ):
            raise HTTPException(status_code=400, detail="Smart app entry is incomplete")
        if not isinstance(requirements, dict) or not all(
            str(requirements.get(key) or "").strip() for key in ("dsh", "node")
        ):
            raise HTTPException(
                status_code=400, detail="Smart app requirements are incomplete"
            )
        install_path = PurePosixPath(str(entry["installPackage"]))
        if install_path.is_absolute() or ".." in install_path.parts:
            raise HTTPException(
                status_code=400,
                detail="Smart app installPackage must stay inside the ZIP",
            )


smart_app_package_parser = SmartAppPackageParser()

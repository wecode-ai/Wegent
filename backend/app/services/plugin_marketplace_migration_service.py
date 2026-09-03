# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One-time, restartable migration from Kind-based marketplace storage."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.plugin_marketplace import Plugin, PluginRelease
from app.models.skill_binary import SkillBinary
from app.services.plugin_marketplace_identity import (
    catalog_namespace_for_visibility,
    marketplace_name_for_visibility,
)
from app.services.plugin_package_parser import plugin_package_parser
from app.services.plugin_package_scanner import (
    PluginPackageScanError,
    scan_plugin_package,
)
from app.services.plugin_package_storage import plugin_package_storage


@dataclass(frozen=True)
class PluginMarketplaceMigrationResult:
    migrated_plugins: int = 0
    migrated_installations: int = 0
    skipped: int = 0


class PluginMarketplaceMigrationService:
    """Move legacy catalog packages once, without dual writing afterward."""

    def migrate(
        self, db: Session, *, retire_legacy: bool = False
    ) -> PluginMarketplaceMigrationResult:
        migrated_plugins = 0
        migrated_installations = 0
        skipped = 0
        rows = (
            db.query(Kind)
            .filter(
                Kind.kind == "PluginMarketplaceItem",
                Kind.namespace == "default",
            )
            .order_by(Kind.id)
            .all()
        )
        for row in rows:
            binary = db.query(SkillBinary).filter(SkillBinary.kind_id == row.id).first()
            if not binary or not binary.binary_data:
                skipped += 1
                continue
            try:
                plugin, release, created = self._migrate_catalog_row(db, row, binary)
            except PluginPackageScanError:
                skipped += 1
                continue
            migrated_plugins += int(created)
            migrated_installations += self._migrate_installations(
                db, legacy_marketplace_id=row.id, plugin=plugin, release=release
            )
            if retire_legacy:
                row.is_active = False
                db.delete(binary)
        db.commit()
        return PluginMarketplaceMigrationResult(
            migrated_plugins=migrated_plugins,
            migrated_installations=migrated_installations,
            skipped=skipped,
        )

    def _migrate_catalog_row(
        self, db: Session, row: Kind, binary: SkillBinary
    ) -> tuple[Plugin, PluginRelease, bool]:
        spec = row.json.get("spec", {}) if isinstance(row.json, dict) else {}
        parsed = plugin_package_parser.parse_package(binary.binary_data)
        scan_report = scan_plugin_package(binary.binary_data)
        slug = self._slug(str(spec.get("name") or parsed.name), row.id)
        visibility = self._visibility(spec.get("visibility"))
        owner_user_id = int(spec.get("ownerUserId") or row.user_id or 0)
        catalog_namespace = catalog_namespace_for_visibility(
            visibility, owner_user_id=owner_user_id
        )
        plugin = (
            db.query(Plugin)
            .filter(
                Plugin.catalog_namespace == catalog_namespace,
                Plugin.slug == slug,
            )
            .first()
        )
        created = plugin is None
        if not plugin:
            plugin = Plugin(
                catalog_namespace=catalog_namespace,
                slug=slug,
                name=parsed.name,
                display_name=str(spec.get("displayName") or parsed.displayName),
                summary=str(spec.get("description") or parsed.description)[:500],
                description_md=str(spec.get("description") or parsed.description)[
                    :8192
                ],
                listing_type="plugin",
                source_type="native",
                source_provider="wework",
                owner_user_id=owner_user_id,
                category=(parsed.interface.category if parsed.interface else "") or "",
                keywords_json=parsed.manifest.get("keywords") or [],
                interface_json=(
                    parsed.interface.model_dump(exclude_none=True)
                    if parsed.interface
                    else {}
                ),
                visibility=visibility,
                status="published",
                # Legacy Kind used featured_rank=0 as "featured"; new schema uses
                # non-zero rank for featured and 0 as the unset sentinel.
                featured_rank=1 if spec.get("featured") else 0,
                published_at=row.created_at or datetime.now(),
            )
            db.add(plugin)
            db.flush()
        version = parsed.version or str(spec.get("version") or "0.0.0")
        release = (
            db.query(PluginRelease)
            .filter(
                PluginRelease.plugin_id == plugin.id,
                PluginRelease.version == version,
            )
            .first()
        )
        if not release:
            digest = hashlib.sha256(binary.binary_data).hexdigest()
            release = PluginRelease(
                plugin_id=plugin.id,
                version=version,
                manifest_json=parsed.manifest,
                interface_json=plugin.interface_json,
                storage_key="pending",
                sha256=digest,
                size_bytes=len(binary.binary_data),
                status="processing",
                scan_status="pending",
                scan_report_json={"migrationSourceKindId": row.id},
                created_by_user_id=row.user_id or 0,
            )
            db.add(release)
            db.flush()
            release.storage_key = f"plugins/{plugin.id}/{release.id}/{digest}.zip"
            plugin_package_storage.put(release.storage_key, binary.binary_data)
            release.status = "ready"
            release.scan_status = "passed"
            release.scan_report_json = {
                "migrationSourceKindId": row.id,
                "components": parsed.components.model_dump(exclude_none=True),
                "checks": [
                    "zip_paths",
                    "manifest",
                    "legacy_checksum",
                    "package_size",
                    "expanded_size",
                    "sensitive_files",
                ],
                **scan_report,
            }
            release.published_at = row.created_at or datetime.now()
        plugin.latest_release_id = release.id
        plugin.status = "published"
        return plugin, release, created

    def _migrate_installations(
        self,
        db: Session,
        *,
        legacy_marketplace_id: int,
        plugin: Plugin,
        release: PluginRelease,
    ) -> int:
        migrated = 0
        rows = db.query(Kind).filter(Kind.kind == "InstalledPlugin").all()
        for row in rows:
            payload = row.json if isinstance(row.json, dict) else {}
            spec = payload.get("spec", {})
            source = spec.get("source") or {}
            if source.get("catalogItemId") != str(legacy_marketplace_id):
                continue
            source.update(
                {
                    "type": "marketplace",
                    "providerKey": "wework-market",
                    "pluginKey": plugin.name,
                    "catalogItemId": str(plugin.id),
                    "marketplace": marketplace_name_for_visibility(plugin.visibility),
                }
            )
            spec.update(
                {
                    "source": source,
                    "origin": "market",
                    "pluginId": plugin.id,
                    "releaseId": release.id,
                    "desiredVersion": release.version,
                    "updatePolicy": "manual",
                    "version": release.version,
                    "packageRef": {
                        "storageKey": release.storage_key,
                        "checksum": f"sha256:{release.sha256}",
                        "sizeBytes": release.size_bytes,
                    },
                }
            )
            payload["spec"] = spec
            row.json = payload
            flag_modified(row, "json")
            legacy_binary = (
                db.query(SkillBinary).filter(SkillBinary.kind_id == row.id).first()
            )
            if legacy_binary:
                db.delete(legacy_binary)
            migrated += 1
        return migrated

    def _slug(self, value: str, legacy_kind_id: int) -> str:
        slug = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-._")
        if not slug:
            slug = f"legacy-{hashlib.sha256(value.encode()).hexdigest()[:12]}"
        suffix = f"-legacy-{legacy_kind_id}"
        return f"{slug[: max(1, 100 - len(suffix))]}{suffix}"

    def _visibility(self, value) -> str:
        return value if value in {"workspace", "public"} else "workspace"


plugin_marketplace_migration_service = PluginMarketplaceMigrationService()

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve account capabilities into device package specifications."""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.plugin_marketplace import PluginRelease
from app.services.plugin_device_identity import plugin_device_rows
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_package_storage import plugin_package_storage

logger = logging.getLogger(__name__)


class DeviceCapabilityResolutionError(RuntimeError):
    """Raised when requested capabilities cannot be resolved for sync."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class CapabilityPayloadResolver:
    """Shared desired-state resolution for complete and targeted snapshots."""

    def _load_enabled_installed_skills(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> list[dict[str, Any]]:
        rows = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "InstalledSkill",
                    Kind.namespace == "default",
                )
            )
            .all()
        )
        enabled_ids = [
            row.id for row in rows if self._should_include_installed_skill(user_id, row)
        ]
        return self._resolve_skill_payloads(
            db,
            user_id=user_id,
            installed_skill_ids=enabled_ids,
        )

    def _load_installed_plugins(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str | None = None,
        only_ids: list[int] | None = None,
    ) -> list[dict[str, Any]]:
        query = db.query(Kind).filter(
            and_(
                Kind.user_id == user_id,
                Kind.kind == "InstalledPlugin",
                Kind.namespace == "default",
            )
        )
        if only_ids is not None:
            query = query.filter(Kind.id.in_(only_ids))
        rows = query.all()
        installed_ids = [
            row.id for row in rows if self._should_sync_installed_plugin(user_id, row)
        ]
        release_overrides = self._device_release_overrides(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_rows=rows,
        )
        return self._resolve_plugin_payloads(
            db,
            user_id=user_id,
            installed_plugin_ids=installed_ids,
            release_overrides=release_overrides,
            strict=True,
        )

    def _load_enabled_installed_mcps(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> list[dict[str, Any]]:
        rows = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "InstalledMCP",
                    Kind.namespace == "default",
                )
            )
            .all()
        )
        enabled_ids = [
            row.id for row in rows if self._should_include_installed_mcp(user_id, row)
        ]
        return self._resolve_mcp_payloads(
            db,
            user_id=user_id,
            installed_mcp_ids=enabled_ids,
        )

    def _resolve_skill_payloads(
        self,
        db: Session,
        *,
        user_id: int,
        skill_ids: Optional[list[int]] = None,
        installed_skill_ids: Optional[list[int]] = None,
        strict: bool = False,
    ) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        seen_skill_ids: set[int] = set()

        for skill_id in skill_ids or []:
            skill = self._get_skill_by_id(db, user_id=user_id, skill_id=skill_id)
            if not skill:
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"Skill not found or access denied: {skill_id}", 404
                    )
                continue
            if skill.id not in seen_skill_ids:
                payloads.append(self._skill_payload(skill, installed_skill_id=None))
                seen_skill_ids.add(skill.id)

        for installed_id in installed_skill_ids or []:
            installed = self._get_user_kind(
                db,
                user_id=user_id,
                kind="InstalledSkill",
                kind_id=installed_id,
            )
            if not installed:
                logger.warning(
                    "InstalledSkill id not found while resolving sync payload: user_id=%s installed_id=%s",
                    user_id,
                    installed_id,
                )
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"InstalledSkill not found or access denied: {installed_id}",
                        404,
                    )
                continue
            skill = self._resolve_installed_skill_ref(db, installed)
            if not skill:
                logger.warning(
                    "InstalledSkill has no resolvable Skill ref: user_id=%s installed_id=%s name=%s skill_ref=%s",
                    user_id,
                    installed.id,
                    installed.name,
                    installed.json.get("spec", {}).get("skillRef"),
                )
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"InstalledSkill has no resolvable Skill ref: {installed_id}",
                        404,
                    )
                continue
            if skill.id not in seen_skill_ids:
                payloads.append(
                    self._skill_payload(skill, installed_skill_id=installed.id)
                )
                seen_skill_ids.add(skill.id)

        return payloads

    def _resolve_plugin_payloads(
        self,
        db: Session,
        *,
        user_id: int,
        installed_plugin_ids: Optional[list[int]] = None,
        strict: bool = False,
        release_overrides: Optional[dict[int, int]] = None,
    ) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        seen_ids: set[int] = set()
        for installed_id in installed_plugin_ids or []:
            installed = self._get_user_kind(
                db,
                user_id=user_id,
                kind="InstalledPlugin",
                kind_id=installed_id,
            )
            if not installed:
                logger.warning(
                    "InstalledPlugin id not found while resolving sync payload: user_id=%s installed_id=%s",
                    user_id,
                    installed_id,
                )
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"InstalledPlugin not found or access denied: {installed_id}",
                        404,
                    )
                continue
            if installed.id in seen_ids:
                continue
            payloads.append(
                self._plugin_payload(
                    db,
                    installed,
                    release_id_override=(release_overrides or {}).get(installed.id),
                )
            )
            seen_ids.add(installed.id)
        return payloads

    def _resolve_mcp_payloads(
        self,
        db: Session,
        *,
        user_id: int,
        installed_mcp_ids: Optional[list[int]] = None,
        strict: bool = False,
    ) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        for installed_id in installed_mcp_ids or []:
            installed = self._get_user_kind(
                db,
                user_id=user_id,
                kind="InstalledMCP",
                kind_id=installed_id,
            )
            if not installed:
                logger.warning(
                    "InstalledMCP id not found while resolving sync payload: user_id=%s installed_id=%s",
                    user_id,
                    installed_id,
                )
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"InstalledMCP not found or access denied: {installed_id}",
                        404,
                    )
                continue
            spec = installed.json.get("spec", {})
            payloads.append(
                {
                    "installed_mcp_id": installed.id,
                    "name": installed.name,
                    "display_name": spec.get("displayName") or installed.name,
                    "description": spec.get("description", ""),
                    "source": spec.get("source") or {},
                    "server": spec.get("server") or {},
                }
            )
        return payloads

    def _get_skill_by_id(
        self,
        db: Session,
        *,
        user_id: int,
        skill_id: int,
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                and_(
                    Kind.id == skill_id,
                    Kind.kind == "Skill",
                    Kind.is_active == True,
                    or_(Kind.user_id == user_id, Kind.user_id == 0),
                )
            )
            .first()
        )

    def _get_user_kind(
        self,
        db: Session,
        *,
        user_id: int,
        kind: str,
        kind_id: int,
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.id == kind_id,
                Kind.user_id == user_id,
                Kind.kind == kind,
                Kind.is_active == True,
            )
            .first()
        )

    def _resolve_installed_skill_ref(
        self, db: Session, installed: Kind
    ) -> Optional[Kind]:
        ref = installed.json.get("spec", {}).get("skillRef") or {}
        if not ref:
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.kind == "Skill",
                Kind.name == ref.get("name"),
                Kind.namespace == ref.get("namespace", "default"),
                Kind.user_id == ref.get("user_id", installed.user_id),
                Kind.is_active == True,
            )
            .first()
        )

    def _skill_payload(
        self,
        skill: Kind,
        *,
        installed_skill_id: Optional[int],
    ) -> dict[str, Any]:
        name = skill.json.get("metadata", {}).get("name") or skill.name
        namespace = skill.json.get("metadata", {}).get("namespace") or skill.namespace
        file_hash = (skill.json or {}).get("status", {}).get("fileHash")
        return {
            "id": skill.id,
            "skill_id": skill.id,
            "installed_skill_id": installed_skill_id,
            "name": name,
            "namespace": namespace,
            "is_public": skill.user_id == 0,
            "content_hash": f"sha256:{file_hash}" if file_hash else None,
            "download_path": (
                f"/api/v1/kinds/skills/{skill.id}/download?namespace={namespace}"
            ),
        }

    def _plugin_payload(
        self,
        db: Session,
        installed: Kind,
        *,
        release_id_override: int | None = None,
    ) -> dict[str, Any]:
        spec = installed.json.get("spec", {})
        source = spec.get("source") or {}
        marketplace = spec.get("marketplace") or source.get("marketplace")
        package_ref = spec.get("packageRef") or {}
        payload = {
            "installed_plugin_id": installed.id,
            "name": self._plugin_payload_name(installed, spec, source),
            "display_name": spec.get("displayName") or installed.name,
            "description": spec.get("description", ""),
            "enabled": spec.get("enabled", True),
            "marketplace": marketplace,
            "version": spec.get("version"),
            "source": source,
        }
        catalog_item_id = spec.get("pluginId") or source.get("catalogItemId")
        if isinstance(catalog_item_id, bool):
            cloud_plugin_id = None
        elif isinstance(catalog_item_id, int):
            cloud_plugin_id = catalog_item_id
        elif (
            isinstance(catalog_item_id, str)
            and catalog_item_id.isascii()
            and catalog_item_id.isdecimal()
        ):
            cloud_plugin_id = int(catalog_item_id)
        else:
            cloud_plugin_id = None
        if cloud_plugin_id is not None and cloud_plugin_id > 0:
            payload["cloud_plugin_id"] = cloud_plugin_id
        component_states = spec.get("componentStates") or {}
        if component_states:
            payload["component_states"] = component_states
        components = spec.get("components") or {}
        if components:
            payload["components"] = components
        if package_ref:
            payload["checksum"] = package_ref.get("checksum")
            release_id = release_id_override or spec.get("releaseId")
            release = (
                db.get(PluginRelease, release_id)
                if isinstance(release_id, int)
                else None
            )
            if (
                release
                and release.status == "ready"
                and release.scan_status == "passed"
            ):
                if release_id_override is not None:
                    payload["version"] = release.version
                    payload["checksum"] = f"sha256:{release.sha256}"
                    release_components = (release.scan_report_json or {}).get(
                        "components"
                    ) or {}
                    if release_components:
                        payload["components"] = release_components
                download_url, expires_at = plugin_package_storage.presign_download(
                    release.storage_key
                )
                payload["download_path"] = download_url
                payload["download_url_expires_at"] = expires_at.isoformat()
                payload["release_id"] = release.id
            else:
                payload["download_path"] = (
                    f"/api/plugins/installed/{installed.id}/download"
                )
        return payload

    def _device_release_overrides(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str | None,
        installed_rows: list[Kind],
    ) -> dict[int, int]:
        if not device_id or not installed_rows:
            return {}
        rows_by_installed_id = plugin_device_rows(db, user_id, device_id)
        overrides: dict[int, int] = {}
        for installed in installed_rows:
            release_id = installed.json.get("spec", {}).get("releaseId")
            if not isinstance(release_id, int):
                continue
            preserved_release_id = (
                plugin_device_installation_service.auto_update_blocked_release_id(
                    rows_by_installed_id.get(installed.id),
                    desired_release_id=release_id,
                )
            )
            if preserved_release_id:
                overrides[installed.id] = preserved_release_id
        return overrides

    def _plugin_payload_name(
        self,
        installed: Kind,
        spec: dict[str, Any],
        source: dict[str, Any],
    ) -> str:
        manifest = spec.get("manifest") or {}
        for candidate in (
            source.get("pluginKey"),
            source.get("plugin"),
            manifest.get("name") if isinstance(manifest, dict) else None,
            installed.json.get("metadata", {}).get("name"),
            installed.name,
        ):
            if isinstance(candidate, str) and candidate:
                return candidate
        return installed.name

    def _is_enabled_install(self, row: Kind) -> bool:
        spec = row.json.get("spec", {})
        return (
            spec.get("enabled", True)
            and spec.get("installState", "installed") == "installed"
        )

    def _should_include_installed_skill(self, user_id: int, row: Kind) -> bool:
        spec = row.json.get("spec", {})
        include = row.is_active and self._is_enabled_install(row)
        logger.info(
            "Desired-state InstalledSkill candidate: user_id=%s installed_id=%s name=%s active=%s enabled=%s state=%s skill_ref=%s include=%s",
            user_id,
            row.id,
            row.name,
            row.is_active,
            spec.get("enabled", True),
            spec.get("installState", "installed"),
            spec.get("skillRef"),
            include,
        )
        return include

    def _should_sync_installed_plugin(self, user_id: int, row: Kind) -> bool:
        spec = row.json.get("spec", {})
        include = row.is_active and spec.get("installState", "installed") == "installed"
        logger.info(
            "Desired-state InstalledPlugin candidate: user_id=%s installed_id=%s name=%s active=%s enabled=%s state=%s source=%s include=%s",
            user_id,
            row.id,
            row.name,
            row.is_active,
            spec.get("enabled", True),
            spec.get("installState", "installed"),
            spec.get("source"),
            include,
        )
        return include

    def _should_include_installed_mcp(self, user_id: int, row: Kind) -> bool:
        spec = row.json.get("spec", {})
        include = row.is_active and self._is_enabled_install(row)
        logger.info(
            "Desired-state InstalledMCP candidate: user_id=%s installed_id=%s name=%s active=%s enabled=%s state=%s source=%s include=%s",
            user_id,
            row.id,
            row.name,
            row.is_active,
            spec.get("enabled", True),
            spec.get("installState", "installed"),
            spec.get("source"),
            include,
        )
        return include

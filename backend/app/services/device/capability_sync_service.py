# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Synchronize user-installed capabilities to local executor devices."""

import logging
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.socketio import get_sio
from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

SYNC_EVENT = "device:sync_capabilities"
SYNC_NAMESPACE = "/local-executor"
SYNC_TIMEOUT_SECONDS = 60


class DeviceCapabilitySyncService:
    """Build and push global desired capabilities for a user's devices."""

    def build_desired_capabilities(
        self,
        db: Session,
        *,
        user_id: int,
        mode: str = "replace",
    ) -> Dict[str, Any]:
        """Build the full enabled capability set from user install records."""
        skills = self._load_enabled_installed_skills(db, user_id=user_id)
        mcps = self._load_enabled_installed_mcps(db, user_id=user_id)
        logger.info(
            "Built desired capabilities: user_id=%s mode=%s skill_names=%s mcp_names=%s",
            user_id,
            mode,
            [item.get("name") for item in skills],
            [item.get("name") for item in mcps],
        )
        return {
            "mode": mode,
            "skills": skills,
            "mcps": mcps,
        }

    async def sync_user_global_capabilities(
        self,
        db: Session,
        *,
        user_id: int,
        mode: str = "replace",
    ) -> DeviceCapabilitySyncResponse:
        """Sync the user's full desired capability set to all online devices."""
        payload = self.build_desired_capabilities(db, user_id=user_id, mode=mode)
        devices = await device_service.get_online_devices(db, user_id)
        logger.info(
            "Syncing global capabilities: user_id=%s mode=%s skills=%s mcps=%s online_devices=%s",
            user_id,
            mode,
            len(payload["skills"]),
            len(payload["mcps"]),
            len(devices),
        )
        results: List[DeviceCapabilitySyncResult] = []
        skipped = 0

        for device in devices:
            device_id = self._extract_device_id(device)
            if not device_id:
                skipped += 1
                continue

            result = await self.sync_device_payload(
                user_id=user_id,
                device_id=device_id,
                payload=payload,
            )
            results.append(result)

        synced = sum(1 for item in results if item.success)
        failed = sum(1 for item in results if not item.success)
        return DeviceCapabilitySyncResponse(
            synced=synced,
            failed=failed,
            skipped=skipped,
            results=results,
        )

    async def sync_device_payload(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: Dict[str, Any],
    ) -> DeviceCapabilitySyncResult:
        """Push an already-built desired payload to one online device."""
        online_info = await device_service.get_device_online_info(user_id, device_id)
        socket_id = online_info.get("socket_id") if online_info else None
        if not socket_id:
            logger.info(
                "Skipping capability sync for offline device: user_id=%s device_id=%s",
                user_id,
                device_id,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                error="device is offline",
            )

        try:
            logger.info(
                "Sending capability sync: user_id=%s device_id=%s socket_id=%s mode=%s skill_names=%s mcp_names=%s",
                user_id,
                device_id,
                socket_id,
                payload.get("mode"),
                [item.get("name") for item in payload.get("skills") or []],
                [item.get("name") for item in payload.get("mcps") or []],
            )
            response = await get_sio().call(
                SYNC_EVENT,
                payload,
                to=socket_id,
                namespace=SYNC_NAMESPACE,
                timeout=SYNC_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "Capability sync failed: user_id=%s device_id=%s error=%s",
                user_id,
                device_id,
                exc,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                error=str(exc),
            )

        if isinstance(response, dict) and response.get("success") is False:
            logger.warning(
                "Capability sync rejected by device: user_id=%s device_id=%s response=%s",
                user_id,
                device_id,
                response,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                error=str(response.get("error") or "device rejected sync"),
            )
        logger.info(
            "Capability sync delivered: user_id=%s device_id=%s skills=%s mcps=%s",
            user_id,
            device_id,
            len(payload.get("skills") or []),
            len(payload.get("mcps") or []),
        )
        return DeviceCapabilitySyncResult(device_id=device_id, success=True)

    async def sync_device_selected_capabilities(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        skill_ids: Optional[Iterable[int]] = None,
        installed_skill_ids: Optional[Iterable[int]] = None,
        installed_mcp_ids: Optional[Iterable[int]] = None,
        mode: str = "replace",
    ) -> DeviceCapabilitySyncResponse:
        """Sync explicitly selected capability IDs to one device."""
        payload = {
            "mode": mode,
            "skills": self._resolve_skill_payloads(
                db,
                user_id=user_id,
                skill_ids=list(skill_ids or []),
                installed_skill_ids=list(installed_skill_ids or []),
            ),
            "mcps": self._resolve_mcp_payloads(
                db,
                user_id=user_id,
                installed_mcp_ids=list(installed_mcp_ids or []),
            ),
        }
        result = await self.sync_device_payload(
            user_id=user_id,
            device_id=device_id,
            payload=payload,
        )
        return DeviceCapabilitySyncResponse(
            synced=1 if result.success else 0,
            failed=0 if result.success else 1,
            skipped=0,
            results=[result],
        )

    def _load_enabled_installed_skills(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> List[Dict[str, Any]]:
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
        enabled_ids = []
        for row in rows:
            spec = row.json.get("spec", {})
            include = (
                row.is_active
                and spec.get("enabled", True)
                and spec.get("installState", "installed") == "installed"
            )
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
            if include:
                enabled_ids.append(row.id)
        return self._resolve_skill_payloads(
            db,
            user_id=user_id,
            installed_skill_ids=enabled_ids,
        )

    def _load_enabled_installed_mcps(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> List[Dict[str, Any]]:
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
        enabled_ids = []
        for row in rows:
            spec = row.json.get("spec", {})
            include = (
                row.is_active
                and spec.get("enabled", True)
                and spec.get("installState", "installed") == "installed"
            )
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
            if include:
                enabled_ids.append(row.id)
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
        skill_ids: Optional[List[int]] = None,
        installed_skill_ids: Optional[List[int]] = None,
    ) -> List[Dict[str, Any]]:
        payloads: List[Dict[str, Any]] = []
        seen_skill_ids: set[int] = set()

        for skill_id in skill_ids or []:
            skill = self._get_skill_by_id(db, user_id=user_id, skill_id=skill_id)
            if skill and skill.id not in seen_skill_ids:
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
                continue
            skill = self._resolve_installed_skill_ref(db, installed)
            if skill and skill.id not in seen_skill_ids:
                payloads.append(
                    self._skill_payload(skill, installed_skill_id=installed.id)
                )
                seen_skill_ids.add(skill.id)
            elif not skill:
                logger.warning(
                    "InstalledSkill has no resolvable Skill ref: user_id=%s installed_id=%s name=%s skill_ref=%s",
                    user_id,
                    installed.id,
                    installed.name,
                    installed.json.get("spec", {}).get("skillRef"),
                )

        return payloads

    def _resolve_mcp_payloads(
        self,
        db: Session,
        *,
        user_id: int,
        installed_mcp_ids: Optional[List[int]] = None,
    ) -> List[Dict[str, Any]]:
        payloads: List[Dict[str, Any]] = []
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
                Kind.id == skill_id,
                Kind.kind == "Skill",
                Kind.is_active == True,
                Kind.user_id.in_([user_id, 0]),
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
    ) -> Dict[str, Any]:
        return {
            "installed_skill_id": installed_skill_id,
            "skill_id": skill.id,
            "name": skill.name,
            "namespace": skill.namespace,
            "is_public": skill.user_id == 0,
            "download_path": (
                f"/api/v1/kinds/skills/{skill.id}/download"
                f"?namespace={skill.namespace}"
            ),
        }

    def _extract_device_id(self, device: Dict[str, Any]) -> Optional[str]:
        value = (
            device.get("socket_device_id")
            or device.get("runtime_device_id")
            or device.get("device_id")
            or device.get("deviceId")
            or device.get("name")
        )
        return str(value) if value else None


device_capability_sync_service = DeviceCapabilitySyncService()

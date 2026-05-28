# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve and dispatch global capability sync requests to local executors."""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.socketio import get_sio
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

SYNC_EVENT = "device:sync_capabilities"
SYNC_NAMESPACE = "/local-executor"
SYNC_TIMEOUT_SECONDS = 180


class DeviceCapabilityResolutionError(RuntimeError):
    """Raised when requested capabilities cannot be resolved for sync."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class DeviceCapabilitySyncError(RuntimeError):
    """Raised when capability sync cannot be dispatched to a device."""


class DeviceCapabilitySyncService:
    """Backend-side resolver and dispatcher for local executor capabilities."""

    def build_desired_capabilities(
        self,
        db: Session,
        *,
        user_id: int,
        mode: str = "replace",
    ) -> dict[str, Any]:
        """Build the full enabled capability set from user install records."""
        self._validate_mode(mode)
        skills = self._load_enabled_installed_skills(db, user_id=user_id)
        mcps = self._load_enabled_installed_mcps(db, user_id=user_id)
        logger.info(
            "Built desired capabilities: user_id=%s mode=%s skill_names=%s mcp_names=%s",
            user_id,
            mode,
            [item.get("name") for item in skills],
            [item.get("name") for item in mcps],
        )
        return {"mode": mode, "skills": skills, "mcps": mcps}

    def resolve_payload(
        self,
        db: Session,
        *,
        user: User,
        skill_ids: list[int],
        installed_skill_ids: Optional[list[int]] = None,
        installed_mcp_ids: Optional[list[int]] = None,
        mcp_ids: Optional[list[str]] = None,
        mode: str = "merge",
    ) -> dict[str, Any]:
        """Resolve user-selected capability IDs into an executor payload."""
        self._validate_mode(mode)
        if mcp_ids:
            raise DeviceCapabilityResolutionError(
                "MCP capability sync is temporarily disabled for server-key IDs; use InstalledMCP IDs",
                422,
            )

        payload: dict[str, Any] = {
            "mode": mode,
            "skills": self._resolve_skill_payloads(
                db,
                user_id=user.id,
                skill_ids=skill_ids,
                installed_skill_ids=installed_skill_ids or [],
                strict=True,
            ),
        }
        mcps = self._resolve_mcp_payloads(
            db,
            user_id=user.id,
            installed_mcp_ids=installed_mcp_ids or [],
            strict=True,
        )
        if mcps:
            payload["mcps"] = mcps
        return payload

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
        results: list[DeviceCapabilitySyncResult] = []
        skipped = 0

        for device in devices:
            device_id = self._extract_device_id(device)
            if not device_id:
                skipped += 1
                continue
            results.append(
                await self.sync_device_payload(
                    user_id=user_id,
                    device_id=device_id,
                    payload=payload,
                )
            )

        return self._aggregate_response(results, skipped=skipped, mode=mode)

    async def sync_device_capabilities(
        self,
        db: Session,
        *,
        user: User,
        device_id: str,
        skill_ids: list[int],
        installed_skill_ids: Optional[Iterable[int]] = None,
        installed_mcp_ids: Optional[Iterable[int]] = None,
        mcp_ids: Optional[list[str]] = None,
        mode: str = "merge",
    ) -> DeviceCapabilitySyncResponse:
        """Resolve selected capabilities and send them to one online device."""
        device_kind = device_service.get_device_by_device_id(db, user.id, device_id)
        if not device_kind:
            raise DeviceCapabilityResolutionError(
                "Device not found or access denied", 404
            )

        payload = self.resolve_payload(
            db,
            user=user,
            skill_ids=skill_ids,
            installed_skill_ids=list(installed_skill_ids or []),
            installed_mcp_ids=list(installed_mcp_ids or []),
            mcp_ids=mcp_ids,
            mode=mode,
        )
        payload["device_id"] = device_id
        result = await self._dispatch_payload_or_raise(
            user_id=user.id,
            device_id=device_id,
            payload=payload,
        )
        return self._aggregate_response([result], skipped=0, mode=mode)

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
        user = User(id=user_id)
        return await self.sync_device_capabilities(
            db,
            user=user,
            device_id=device_id,
            skill_ids=list(skill_ids or []),
            installed_skill_ids=list(installed_skill_ids or []),
            installed_mcp_ids=list(installed_mcp_ids or []),
            mode=mode,
        )

    async def sync_device_payload(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: dict[str, Any],
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

        if not isinstance(response, dict):
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                error="Capability sync RPC returned invalid data",
            )
        if response.get("success") is False:
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                error=str(response.get("error") or "device rejected sync"),
                skills=response.get("skills", []),
                mcps=response.get("mcps", []),
                errors=response.get("errors", []),
            )
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            skills=response.get("skills", []),
            mcps=response.get("mcps", []),
            errors=response.get("errors", []),
        )

    async def _dispatch_payload_or_raise(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: dict[str, Any],
    ) -> DeviceCapabilitySyncResult:
        result = await self.sync_device_payload(
            user_id=user_id,
            device_id=device_id,
            payload=payload,
        )
        if result.error == "device is offline":
            raise DeviceCapabilityResolutionError(
                "Device is offline. Start the local executor and retry.", 409
            )
        if not result.success:
            raise DeviceCapabilitySyncError(result.error or "Capability sync failed")
        return result

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
            row.id for row in rows if row.is_active and self._is_enabled_install(row)
        ]
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
            row.id for row in rows if row.is_active and self._is_enabled_install(row)
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
                if strict:
                    raise DeviceCapabilityResolutionError(
                        f"InstalledSkill not found or access denied: {installed_id}",
                        404,
                    )
                continue
            skill = self._resolve_installed_skill_ref(db, installed)
            if not skill:
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
        return {
            "id": skill.id,
            "skill_id": skill.id,
            "installed_skill_id": installed_skill_id,
            "name": name,
            "namespace": namespace,
            "is_public": skill.user_id == 0,
            "download_path": (
                f"/api/v1/kinds/skills/{skill.id}/download?namespace={namespace}"
            ),
        }

    def _aggregate_response(
        self,
        results: list[DeviceCapabilitySyncResult],
        *,
        skipped: int,
        mode: str,
    ) -> DeviceCapabilitySyncResponse:
        synced = sum(1 for item in results if item.success)
        failed = sum(1 for item in results if not item.success)
        first = results[0] if results else None
        errors = []
        for result in results:
            errors.extend(result.errors or [])
            if result.error:
                errors.append({"device_id": result.device_id, "error": result.error})
        return DeviceCapabilitySyncResponse(
            success=failed == 0 and skipped == 0,
            device_id=first.device_id if first else "",
            mode=mode,
            skills=first.skills if first else [],
            mcps=first.mcps if first else [],
            errors=errors,
            synced=synced,
            failed=failed,
            skipped=skipped,
            results=results,
        )

    def _extract_device_id(self, device: dict[str, Any]) -> Optional[str]:
        value = (
            device.get("socket_device_id")
            or device.get("runtime_device_id")
            or device.get("device_id")
            or device.get("deviceId")
            or device.get("name")
        )
        return str(value) if value else None

    def _is_enabled_install(self, row: Kind) -> bool:
        spec = row.json.get("spec", {})
        return (
            spec.get("enabled", True)
            and spec.get("installState", "installed") == "installed"
        )

    def _validate_mode(self, mode: str) -> None:
        if mode not in {"merge", "replace"}:
            raise DeviceCapabilityResolutionError("Invalid sync mode", 422)


device_capability_sync_service = DeviceCapabilitySyncService()

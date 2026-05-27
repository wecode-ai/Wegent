# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve and dispatch local executor global capability sync requests."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

DEFAULT_SYNC_TIMEOUT_SECONDS = 180


class DeviceCapabilityResolutionError(RuntimeError):
    """Raised when requested capabilities cannot be resolved for sync."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class DeviceCapabilitySyncError(RuntimeError):
    """Raised when capability sync cannot be dispatched to a device."""


class DeviceCapabilitySyncService:
    """Backend-side resolver and dispatcher for global capability sync."""

    def resolve_payload(
        self,
        db: Session,
        *,
        user: User,
        skill_ids: list[int],
        mcp_ids: list[str] | None = None,
        mode: str = "merge",
    ) -> dict[str, Any]:
        """Resolve user-selected Skill IDs into executor payload."""
        if mode not in {"merge", "replace"}:
            raise DeviceCapabilityResolutionError("Invalid sync mode", 422)
        if mcp_ids:
            raise DeviceCapabilityResolutionError(
                "MCP capability sync is temporarily disabled", 422
            )

        skills = self._resolve_skills(db, user, skill_ids)
        return {
            "mode": mode,
            "skills": skills,
        }

    async def sync_device_capabilities(
        self,
        db: Session,
        *,
        user: User,
        device_id: str,
        skill_ids: list[int],
        mcp_ids: list[str] | None = None,
        mode: str = "merge",
    ) -> dict[str, Any]:
        """Resolve capability selections and send a WebSocket RPC to the device."""
        device_kind = device_service.get_device_by_device_id(db, user.id, device_id)
        if not device_kind:
            raise DeviceCapabilityResolutionError(
                "Device not found or access denied", 404
            )

        online_info = await device_service.get_device_online_info(user.id, device_id)
        if not online_info:
            raise DeviceCapabilityResolutionError(
                "Device is offline. Start the local executor and retry.", 409
            )
        socket_id = online_info.get("socket_id")
        if not socket_id:
            raise DeviceCapabilityResolutionError(
                "Device socket information not found", 409
            )

        payload = self.resolve_payload(
            db,
            user=user,
            skill_ids=skill_ids,
            mcp_ids=mcp_ids,
            mode=mode,
        )
        payload["device_id"] = device_id

        from app.core.socketio import get_sio

        try:
            response = await get_sio().call(
                "device:sync_capabilities",
                payload,
                to=socket_id,
                namespace="/local-executor",
                timeout=DEFAULT_SYNC_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            raise DeviceCapabilitySyncError(
                f"Capability sync RPC failed: {exc}"
            ) from exc

        if not isinstance(response, dict):
            raise DeviceCapabilitySyncError("Capability sync RPC returned invalid data")

        return {
            "success": bool(response.get("success")),
            "device_id": device_id,
            "mode": mode,
            "skills": response.get("skills", []),
            "errors": response.get("errors", []),
        }

    def _resolve_skills(
        self, db: Session, user: User, skill_ids: list[int]
    ) -> list[dict[str, Any]]:
        if not skill_ids:
            return []

        rows = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.id.in_(skill_ids),
                    Kind.kind == "Skill",
                    Kind.is_active == True,
                    or_(Kind.user_id == user.id, Kind.user_id == 0),
                )
            )
            .all()
        )
        by_id = {row.id: row for row in rows}
        missing = [skill_id for skill_id in skill_ids if skill_id not in by_id]
        if missing:
            raise DeviceCapabilityResolutionError(
                f"Skill not found or access denied: {missing[0]}", 404
            )

        skills: list[dict[str, Any]] = []
        for skill_id in skill_ids:
            skill = by_id[skill_id]
            name = skill.json.get("metadata", {}).get("name") or skill.name
            namespace = (
                skill.json.get("metadata", {}).get("namespace") or skill.namespace
            )
            skills.append(
                {
                    "id": skill.id,
                    "name": name,
                    "namespace": namespace,
                    "is_public": skill.user_id == 0,
                    "download_path": (
                        f"/api/v1/kinds/skills/{skill.id}/download?namespace={namespace}"
                    ),
                }
            )
        return skills


device_capability_sync_service = DeviceCapabilitySyncService()

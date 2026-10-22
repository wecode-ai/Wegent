# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve and dispatch global capability sync requests to local executors."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session

from app.core.socketio import get_sio
from app.db.session import get_db_session
from app.models.user import User
from app.schemas.device import (
    DeviceCapabilityItemResult,
    DeviceCapabilitySyncResponse,
    DeviceCapabilitySyncResult,
)
from app.services.device.capability_payloads import (
    CapabilityPayloadResolver,
    DeviceCapabilityResolutionError,
)
from app.services.device.plugin_sync_protocol import (
    load_versioned_plugin_payload,
    supports_plugin_sync_v2,
)
from app.services.device.runtime_route import RuntimeRouteError, runtime_route_resolver
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

SYNC_EVENT = "device:sync_capabilities"
SYNC_NAMESPACE = "/local-executor"
SYNC_TIMEOUT_SECONDS = 180
DESIRED_STATE_SYNC_ATTEMPTS = 3


def capability_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the stable desired state represented by a sync payload."""

    def normalized_items(field: str, identity_fields: tuple[str, ...]) -> list[dict]:
        items = []
        for raw in payload.get(field) or []:
            if not isinstance(raw, dict):
                continue
            item = {
                key: value
                for key, value in raw.items()
                if key not in {"download_path", "download_url_expires_at"}
            }
            items.append(item)
        return sorted(
            items,
            key=lambda item: tuple(
                str(item.get(field) or "") for field in identity_fields
            ),
        )

    return {
        "mode": payload.get("mode"),
        "scope": payload.get("scope"),
        "skills": normalized_items(
            "skills", ("installed_skill_id", "skill_id", "name")
        ),
        "plugins": normalized_items(
            "plugins", ("installed_plugin_id", "name", "marketplace")
        ),
        "removed_plugins": normalized_items(
            "removed_plugins", ("installed_plugin_id", "name", "marketplace")
        ),
        "mcps": normalized_items("mcps", ("installed_mcp_id", "name")),
    }


class DeviceCapabilitySyncError(RuntimeError):
    """Raised when capability sync cannot be dispatched to a device."""


class DeviceCapabilitySyncService(CapabilityPayloadResolver):
    """Backend-side resolver and dispatcher for local executor capabilities."""

    def __init__(
        self,
        session_factory: Callable[[], AbstractContextManager[Session]] | None = None,
    ) -> None:
        self._session_factory = session_factory or get_db_session

    def build_desired_capabilities(
        self,
        db: Session,
        *,
        user_id: int,
        mode: str = "replace",
        device_id: str | None = None,
        include_plugins: bool = True,
    ) -> dict[str, Any]:
        """Build desired state, merging Skills/MCP only when plugins are deferred."""
        self._validate_mode(mode)
        skills = self._load_enabled_installed_skills(db, user_id=user_id)
        plugins = (
            self._load_installed_plugins(db, user_id=user_id, device_id=device_id)
            if include_plugins
            else []
        )
        mcps = self._load_enabled_installed_mcps(db, user_id=user_id)
        # Replace treats an absent plugins array as empty on existing clients.
        # Merge preserves local plugins until their preparation can succeed.
        effective_mode = mode if include_plugins else "merge"
        logger.info(
            "Built desired capabilities: user_id=%s mode=%s skill_names=%s plugin_names=%s mcp_names=%s",
            user_id,
            effective_mode,
            [item.get("name") for item in skills],
            [item.get("name") for item in plugins],
            [item.get("name") for item in mcps],
        )
        payload: dict[str, Any] = {
            "mode": effective_mode,
            "skills": skills,
            "mcps": mcps,
        }
        if include_plugins:
            payload["plugins"] = plugins
        return payload

    def build_desired_plugins(
        self, db: Session, *, user_id: int, device_id: str
    ) -> dict[str, Any]:
        return {
            "mode": "merge",
            "scope": "plugins",
            "plugins": self._load_installed_plugins(
                db, user_id=user_id, device_id=device_id
            ),
        }

    def resolve_payload(
        self,
        db: Session,
        *,
        user: User,
        skill_ids: list[int],
        installed_skill_ids: Optional[list[int]] = None,
        installed_plugin_ids: Optional[list[int]] = None,
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
        plugins = self._resolve_plugin_payloads(
            db,
            user_id=user.id,
            installed_plugin_ids=installed_plugin_ids or [],
            strict=True,
        )
        if plugins:
            payload["plugins"] = plugins
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
        devices = await device_service.get_online_devices(db, user_id)
        logger.info(
            "Syncing global capabilities: user_id=%s mode=%s online_devices=%s",
            user_id,
            mode,
            len(devices),
        )
        results: list[DeviceCapabilitySyncResult] = []
        skipped = 0

        for device in devices:
            device_id = self._extract_device_id(device)
            if not device_id:
                skipped += 1
                logger.warning(
                    "Skipping capability sync for device without runtime id: user_id=%s device=%s",
                    user_id,
                    device,
                )
                continue
            results.append(
                await self.sync_current_device_capabilities(
                    user_id=user_id,
                    device_id=device_id,
                    mode=mode,
                )
            )

        return self._aggregate_response(results, skipped=skipped, mode=mode)

    async def sync_current_device_capabilities(
        self,
        *,
        user_id: int,
        device_id: str,
        mode: str = "replace",
        timeout_seconds: int = SYNC_TIMEOUT_SECONDS,
        include_plugins: bool = True,
    ) -> DeviceCapabilitySyncResult:
        """Sync a fresh snapshot and correct changes made during the round trip."""

        versioned = include_plugins and await self.supports_plugin_delta(
            user_id, device_id
        )

        def build(snapshot_db: Session) -> dict[str, Any]:
            return self.build_desired_capabilities(
                snapshot_db,
                user_id=user_id,
                mode=mode,
                device_id=device_id,
                include_plugins=include_plugins,
            )

        def load_payload() -> dict[str, Any]:
            if versioned:
                return load_versioned_plugin_payload(
                    self._session_factory,
                    user_id=user_id,
                    load_payload=build,
                    complete=True,
                )
            with self._session_factory() as snapshot_db:
                return build(snapshot_db)

        return await self.sync_latest_device_capabilities(
            user_id=user_id,
            device_id=device_id,
            load_payload=load_payload,
            timeout_seconds=timeout_seconds,
        )

    async def supports_plugin_delta(self, user_id: int, device_id: str) -> bool:
        try:
            route = await runtime_route_resolver.resolve(
                user_id=user_id, submitted_device_id=device_id
            )
        except RuntimeRouteError:
            return False
        return supports_plugin_sync_v2(route.online_info.get("runtime_features"))

    async def sync_plugin_change(
        self, *, user_id: int, device_id: str, installed_plugin_ids: list[int]
    ) -> DeviceCapabilitySyncResult:
        from app.services.device.plugin_change_sync import sync_plugin_change

        return await sync_plugin_change(
            self,
            user_id=user_id,
            device_id=device_id,
            installed_plugin_ids=installed_plugin_ids,
        )

    async def sync_latest_device_capabilities(
        self,
        *,
        user_id: int,
        device_id: str,
        load_payload: Callable[[], dict[str, Any]],
        timeout_seconds: int = SYNC_TIMEOUT_SECONDS,
    ) -> DeviceCapabilitySyncResult:
        """Dispatch desired state until the acknowledged snapshot is still current."""
        payload = await asyncio.to_thread(load_payload)
        result: DeviceCapabilitySyncResult | None = None
        for attempt in range(1, DESIRED_STATE_SYNC_ATTEMPTS + 1):
            from app.services.device.plugin_change_sync import dispatch_snapshot

            result = await dispatch_snapshot(
                self,
                user_id=user_id,
                device_id=device_id,
                payload=payload,
                timeout_seconds=timeout_seconds,
            )
            if not result.acknowledged:
                return result

            latest = await asyncio.to_thread(load_payload)
            if capability_snapshot(latest) == capability_snapshot(payload) and not any(
                item.status == "superseded" for item in result.plugins
            ):
                return result
            logger.warning(
                "Capability desired state changed during sync; retrying latest snapshot: "
                "user_id=%s device_id=%s attempt=%s",
                user_id,
                device_id,
                attempt,
            )
            payload = latest

        error = "Capability desired state kept changing during synchronization"
        logger.warning(
            "%s: user_id=%s device_id=%s attempts=%s",
            error,
            user_id,
            device_id,
            DESIRED_STATE_SYNC_ATTEMPTS,
        )
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=False,
            acknowledged=True,
            error=error,
            scope=result.scope if result else None,
            skills=result.skills if result else [],
            plugins=result.plugins if result else [],
            mcps=result.mcps if result else [],
            errors=result.errors if result else [],
            plugin_sync=result.plugin_sync if result else None,
            desired_plugin_snapshot=result.desired_plugin_snapshot if result else None,
        )

    async def sync_device_capabilities(
        self,
        db: Session,
        *,
        user: User,
        device_id: str,
        skill_ids: list[int],
        installed_skill_ids: Optional[Iterable[int]] = None,
        installed_plugin_ids: Optional[Iterable[int]] = None,
        installed_mcp_ids: Optional[Iterable[int]] = None,
        mcp_ids: Optional[list[str]] = None,
        mode: str = "merge",
    ) -> DeviceCapabilitySyncResponse:
        """Resolve selected capabilities and send them to one online device."""
        installed_skill_ids = list(installed_skill_ids or [])
        installed_plugin_ids = list(installed_plugin_ids or [])
        installed_mcp_ids = list(installed_mcp_ids or [])
        payload = self.resolve_payload(
            db,
            user=user,
            skill_ids=skill_ids,
            installed_skill_ids=installed_skill_ids,
            installed_plugin_ids=installed_plugin_ids,
            installed_mcp_ids=installed_mcp_ids,
            mcp_ids=mcp_ids,
            mode=mode,
        )
        if await self.supports_plugin_delta(user.id, device_id):
            from app.services.device.plugin_change_sync import (
                sync_selected_capabilities,
            )

            return await sync_selected_capabilities(
                self,
                user_id=user.id,
                device_id=device_id,
                payload=payload,
                skill_ids=skill_ids,
                installed_skill_ids=installed_skill_ids,
                installed_plugin_ids=installed_plugin_ids,
                installed_mcp_ids=installed_mcp_ids,
                mode=mode,
            )
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
        installed_plugin_ids: Optional[Iterable[int]] = None,
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
            installed_plugin_ids=list(installed_plugin_ids or []),
            installed_mcp_ids=list(installed_mcp_ids or []),
            mode=mode,
        )

    async def sync_installed_plugin_to_device(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        installed_plugin_id: int,
    ) -> DeviceCapabilitySyncResponse:
        """Merge one installed plugin and require its explicit acknowledgement."""
        response = await self.sync_installed_plugin_to_device_result(
            db,
            user_id=user_id,
            device_id=device_id,
            installed_plugin_id=installed_plugin_id,
        )
        plugin_result = next(
            (
                item
                for item in response.plugins
                if str(item.id) == str(installed_plugin_id)
            ),
            None,
        )
        if not plugin_result or plugin_result.status != "synced":
            detail = self._item_failure_message(plugin_result)
            raise DeviceCapabilitySyncError(
                detail
                or f"InstalledPlugin was not acknowledged by the device: {installed_plugin_id}"
            )
        return response

    async def sync_installed_plugin_to_device_result(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
        installed_plugin_id: int,
    ) -> DeviceCapabilitySyncResponse:
        """Merge one plugin and preserve its item-level failure in the response."""
        if await self.supports_plugin_delta(user_id, device_id):
            result = await self.sync_plugin_change(
                user_id=user_id,
                device_id=device_id,
                installed_plugin_ids=[installed_plugin_id],
            )
            return self._aggregate_response([result], skipped=0, mode="merge")
        payload = self.resolve_payload(
            db,
            user=User(id=user_id),
            skill_ids=[],
            installed_plugin_ids=[installed_plugin_id],
            mode="merge",
        )
        result = await self.sync_device_payload(
            user_id=user_id,
            device_id=device_id,
            payload=payload,
        )
        return self._aggregate_response([result], skipped=0, mode="merge")

    async def sync_device_payload(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: dict[str, Any],
        timeout_seconds: int = SYNC_TIMEOUT_SECONDS,
    ) -> DeviceCapabilitySyncResult:
        """Push an already-built desired payload to one online device."""
        snapshot = payload if payload.get("plugin_sync") else None
        try:
            route = await runtime_route_resolver.resolve(
                user_id=user_id,
                submitted_device_id=device_id,
            )
        except RuntimeRouteError as exc:
            logger.info(
                "Skipping capability sync without Runtime route: user_id=%s "
                "device_id=%s code=%s",
                user_id,
                device_id,
                exc.code,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                desired_plugin_snapshot=snapshot,
                error=(
                    "device not found or access denied"
                    if exc.code == "device_not_found"
                    else "device is offline"
                ),
            )

        if payload.get("plugin_sync") and not supports_plugin_sync_v2(
            route.online_info.get("runtime_features")
        ):
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                desired_plugin_snapshot=snapshot,
                error="Device plugin sync capability changed; retry synchronization",
            )
        dispatch_payload = {**payload, "device_id": route.runtime_device_id}
        started = time.monotonic()
        try:
            if snapshot is not None:
                from app.services.device.plugin_sync_protocol import (
                    register_plugin_snapshot_intent,
                )

                await asyncio.to_thread(
                    register_plugin_snapshot_intent,
                    self._session_factory,
                    user_id=user_id,
                    device_id=device_id,
                    payload=payload,
                )
            logger.info(
                "Sending capability sync: user_id=%s logical_device_id=%s "
                "runtime_device_id=%s socket_id=%s mode=%s skill_names=%s "
                "plugin_names=%s mcp_names=%s",
                user_id,
                device_id,
                route.runtime_device_id,
                route.socket_id,
                dispatch_payload.get("mode"),
                [item.get("name") for item in dispatch_payload.get("skills") or []],
                [item.get("name") for item in dispatch_payload.get("plugins") or []],
                [item.get("name") for item in dispatch_payload.get("mcps") or []],
            )
            response = await get_sio().call(
                SYNC_EVENT,
                dispatch_payload,
                to=route.socket_id,
                namespace=SYNC_NAMESPACE,
                timeout=timeout_seconds,
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
                desired_plugin_snapshot=snapshot,
                error=str(exc),
            )

        if not isinstance(response, dict):
            logger.warning(
                "Capability sync returned invalid data: user_id=%s device_id=%s response=%s",
                user_id,
                device_id,
                response,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                desired_plugin_snapshot=snapshot,
                error="Capability sync RPC returned invalid data",
            )
        if payload.get("plugin_sync"):
            from app.services.device.plugin_change_sync import validate_ack

            error = validate_ack(payload, response)
            if error:
                return DeviceCapabilitySyncResult(
                    device_id=device_id,
                    success=False,
                    error=error,
                    desired_plugin_snapshot=snapshot,
                )
        logger.info(
            "Capability sync timing: user_id=%s device_id=%s scope=%s "
            "plugins=%s removed=%s generation=%s rpc_ms=%.1f",
            user_id,
            device_id,
            payload.get("scope"),
            len(payload.get("plugins") or []),
            len(payload.get("removed_plugins") or []),
            (payload.get("plugin_sync") or {}).get("generation"),
            (time.monotonic() - started) * 1000,
        )
        if response.get("success") is False:
            logger.warning(
                "Capability sync rejected by device: user_id=%s device_id=%s response=%s",
                user_id,
                device_id,
                response,
            )
            return DeviceCapabilitySyncResult(
                device_id=device_id,
                success=False,
                acknowledged=True,
                scope=response.get("scope"),
                plugin_sync=response.get("plugin_sync"),
                desired_plugin_snapshot=payload if payload.get("plugin_sync") else None,
                error=str(
                    response.get("error")
                    or self._raw_item_failure_message(response)
                    or "device rejected sync"
                ),
                skills=response.get("skills", []),
                plugins=response.get("plugins", []),
                mcps=response.get("mcps", []),
                errors=response.get("errors", []),
            )
        logger.info(
            "Capability sync delivered: user_id=%s device_id=%s skills=%s plugins=%s mcps=%s",
            user_id,
            device_id,
            len(response.get("skills") or []),
            len(response.get("plugins") or []),
            len(response.get("mcps") or []),
        )
        return DeviceCapabilitySyncResult(
            device_id=device_id,
            success=True,
            acknowledged=True,
            scope=response.get("scope"),
            plugin_sync=response.get("plugin_sync"),
            desired_plugin_snapshot=payload if payload.get("plugin_sync") else None,
            skills=response.get("skills", []),
            plugins=response.get("plugins", []),
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
        if result.error == "device not found or access denied":
            raise DeviceCapabilityResolutionError(
                "Device not found or access denied", 404
            )
        if not result.success:
            raise DeviceCapabilitySyncError(result.error or "Capability sync failed")
        return result

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
            plugins=first.plugins if first else [],
            mcps=first.mcps if first else [],
            errors=errors,
            synced=synced,
            failed=failed,
            skipped=skipped,
            results=results,
        )

    @staticmethod
    def _item_failure_message(item: DeviceCapabilityItemResult | None) -> str | None:
        if item is None:
            return None
        error = (item.error or "").strip()
        if not error:
            return None
        name = (item.name or str(item.id or "plugin")).strip()
        stage = (item.stage or "").strip()
        location = f" during {stage}" if stage else ""
        return f"Plugin {name} failed{location}: {error}"

    @staticmethod
    def _raw_item_failure_message(response: dict[str, Any]) -> str | None:
        for field in ("plugins", "skills", "mcps"):
            for item in response.get(field) or []:
                if not isinstance(item, dict) or item.get("status") not in {
                    "failed",
                    "error",
                }:
                    continue
                error = str(item.get("error") or "").strip()
                if not error:
                    continue
                name = str(item.get("name") or item.get("id") or field[:-1])
                stage = str(item.get("stage") or "").strip()
                location = f" during {stage}" if stage else ""
                return f"{field[:-1].title()} {name} failed{location}: {error}"
        return None

    def _extract_device_id(self, device: dict[str, Any]) -> Optional[str]:
        value = (
            device.get("socket_device_id")
            or device.get("runtime_device_id")
            or device.get("device_id")
            or device.get("deviceId")
            or device.get("name")
        )
        return str(value) if value else None

    def _validate_mode(self, mode: str) -> None:
        if mode not in {"merge", "replace"}:
            raise DeviceCapabilityResolutionError("Invalid sync mode", 422)


device_capability_sync_service = DeviceCapabilitySyncService()

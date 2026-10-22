# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Dispatch fresh plugin deltas and share identical in-flight snapshots."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceCapabilitySyncResponse, DeviceCapabilitySyncResult
from app.services.device.plugin_sync_protocol import load_versioned_plugin_payload
from shared.telemetry.decorators import trace_async

if TYPE_CHECKING:
    from app.services.device.capability_sync_service import DeviceCapabilitySyncService

logger = logging.getLogger(__name__)
# Tasks live only for a round trip. Persisted account/device rows remain the retry source.
_dispatches: dict[tuple, asyncio.Task] = {}
_background: set[asyncio.Task] = set()


def build_plugin_delta(
    service: DeviceCapabilitySyncService,
    db: Session,
    *,
    user_id: int,
    device_id: str,
    installed_plugin_ids: list[int],
) -> dict[str, Any]:
    plugins = service._load_installed_plugins(
        db, user_id=user_id, device_id=device_id, only_ids=installed_plugin_ids
    )
    present = {item["installed_plugin_id"] for item in plugins}
    removed = []
    for installed in (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "InstalledPlugin",
            Kind.namespace == "default",
            Kind.id.in_(installed_plugin_ids),
        )
        .all()
    ):
        if installed.id in present:
            continue
        spec = installed.json.get("spec") or {}
        source = spec.get("source") or {}
        removed.append(
            {
                "installed_plugin_id": installed.id,
                "name": service._plugin_payload_name(installed, spec, source),
                "marketplace": spec.get("marketplace") or source.get("marketplace"),
            }
        )
    return {
        "mode": "merge",
        "scope": "plugin_delta",
        "plugins": plugins,
        "removed_plugins": removed,
    }


@trace_async("device.plugin_sync.change", "backend.device")
async def sync_plugin_change(
    service: DeviceCapabilitySyncService,
    *,
    user_id: int,
    device_id: str,
    installed_plugin_ids: list[int],
) -> DeviceCapabilitySyncResult:
    if not await service.supports_plugin_delta(user_id, device_id):
        return await service.sync_current_device_capabilities(
            user_id=user_id, device_id=device_id
        )

    def load() -> dict[str, Any]:
        return load_versioned_plugin_payload(
            service._session_factory,
            user_id=user_id,
            complete=False,
            load_payload=lambda db: build_plugin_delta(
                service,
                db,
                user_id=user_id,
                device_id=device_id,
                installed_plugin_ids=installed_plugin_ids,
            ),
        )

    return await service.sync_latest_device_capabilities(
        user_id=user_id,
        device_id=device_id,
        load_payload=load,
    )


async def sync_selected_capabilities(
    service: DeviceCapabilitySyncService,
    *,
    user_id: int,
    device_id: str,
    payload: dict[str, Any],
    skill_ids: list[int],
    installed_skill_ids: list[int],
    installed_plugin_ids: list[int],
    installed_mcp_ids: list[int],
    mode: str,
) -> DeviceCapabilitySyncResponse:
    """Keep the selected-capability API from bypassing plugin ordering fences."""
    if mode == "replace":

        def build(db: Session) -> dict[str, Any]:
            selected = service.resolve_payload(
                db,
                user=User(id=user_id),
                skill_ids=skill_ids,
                installed_skill_ids=installed_skill_ids,
                installed_mcp_ids=installed_mcp_ids,
                mode=mode,
            )
            selected["plugins"] = service._load_installed_plugins(
                db,
                user_id=user_id,
                device_id=device_id,
                only_ids=installed_plugin_ids,
            )
            return selected

        result = await service.sync_latest_device_capabilities(
            user_id=user_id,
            device_id=device_id,
            load_payload=lambda: load_versioned_plugin_payload(
                service._session_factory,
                user_id=user_id,
                load_payload=build,
                complete=True,
            ),
        )
    elif installed_plugin_ids:
        result = await service.sync_plugin_change(
            user_id=user_id,
            device_id=device_id,
            installed_plugin_ids=installed_plugin_ids,
        )
        if payload.get("skills") or payload.get("mcps"):
            independent = await service.sync_device_payload(
                user_id=user_id,
                device_id=device_id,
                payload={
                    key: value for key, value in payload.items() if key != "plugins"
                },
            )
            result = result.model_copy(
                update={
                    "skills": independent.skills,
                    "mcps": independent.mcps,
                    "success": result.success and independent.success,
                    "errors": result.errors + independent.errors,
                    "error": result.error or independent.error,
                }
            )
    else:
        result = await service.sync_device_payload(
            user_id=user_id,
            device_id=device_id,
            payload=payload,
        )
    return service._aggregate_response([result], skipped=0, mode=mode)


async def dispatch_snapshot(
    service: DeviceCapabilitySyncService,
    *,
    user_id: int,
    device_id: str,
    payload: dict[str, Any],
    timeout_seconds: int,
) -> DeviceCapabilitySyncResult:
    from app.services.device.capability_sync_service import capability_snapshot

    if not payload.get("plugin_sync"):
        return await service.sync_device_payload(
            user_id=user_id,
            device_id=device_id,
            payload=payload,
            timeout_seconds=timeout_seconds,
        )
    key = (
        user_id,
        device_id,
        payload["plugin_sync"]["generation"],
        json.dumps(capability_snapshot(payload), sort_keys=True),
        tuple(
            (str(item.get("installed_plugin_id")), item.get("download_path"))
            for item in payload.get("plugins") or []
            if not trusted_checksum(item.get("checksum"))
        ),
    )
    task = _dispatches.get(key)
    if task is None:
        task = asyncio.create_task(
            service.sync_device_payload(
                user_id=user_id,
                device_id=device_id,
                payload=payload,
                timeout_seconds=timeout_seconds,
            )
        )
        _dispatches[key] = task

        def completed(done: asyncio.Task) -> None:
            if _dispatches.get(key) is done:
                _dispatches.pop(key, None)

        task.add_done_callback(completed)
    else:
        logger.info(
            "Sharing plugin snapshot: user_id=%s device_id=%s", user_id, device_id
        )
    return await asyncio.shield(task)


def trusted_checksum(value: Any) -> bool:
    return (
        isinstance(value, str)
        and value.startswith("sha256:")
        and len(value) == 71
        and all(character in "0123456789abcdefABCDEF" for character in value[7:])
    )


def validate_ack(payload: dict[str, Any], response: dict[str, Any]) -> str | None:
    """Only explicit matching acknowledgements can materialize desired state."""
    metadata = payload["plugin_sync"]
    if type(response.get("success")) is not bool:
        return "Device returned invalid plugin acknowledgement success"
    acknowledgement = response.get("plugin_sync")
    if (
        not isinstance(acknowledgement, dict)
        or type(acknowledgement.get("version")) is not int
        or type(acknowledgement.get("generation")) is not int
        or type(acknowledgement.get("complete")) is not bool
        or acknowledgement != metadata
        or response.get("scope") != (payload.get("scope") or "all")
    ):
        return "Device returned a mismatched plugin snapshot acknowledgement"
    items = response.get("plugins")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        return "Device returned invalid plugin acknowledgement items"
    expected = {
        str(item["installed_plugin_id"]): ("upsert", item)
        for item in payload.get("plugins") or []
    }
    expected.update(
        {
            str(item["installed_plugin_id"]): ("remove", item)
            for item in payload.get("removed_plugins") or []
        }
    )
    seen = set()
    for item in items:
        identity = str(item.get("id"))
        inferred_removal = (
            metadata["complete"]
            and identity not in expected
            and item.get("operation") == "remove"
            and item.get("status") in {"removed", "failed", "superseded"}
        )
        if (identity not in expected and not inferred_removal) or identity in seen:
            return "Device returned unexpected plugin acknowledgement items"
        seen.add(identity)
        if (
            type(item.get("generation")) is not int
            or item.get("generation") != metadata["generation"]
        ):
            return "Device returned an obsolete plugin acknowledgement"
        if inferred_removal:
            continue
        operation, spec = expected[identity]
        if item.get("status") not in {"synced", "removed", "failed", "superseded"}:
            return "Device returned an invalid plugin acknowledgement status"
        if item.get("operation") != operation:
            return "Device returned a mismatched plugin operation"
        if item.get("status") == "synced" and (
            operation != "upsert"
            or item.get("version") != spec.get("version")
            or item.get("checksum") != spec.get("checksum")
        ):
            return "Device returned a mismatched plugin package acknowledgement"
        if item.get("status") == "removed" and operation != "remove":
            return "Device returned a mismatched plugin removal acknowledgement"
    if not expected.keys() <= seen:
        return "Device did not acknowledge every requested plugin"
    return None


@trace_async("device.plugin_sync.account_change", "backend.device")
async def sync_changed_plugin_to_devices(
    service: DeviceCapabilitySyncService,
    db: Session,
    *,
    user_id: int,
    installed_plugin_id: int,
    current_device_id: str | None,
) -> DeviceCapabilitySyncResponse:
    from app.services.device_service import device_service
    from app.services.plugin_device_identity import plugin_device_id

    devices = await device_service.get_online_devices(db, user_id)
    targets = list(
        dict.fromkeys(
            target
            for device in devices
            if (target := service._extract_device_id(device))
        )
    )
    current = None
    if current_device_id:
        current = next(
            (
                target
                for target in targets
                if plugin_device_id(db, user_id, target)
                == plugin_device_id(db, user_id, current_device_id)
            ),
            current_device_id,
        )
    # Release the request connection before waiting for any executor RPC.
    db.close()
    current_uses_delta = bool(
        current and await service.supports_plugin_delta(user_id, current)
    )
    if current_uses_delta:
        schedule_other_devices(
            service,
            user_id=user_id,
            device_ids=[id for id in targets if id != current],
            installed_plugin_ids=[installed_plugin_id],
        )
        results = [
            await service.sync_plugin_change(
                user_id=user_id,
                device_id=current,
                installed_plugin_ids=[installed_plugin_id],
            )
        ]
    else:
        results = list(
            await asyncio.gather(
                *(
                    service.sync_plugin_change(
                        user_id=user_id,
                        device_id=target,
                        installed_plugin_ids=[installed_plugin_id],
                    )
                    for target in targets
                )
            )
        )
    mode = (
        "merge"
        if current_uses_delta
        or (
            not current
            and any(result.desired_plugin_snapshot is not None for result in results)
        )
        else "replace"
    )
    return service._aggregate_response(results, skipped=0, mode=mode)


def schedule_other_devices(
    service: DeviceCapabilitySyncService,
    *,
    user_id: int,
    device_ids: list[str],
    installed_plugin_ids: list[int],
) -> None:
    """Keep other devices independent of the initiating device's HTTP response."""
    for device_id in device_ids:
        task = asyncio.create_task(
            _sync_and_record(service, user_id, device_id, installed_plugin_ids)
        )
        _background.add(task)
        task.add_done_callback(_background.discard)


@trace_async("device.plugin_sync.other_device", "backend.device")
async def _sync_and_record(
    service: DeviceCapabilitySyncService,
    user_id: int,
    device_id: str,
    installed_plugin_ids: list[int],
) -> None:
    from app.services.plugin_device_installation_service import (
        plugin_device_installation_service,
    )
    from app.services.plugin_write_operations import run_plugin_operation

    try:
        result = await service.sync_plugin_change(
            user_id=user_id,
            device_id=device_id,
            installed_plugin_ids=installed_plugin_ids,
        )
        await run_plugin_operation(
            plugin_device_installation_service.record_device_sync_result,
            user_id=user_id,
            result=result,
        )
    except Exception:
        logger.exception(
            "Plugin change remains pending: user_id=%s device_id=%s", user_id, device_id
        )

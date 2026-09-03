# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device namespace for Socket.IO.

This module implements the /local-executor namespace for local device connections.
It handles device authentication, registration, heartbeat, and task execution.

Authentication:
- Supports both JWT Token and API Key authentication
- API Key: Token starting with 'wg-' prefix (personal keys only)
- JWT Token: Standard JWT token with user info

Events:
- connect: Device authenticates with user JWT token or API Key
- device:register: Device registers itself with device_id and name
- device:heartbeat: Device sends heartbeat every 30s
- device:status: Device reports status (idle/busy)
- task:execute: Backend pushes task to device
- response.*: OpenAI Responses API streaming events from executor
- disconnect: Cleanup on device disconnection
"""

import asyncio
import logging
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from typing import Any, Dict, Generator, Optional
from urllib.parse import urlsplit

import socketio
from prometheus_client import Counter
from socketio.exceptions import ConnectionRefusedError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.ws.connection_utils import enter_connect_room, save_connect_session
from app.api.ws.decorators import trace_websocket_event
from app.api.ws.events import ServerEvents
from app.api.ws.local_task_responses import (
    LocalTaskResponsesHandler,
    emit_response_api_event,
    is_runtime_terminal_event_type,
    is_terminal_event,
    local_task_terminal_status,
    runtime_subtask_id,
    runtime_terminal_event,
)
from app.api.ws.wework_runtime_namespace import (
    PROJECT_CHAT_AGENT_CHUNK_EVENT,
    PROJECT_CHAT_CREATED_EVENT,
    WEWORK_RUNTIME_EVENT,
    WEWORK_RUNTIME_NAMESPACE,
    project_chat_room,
    wework_runtime_user_room,
)
from app.core.auth_utils import is_api_key, verify_api_key
from app.core.constants import get_wework_task_room, get_wework_user_room
from app.core.events import TaskCompletedEvent, get_event_bus
from app.core.socketio import get_sio
from app.db.session import SessionLocal
from app.models.subtask import SubtaskStatus
from app.models.user import User
from app.schemas.device import (
    DeviceHeartbeatPayload,
    DeviceOfflineEvent,
    DeviceOnlineEvent,
    DeviceRegisterPayload,
    DeviceSlotUpdateEvent,
    DeviceStatusEvent,
    DeviceStatusPayload,
    DeviceType,
)
from app.services.channels.callback import (
    forward_event_to_channel_callbacks,
)
from app.services.chat.access import get_token_expiry, verify_jwt_token
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.chat.webpage_ws_chat_emitter import get_extended_emitter
from app.services.device.capability_sync_service import device_capability_sync_service
from app.services.device.remote_control_policy import (
    remote_control_is_enabled,
)
from app.services.device.terminal_session_service import (
    TerminalSessionRecord,
    terminal_session_service,
)
from app.services.device_service import (
    RuntimeInstanceMismatchError,
    device_service,
    validate_persistent_runtime_instance_id,
)
from app.services.execution.dispatcher import ResponsesAPIEventParser
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from app.services.execution.emitters.websocket import WebSocketResultEmitter
from app.services.im.notification_dispatcher import im_notification_dispatcher
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_executions.device_pull import (
    acknowledge_execution,
    pull_execution,
)
from app.services.loop_item_executions.service import (
    loop_item_execution_service,
)
from app.services.plugin_device_installation_service import (
    plugin_device_installation_service,
)
from app.services.plugin_marketplace_service import plugin_marketplace_service
from app.services.project_chat.service import project_chat_service
from app.services.project_workflow_projection import update_workflow_task_status
from app.services.user_runtime_config import (
    UserRuntimeConfigError,
    UserRuntimeConfigSyncError,
    user_runtime_config_service,
)
from app.stores.tasks import subtask_store
from shared.models import EventType
from shared.telemetry.context import set_request_context, set_user_context

logger = logging.getLogger(__name__)

DEVICE_WS_AUTH_FAILURES_TOTAL = Counter(
    "device_ws_auth_failures_total",
    "Device WebSocket authentication rejections",
    ["reason"],
)
CODEX_RUNTIME = "codex"
DEVICE_CONNECT_RATE_LIMIT_WINDOW_SECONDS = 30
DEVICE_CONNECT_RATE_LIMIT_MAX_ATTEMPTS = 30
DEVICE_REGISTER_UPSERT_DEBOUNCE_SECONDS = 10
REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS = 120
DEVICE_DISCONNECT_FAILURE_GRACE_SECONDS = 2
RUNTIME_TASK_TERMINAL_STATUSES = {
    "done",
    "complete",
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
}
RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES = {
    "failed",
    "error",
    "cancelled",
    "canceled",
}


@dataclass(frozen=True)
class DeviceRegistrationFingerprint:
    """Persisted registration fields used to debounce exact reconnects only."""

    display_name: str
    client_ip: str
    device_type: str
    bind_shell: str
    runtime_transfer_host: str
    runtime_instance_id: str
    app_device_id: str


@contextmanager
def _db_session() -> Generator[Session, None, None]:
    """Context manager for database session with auto-commit and auto-close."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@dataclass
class FailedSubtaskInfo:
    """Information about a failed subtask for WebSocket emission."""

    task_id: int
    subtask_id: int
    message_id: Optional[int]
    user_id: int


def _handle_device_disconnect(user_id: int, device_id: str) -> list[FailedSubtaskInfo]:
    """
    Handle device disconnection in database.

    With CRD model, device record stays in kinds table (just becomes offline via Redis TTL).
    Fails running subtasks and updates parent task status.
    Returns list of failed subtasks for WebSocket emission.
    """
    failed_subtasks = []
    try:
        with _db_session() as db:
            # Note: Device CRD remains in kinds table, it's just offline (Redis TTL expired)
            # No need to call mark_device_offline on MySQL

            # Find and fail running subtasks
            executor_name = f"device-{device_id}"
            running_subtasks = subtask_store.list_running_by_executor_name(
                db,
                executor_name=executor_name,
            )

            # Track unique task IDs to update parent task status
            task_ids_to_fail = set()

            for subtask in running_subtasks:
                subtask_store.update_fields(
                    db,
                    subtask=subtask,
                    status=SubtaskStatus.FAILED,
                    error_message="Device disconnected unexpectedly",
                    completed_at=datetime.now(),
                )
                task_ids_to_fail.add(subtask.task_id)
                failed_subtasks.append(
                    FailedSubtaskInfo(
                        task_id=subtask.task_id,
                        subtask_id=subtask.id,
                        message_id=subtask.message_id,
                        user_id=user_id,
                    )
                )
                logger.warning(
                    f"[Device WS] Marked subtask {subtask.id} as FAILED due to device disconnect"
                )

            # Update parent task status to FAILED
            if task_ids_to_fail:
                from app.schemas.task import TaskUpdate
                from app.services.adapters.task_kinds import task_kinds_service

                for task_id in task_ids_to_fail:
                    try:
                        task_kinds_service.update_task(
                            db=db,
                            task_id=task_id,
                            obj_in=TaskUpdate(status="FAILED"),
                            user_id=user_id,
                        )
                        logger.warning(
                            f"[Device WS] Marked task {task_id} as FAILED due to device disconnect"
                        )
                    except Exception as e:
                        logger.error(
                            f"[Device WS] Failed to update task {task_id} status: {e}"
                        )

    except Exception as e:
        logger.error(f"[Device WS] Error handling device disconnect: {e}")

    return failed_subtasks


def _register_device(
    user_id: int,
    device_id: str,
    name: str,
    client_ip: Optional[str] = None,
    device_type: Optional[str] = None,
    bind_shell: Optional[str] = None,
    runtime_transfer_host: Optional[str] = None,
    runtime_instance_id: Optional[str] = None,
    app_device_id: Optional[str] = None,
) -> tuple[bool, Optional[str], Optional[str]]:
    """
    Register or update device CRD in database.

    Args:
        user_id: Device owner user ID
        device_id: Device unique identifier (stored in Kind.name)
        name: Device display name
        client_ip: Device's client IP address
        device_type: Device type ('local', 'app', 'cloud', or 'remote')
        bind_shell: Shell runtime binding ('claudecode' or 'openclaw')
        runtime_transfer_host: Host peers should use for direct transfers
        runtime_instance_id: Stable runtime installation ID shared by all routes
        app_device_id: Desktop app IPC device ID for app registrations

    Returns (success, persisted_display_name, error_message).
    """
    try:
        with _db_session() as db:
            device_kind = device_service.upsert_device_crd(
                db=db,
                user_id=user_id,
                device_id=device_id,
                name=name,
                client_ip=client_ip,
                device_type=device_type,
                bind_shell=bind_shell,
                runtime_transfer_host=runtime_transfer_host,
                runtime_instance_id=runtime_instance_id,
                app_device_id=app_device_id,
            )
            persisted_display_name = (
                device_kind.json.get("spec", {}).get("displayName") or name
            )
        return True, persisted_display_name, None
    except Exception as e:
        logger.error(f"[Device WS] Error registering device: {e}")
        return False, None, str(e)


def _normalize_runtime_transfer_host(value: Any) -> Optional[str]:
    """Normalize an executor-advertised direct-transfer host."""

    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    parsed = urlsplit(candidate)
    if parsed.scheme and parsed.hostname:
        candidate = parsed.hostname
    elif "/" in candidate:
        return None
    return candidate.strip("[]") or None


def _update_device_heartbeat(user_id: int, device_id: str) -> None:
    """
    Update device heartbeat timestamp.

    With CRD model, heartbeat is primarily tracked in Redis.
    No MySQL update needed.
    """
    # Heartbeat is managed via Redis in the async handler
    pass


def _update_device_status(user_id: int, device_id: str, status: str) -> None:
    """
    Update device status.

    With CRD model, status is primarily tracked in Redis.
    No MySQL update needed.
    """
    # Status is managed via Redis in the async handler
    pass


def _match_cloud_device_sync(
    user_id: int,
    client_ip: str,
    executor_device_id: str,
    runtime_instance_id: Optional[str] = None,
) -> Optional[tuple[str, bool, Optional[dict]]]:
    """
    Synchronous helper to match cloud device by device_id.

    Returns:
        Tuple of (logical_device_id, needs_migration, device_data) if matched,
        None otherwise.
        - logical_device_id: The canonical Device CRD name exposed to clients
        - needs_migration: True if legacy device needs migration
        - device_data: Dict with device info for migration (device_id, etc.)
    """
    import copy

    from sqlalchemy import and_
    from sqlalchemy.orm.attributes import flag_modified

    from app.models.kind import Kind
    from app.schemas.device import DeviceType

    with get_db_session() as db:
        cloud_devices = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.is_active.is_(True),
                    Kind.json["spec"]["deviceType"].as_string()
                    == DeviceType.CLOUD.value,
                )
            )
            .with_for_update()
            .all()
        )

        logger.info(
            f"[Device WS] Cloud device matching: "
            f"user_id={user_id}, client_ip={client_ip}, "
            f"cloud_device_count={len(cloud_devices)}, "
            f"executor_device_id={executor_device_id}"
        )

        for device in cloud_devices:
            spec = device.json.get("spec", {})
            cloud_config = spec.get("cloudConfig", {})
            sandbox_id = cloud_config.get("sandboxId", device.name)
            server_device_id = cloud_config.get("deviceId")

            # New logic: verify server-generated device_id matches
            if server_device_id:
                if server_device_id == executor_device_id:
                    validate_persistent_runtime_instance_id(
                        device.json,
                        runtime_instance_id,
                        device_id=sandbox_id,
                    )
                    if runtime_instance_id:
                        device_json = copy.deepcopy(device.json)
                        device_json.setdefault("spec", {})[
                            "runtimeInstanceId"
                        ] = runtime_instance_id
                        device.json = device_json
                        flag_modified(device, "json")
                        db.add(device)
                        db.commit()
                    logger.info(
                        f"[Device WS] Cloud device matched by device_id: "
                        f"logical_device_id={device.name}, "
                        f"sandbox_id={sandbox_id}, "
                        f"device_id={executor_device_id}"
                    )
                    return (device.name, False, None)
                else:
                    # Device ID mismatch - skip this device
                    logger.debug(
                        f"[Device WS] Cloud device ID mismatch: "
                        f"expected={server_device_id}, "
                        f"got={executor_device_id}"
                    )
                    continue
            else:
                # Backward compatibility: old device without deviceId field
                # Use legacy matching (device.name still equals sandbox_id)
                if device.name == sandbox_id:
                    validate_persistent_runtime_instance_id(
                        device.json,
                        runtime_instance_id,
                        device_id=sandbox_id,
                    )
                    logger.info(
                        f"[Device WS] Cloud device matched (legacy mode): "
                        f"sandbox_id={sandbox_id}, "
                        f"new_device_id={executor_device_id}"
                    )
                    return (
                        device.name,
                        True,
                        {"device_id": device.id, "sandbox_id": sandbox_id},
                    )

    return None


def _update_cloud_device_id_sync(
    user_id: int,
    device_db_id: int,
    executor_device_id: str,
    sandbox_id: str,
    runtime_instance_id: Optional[str] = None,
) -> str:
    """
    Synchronous helper to update cloud device ID in CRD for backward compatibility.

    Args:
        user_id: User ID
        device_db_id: Device database ID (Kind.id)
        executor_device_id: New device ID from executor
        sandbox_id: Sandbox ID

    Returns:
        Canonical Device CRD name after migration
    """
    import copy

    from sqlalchemy.orm.attributes import flag_modified

    from app.models.kind import Kind

    with get_db_session() as db:
        device = (
            db.query(Kind)
            .filter(
                Kind.id == device_db_id,
                Kind.user_id == user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .with_for_update()
            .first()
        )
        if not device:
            logger.error(
                f"[Device WS] Device not found for migration: id={device_db_id}"
            )
            return executor_device_id

        device_json = copy.deepcopy(device.json)
        validate_persistent_runtime_instance_id(
            device_json,
            runtime_instance_id,
            device_id=sandbox_id,
        )
        old_device_id = device.name
        device_json["metadata"]["name"] = executor_device_id
        device_json["spec"]["deviceId"] = executor_device_id
        if runtime_instance_id:
            device_json["spec"]["runtimeInstanceId"] = runtime_instance_id

        # Update cloudConfig with deviceId for future matching
        if "cloudConfig" in device_json["spec"]:
            device_json["spec"]["cloudConfig"]["deviceId"] = executor_device_id

        device.name = executor_device_id
        device.json = device_json
        flag_modified(device, "json")

        logger.info(
            f"[Device WS] Migrated legacy cloud device to new format: "
            f"old_id={old_device_id}, new_id={executor_device_id}, "
            f"sandbox_id={sandbox_id}"
        )

    return executor_device_id


def _verify_api_key_sync(token: str) -> Optional[tuple[int, str]]:
    """
    Synchronous helper to verify API key.

    Returns:
        Tuple of (user_id, user_name) if valid, None otherwise.
    """
    with get_db_session() as db:
        user = verify_api_key(db, token, update_last_used_at=False)
        if user:
            return (user.id, user.user_name)
    return None


def _get_device_slot_usage_sync(user_id: int, device_id: str) -> dict:
    """
    Synchronous helper to get device slot usage.

    Returns:
        Dict with slot usage info.
    """
    with get_db_session() as db:
        return device_service.get_device_slot_usage(db, user_id, device_id)


async def _store_device_capabilities_state(
    user_id: int, device_id: str, capabilities: dict
) -> None:
    """Store heartbeat capability state without dropping previous full lists."""
    if not isinstance(capabilities, dict):
        return

    digest = capabilities.get("digest")
    revision = capabilities.get("revision")
    if not digest or revision is None:
        return

    existing = await device_service.get_device_capabilities_state(user_id, device_id)
    if capabilities.get("full"):
        await device_service.store_device_capabilities_state(
            user_id,
            device_id,
            {
                "revision": revision,
                "digest": digest,
                "skills": capabilities.get("skills", []),
                "plugins": capabilities.get("plugins", []),
                "mcps": capabilities.get("mcps", []),
                "last_sync_at": capabilities.get("last_sync_at"),
            },
        )
        return

    if existing and existing.get("digest") == digest:
        existing["revision"] = revision
        existing["digest"] = digest
        await device_service.store_device_capabilities_state(
            user_id, device_id, existing
        )


def _runtime_auth_file_missing(runtime_auth_files: Any, runtime: str) -> bool:
    """Return True only when heartbeat explicitly reports a missing runtime auth file."""
    if not isinstance(runtime_auth_files, dict):
        return False
    state = runtime_auth_files.get(runtime)
    if not isinstance(state, dict):
        return False
    return state.get("exists") is False


def _is_runtime_task_terminal_status(status: Any) -> bool:
    """Return True when a runtime task update represents a completed turn."""
    normalized = _normalize_runtime_task_status(status)
    return normalized in RUNTIME_TASK_TERMINAL_STATUSES


def _is_runtime_task_reply_status(status: Any) -> bool:
    normalized = _normalize_runtime_task_status(status)
    return (
        normalized in RUNTIME_TASK_TERMINAL_STATUSES
        and normalized not in RUNTIME_TASK_NON_REPLY_TERMINAL_STATUSES
    )


def _summarize_runtime_notification_results(
    notification: dict[str, Any],
) -> list[dict[str, Any]]:
    results = notification.get("results")
    if not isinstance(results, list):
        return []
    summarized: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        summarized.append(
            {
                "success": bool(result.get("success")),
                "channel_id": result.get("channel_id"),
                "channel_type": result.get("channel_type"),
                "session_key": result.get("session_key"),
                "error": result.get("error"),
                "error_type": result.get("error_type"),
            }
        )
    return summarized


def _normalize_runtime_task_status(status: Any) -> str:
    if not isinstance(status, str):
        return ""
    return status.strip().replace("_", "").replace("-", "").lower()


def response_api_payload(*, data: dict[str, Any], device_id: str) -> dict[str, Any]:
    payload = dict(data)
    payload["device_id"] = device_id
    return payload


def _execution_item_version(db: Session, execution: object) -> int | None:
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return None
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id)
    return int(item.version) if item is not None else None


def _publish_execution_item_change(
    db: Session,
    *,
    execution: object,
    previous_version: int | None,
) -> None:
    if previous_version is None:
        return
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id, populate_existing=True)
    if item is None or item.version == previous_version:
        return
    publish_loop_item_changed(
        db,
        item=item,
        reason="runtime_execution_status",
        actor_user_id=int(getattr(execution, "executor_owner_user_id", 0) or 0),
    )


def _project_execution_workflow_status(
    db: Session,
    *,
    execution: object,
    projected_status: str,
    ready_before: set[str],
) -> dict[str, Any] | None:
    """Project accepted runtime truth onto its bound workflow task."""

    from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset

    user_id = int(getattr(execution, "executor_owner_user_id", 0) or 0)
    device_id = str(getattr(execution, "runtime_device_id", "") or "")
    task_id = str(getattr(execution, "runtime_task_id", "") or "")
    loop_item_id = str(getattr(execution, "loop_item_id", "") or "")
    if not all((user_id, device_id, task_id, loop_item_id, projected_status)):
        return None

    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == loop_item_id,
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == device_id,
            LoopItemTaskBinding.task_id == task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .first()
    )
    if binding is None or not binding.workflow_node_id:
        return None

    from app.models.delivery import LoopItem

    item = update_workflow_task_status(
        db,
        user_id=user_id,
        device_id=device_id,
        task_id=task_id,
        execution_status=projected_status,
    )
    if item is None:
        return None
    newly_ready = (
        issue_workflow_start_service.ready_robot_stage_ids(item) - ready_before
    )
    logger.info(
        "[IssueWorkflowContinuation] detected item=%s execution=%s event_status=%s "
        "ready_before=%s newly_ready=%s",
        item.id,
        getattr(execution, "id", None),
        projected_status,
        sorted(ready_before),
        sorted(newly_ready),
    )
    return {
        "item_id": str(item.id),
        "user_id": user_id,
        "stage_ids": sorted(newly_ready),
    }


def _workflow_status_for_runtime_event(
    event_name: str,
    payload: dict[str, Any],
) -> str | None:
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    terminal_status = project_chat_service._project_chat_terminal_status(
        event_name,
        payload,
        data,
    )
    if terminal_status == "completed":
        return "succeeded"
    if terminal_status in {"failed", "cancelled"}:
        return terminal_status
    if event_name in {
        "response.created",
        "runtime.task.started",
        "runtime.task.status",
    }:
        return "running"
    return None


def _execution_ready_robot_stage_ids(
    db: Session,
    execution: object | None,
) -> set[str]:
    if execution is None:
        return set()
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return set()
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id)
    if item is None:
        return set()
    return issue_workflow_start_service.ready_robot_stage_ids(item)


def _project_bound_runtime_event_status(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    task_id: str,
    event_name: str,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    """Project a manually bound Runtime task that has no execution row."""

    from app.models.delivery import (
        LoopItem,
        LoopItemTaskBinding,
        loop_datetime_is_unset,
    )

    projected_status = _workflow_status_for_runtime_event(event_name, payload)
    if projected_status is None:
        return None
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == device_id,
            LoopItemTaskBinding.task_id == task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .first()
    )
    if binding is None or not binding.loop_item_id:
        logger.info(
            "[IssueTaskRuntimeSync] binding_miss user=%s device=%s task=%s " "event=%s",
            user_id,
            device_id,
            task_id,
            event_name,
        )
        return None
    item_before = db.get(LoopItem, binding.loop_item_id)
    if item_before is None:
        logger.warning(
            "[IssueTaskRuntimeSync] item_miss user=%s device=%s task=%s "
            "binding=%s item=%s",
            user_id,
            device_id,
            task_id,
            binding.id,
            binding.loop_item_id,
        )
        return None
    if not binding.workflow_node_id:
        raw_event_seq = payload.get("eventSeq", payload.get("event_seq"))
        if isinstance(raw_event_seq, bool):
            raw_event_seq = None
        try:
            event_seq = int(raw_event_seq)
        except (TypeError, ValueError):
            event_seq = 0
        binding_metadata = (
            dict(binding.metadata_json)
            if isinstance(binding.metadata_json, dict)
            else {}
        )
        raw_last_event_seq = binding_metadata.get("runtime_status_event_seq")
        try:
            last_event_seq = int(raw_last_event_seq)
        except (TypeError, ValueError):
            last_event_seq = 0
        if event_seq <= 0:
            logger.warning(
                "[IssueTaskRuntimeSync] rejected unsequenced direct binding event "
                "user=%s device=%s task=%s event=%s",
                user_id,
                device_id,
                task_id,
                event_name,
            )
            return None
        if event_seq <= last_event_seq:
            logger.info(
                "[IssueTaskRuntimeSync] ignored reordered direct binding event "
                "user=%s device=%s task=%s event=%s current_seq=%s incoming_seq=%s",
                user_id,
                device_id,
                task_id,
                event_name,
                last_event_seq,
                event_seq,
            )
            return None
        binding_metadata["runtime_status_event_seq"] = event_seq
        binding.metadata_json = binding_metadata
        next_status = (
            "in_progress"
            if projected_status == "running"
            else (
                "in_review"
                if projected_status in {"succeeded", "failed", "cancelled"}
                and item_before.status not in {"completed", "in_review"}
                else None
            )
        )
        if next_status is None or item_before.status == next_status:
            return None
        from app.models.delivery import CloudProject
        from app.services.loop_item_status_history import write_status_change

        project = db.get(CloudProject, item_before.cloud_project_id)
        metadata = (
            dict(item_before.metadata_json)
            if isinstance(item_before.metadata_json, dict)
            else {}
        )
        if project is not None:
            write_status_change(
                metadata,
                project=project,
                from_status=item_before.status,
                to_status=next_status,
                trigger=f"runtime_{projected_status}",
                by_user_id=None,
            )
        item_before.metadata_json = metadata
        item_before.status = next_status
        item_before.completed_at = project_chat_service._loop_unset_datetime(db)
        item_before.sort_order = 0
        item_before.version += 1
        db.flush()
        publish_loop_item_changed(
            db,
            item=item_before,
            reason="runtime_execution_status",
            actor_user_id=user_id,
        )
        logger.info(
            "[IssueTaskRuntimeSync] projected source=direct_binding user=%s "
            "device=%s task=%s event=%s status=%s item=%s",
            user_id,
            device_id,
            task_id,
            event_name,
            projected_status,
            item_before.id,
        )
        return {
            "item_id": str(item_before.id),
            "user_id": user_id,
            "stage_ids": [],
        }

    ready_before = issue_workflow_start_service.ready_robot_stage_ids(item_before)
    item = update_workflow_task_status(
        db,
        user_id=user_id,
        device_id=device_id,
        task_id=task_id,
        execution_status=projected_status,
    )
    if item is None:
        return None
    newly_ready = (
        issue_workflow_start_service.ready_robot_stage_ids(item) - ready_before
    )
    logger.info(
        "[IssueTaskRuntimeSync] projected source=binding user=%s device=%s "
        "task=%s event=%s status=%s item=%s node=%s newly_ready=%s",
        user_id,
        device_id,
        task_id,
        event_name,
        projected_status,
        item.id,
        binding.workflow_node_id,
        sorted(newly_ready),
    )
    return {
        "item_id": str(item.id),
        "user_id": user_id,
        "stage_ids": sorted(newly_ready),
    }


async def _continue_projected_workflow(intent: dict[str, Any] | None) -> None:
    if not intent or not intent.get("stage_ids"):
        return
    from app.models.delivery import LoopItem

    with get_db_session() as db:
        item = db.get(LoopItem, str(intent["item_id"]))
        if item is None:
            logger.warning(
                "[IssueWorkflowContinuation] skipped item=%s reason=item_missing "
                "stages=%s",
                intent["item_id"],
                intent["stage_ids"],
            )
            return
        logger.info(
            "[IssueWorkflowContinuation] dispatching item=%s stages=%s user=%s",
            item.id,
            intent["stage_ids"],
            intent["user_id"],
        )
        try:
            started = await issue_workflow_start_service.continue_ready_stages(
                db,
                item=item,
                user_id=int(intent["user_id"]),
                stage_ids=set(intent["stage_ids"]),
            )
        except Exception:
            logger.exception(
                "[IssueWorkflowContinuation] failed item=%s stages=%s user=%s",
                item.id,
                intent["stage_ids"],
                intent["user_id"],
            )
            raise
        logger.info(
            "[IssueWorkflowContinuation] completed item=%s stages=%s started=%s",
            item.id,
            intent["stage_ids"],
            started,
        )


def _project_chat_runtime_event_sync(
    device_id: str,
    event: dict[str, Any],
    user_id: int | None = None,
    trusted_terminal_snapshot: bool = False,
) -> dict[str, Any] | None:
    event_name = event.get("event")
    payload = event.get("payload")
    if not isinstance(event_name, str) or not isinstance(payload, dict):
        logger.info(
            "[ProjectChat] Runtime event projection skipped invalid payload: "
            "device_id=%s event=%s payload_type=%s",
            device_id,
            event_name,
            type(payload).__name__,
        )
        return None
    runtime_task_id = (
        payload.get("taskId")
        or payload.get("task_id")
        or payload.get("localTaskId")
        or payload.get("local_task_id")
    )
    if not isinstance(runtime_task_id, str) or not runtime_task_id:
        logger.info(
            "[ProjectChat] Runtime event projection skipped missing runtime task id: "
            "device_id=%s event=%s payload_keys=%s payload_status=%s",
            device_id,
            event_name,
            sorted(payload.keys()),
            payload.get("status"),
        )
        return None
    projected_status = _workflow_status_for_runtime_event(event_name, payload)
    log_runtime_event = logger.info if projected_status is not None else logger.debug
    log_runtime_event(
        "[IssueTaskRuntimeSync] received user=%s device=%s task=%s event=%s "
        "event_seq=%s workflow_status=%s",
        user_id,
        device_id,
        runtime_task_id,
        event_name,
        payload.get("eventSeq") or payload.get("event_seq"),
        projected_status,
    )
    with get_db_session() as db:
        # The LoopItemExecution is the aggregate root for Wework automation
        # outcomes. Elect its terminal state before projecting chat so a
        # concurrent complete/fail/cancel cannot leave the run and activity
        # disagreeing with the execution. Streaming events remain ordinary
        # chat projections after the lease write-back.
        execution = loop_item_execution_service.execution_for_runtime(
            db,
            runtime_device_id=device_id,
            runtime_task_id=runtime_task_id,
        )
        ready_before = (
            _execution_ready_robot_stage_ids(db, execution)
            if projected_status is not None
            else set()
        )
        previous_item_version = (
            _execution_item_version(db, execution) if execution is not None else None
        )
        matched_execution = loop_item_execution_service.handle_runtime_event(
            db,
            device_id=device_id,
            runtime_task_id=runtime_task_id,
            event_name=event_name,
            payload=payload,
            allow_unsequenced_terminal=trusted_terminal_snapshot,
        )
        if execution is not None and matched_execution is None:
            logger.info(
                "[ProjectChat] Runtime event projection rejected by execution truth: "
                "device_id=%s task_id=%s event=%s",
                device_id,
                runtime_task_id,
                event_name,
            )
            return None
        if matched_execution is not None:
            workflow_continuation = (
                _project_execution_workflow_status(
                    db,
                    execution=matched_execution,
                    projected_status=projected_status,
                    ready_before=ready_before,
                )
                if projected_status is not None
                else None
            )
            log_projection = (
                logger.info if projected_status is not None else logger.debug
            )
            log_projection(
                "[IssueTaskRuntimeSync] projected source=execution execution=%s "
                "user=%s device=%s task=%s event=%s execution_status=%s "
                "workflow_status=%s item=%s workflow_projected=%s",
                matched_execution.id,
                matched_execution.executor_owner_user_id,
                device_id,
                runtime_task_id,
                event_name,
                matched_execution.status,
                projected_status,
                matched_execution.loop_item_id,
                workflow_continuation is not None,
            )
            db.flush()
            _publish_execution_item_change(
                db,
                execution=matched_execution,
                previous_version=previous_item_version,
            )
        else:
            workflow_continuation = (
                _project_bound_runtime_event_status(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    task_id=runtime_task_id,
                    event_name=event_name,
                    payload=payload,
                )
                if user_id is not None
                else None
            )
            if user_id is None:
                logger.info(
                    "[IssueTaskRuntimeSync] skipped reason=no_execution_or_user "
                    "device=%s task=%s event=%s",
                    device_id,
                    runtime_task_id,
                    event_name,
                )
        projected = project_chat_service.project_runtime_event(
            db,
            device_id=device_id,
            runtime_task_id=runtime_task_id,
            event_name=event_name,
            payload=payload,
        )
        if projected is None:
            return {
                "message": None,
                "mode": None,
                "workflow_continuation": workflow_continuation,
            }
        message, mode = projected
        return {
            "message": message.model_dump(mode="json", by_alias=True),
            "mode": mode,
            "workflow_continuation": workflow_continuation,
        }


def _execution_runtime_event_sync(
    device_id: str, task_id: object, event_name: str, payload: dict
) -> dict[str, Any] | None:
    """Project device runtime events onto the matching robot execution."""

    try:
        with get_db_session() as db:
            execution = loop_item_execution_service.execution_for_runtime(
                db,
                runtime_device_id=device_id,
                runtime_task_id=str(task_id),
            )
            projected_status = _workflow_status_for_runtime_event(event_name, payload)
            ready_before = (
                _execution_ready_robot_stage_ids(db, execution)
                if projected_status is not None
                else set()
            )
            previous_item_version = (
                _execution_item_version(db, execution)
                if execution is not None
                else None
            )
            matched = loop_item_execution_service.handle_runtime_event(
                db,
                device_id=device_id,
                runtime_task_id=str(task_id),
                event_name=event_name,
                payload=payload,
            )
            if matched is not None:
                workflow_continuation = (
                    _project_execution_workflow_status(
                        db,
                        execution=matched,
                        projected_status=projected_status,
                        ready_before=ready_before,
                    )
                    if projected_status is not None
                    else None
                )
                db.flush()
                _publish_execution_item_change(
                    db,
                    execution=matched,
                    previous_version=previous_item_version,
                )
                return workflow_continuation
            return None
    except Exception:
        logger.exception(
            "[RobotQueue] Execution runtime event write-back failed "
            "device=%s task=%s event=%s",
            device_id,
            task_id,
            event_name,
        )
        return None


async def emit_chat_user_event(
    *, event_name: str, payload: dict[str, Any], user_id: int
) -> None:
    sio = get_sio()
    for room in (f"user:{user_id}", get_wework_user_room(user_id)):
        await sio.emit(
            event_name,
            payload,
            room=room,
            namespace="/chat",
        )


class DeviceNamespace(socketio.AsyncNamespace):
    """
    Socket.IO namespace for local executor connections.

    Handles:
    - Authentication on connect (using user JWT token)
    - Device registration and management
    - Heartbeat monitoring
    - Task execution routing
    """

    def __init__(self, namespace: str = "/local-executor"):
        """Initialize the device namespace."""
        super().__init__(namespace)

        # Map colon-separated event names to handler methods
        self._event_handlers: Dict[str, str] = {
            "device:register": "on_device_register",
            "device:heartbeat": "on_device_heartbeat",
            "device:status": "on_device_status",
            "device:upgrade_status": "on_device_upgrade_status",
            "runtime:event": "on_runtime_event",
            "runtime.tasks.pull": "on_runtime_tasks_pull",
            "runtime.tasks.accept": "on_runtime_tasks_accept",
            "runtime.tasks.updated": "on_runtime_task_updated",
            "terminal:output": "on_terminal_output",
            "terminal:exit": "on_terminal_exit",
        }

        # Shared event parser for OpenAI Responses API events
        self._event_parser = ResponsesAPIEventParser()
        self._local_task_responses = LocalTaskResponsesHandler(self._event_parser)

        # Known Responses API event prefixes. Payload shape detection below keeps
        # Wework pass-through from depending on a closed event-name list.
        self._responses_api_prefixes = ("response.", "error", "image_generation.")

        # Per-subtask locks to ensure events are processed in order
        # This prevents race conditions when multiple response.output_text.delta
        # events arrive concurrently for the same subtask
        self._subtask_locks: Dict[int, asyncio.Lock] = {}
        self._runtime_event_locks: Dict[str, asyncio.Lock] = {}
        self._runtime_auth_sync_inflight: set[tuple[int, str, str]] = set()
        self._connection_attempts: Dict[str, list[float]] = {}
        self._recent_registrations: Dict[
            tuple[int, str],
            tuple[float, DeviceRegistrationFingerprint, str],
        ] = {}
        self._background_tasks: set[asyncio.Task] = set()

    def _is_connection_rate_limited(
        self, key: str, now: Optional[float] = None
    ) -> bool:
        """Return True when the connection attempt key exceeds the local window."""
        current = time.monotonic() if now is None else now
        cutoff = current - DEVICE_CONNECT_RATE_LIMIT_WINDOW_SECONDS
        attempts = [
            attempt
            for attempt in self._connection_attempts.get(key, [])
            if attempt > cutoff
        ]
        if len(attempts) >= DEVICE_CONNECT_RATE_LIMIT_MAX_ATTEMPTS:
            self._connection_attempts[key] = attempts
            return True

        attempts.append(current)
        self._connection_attempts[key] = attempts
        return False

    def _get_recent_registration_display_name(
        self,
        user_id: int,
        device_id: str,
        fingerprint: DeviceRegistrationFingerprint,
    ) -> Optional[str]:
        """Return cached display name for an exact recent registration."""
        key = (user_id, device_id)
        cached = self._recent_registrations.get(key)
        if not cached:
            return None

        registered_at, cached_fingerprint, display_name = cached
        if time.monotonic() - registered_at > DEVICE_REGISTER_UPSERT_DEBOUNCE_SECONDS:
            self._recent_registrations.pop(key, None)
            return None
        if cached_fingerprint != fingerprint:
            return None
        return display_name

    def _remember_registration(
        self,
        user_id: int,
        device_id: str,
        fingerprint: DeviceRegistrationFingerprint,
        display_name: str,
    ) -> None:
        """Record a successful registration to absorb exact reconnect storms."""
        self._recent_registrations[(user_id, device_id)] = (
            time.monotonic(),
            fingerprint,
            display_name,
        )

    def _schedule_background_task(self, coro, description: str) -> None:
        """Run best-effort follow-up work without blocking device registration."""
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)

        def _on_done(done_task: asyncio.Task) -> None:
            self._background_tasks.discard(done_task)
            try:
                done_task.result()
            except asyncio.CancelledError:
                logger.debug("[Device WS] Background task cancelled: %s", description)
            except Exception:
                logger.exception("[Device WS] Background task failed: %s", description)

        task.add_done_callback(_on_done)

    def _get_subtask_lock(self, subtask_id: int) -> asyncio.Lock:
        """Get or create a lock for the given subtask.

        Args:
            subtask_id: Subtask ID

        Returns:
            asyncio.Lock for the subtask
        """
        if subtask_id not in self._subtask_locks:
            self._subtask_locks[subtask_id] = asyncio.Lock()
        return self._subtask_locks[subtask_id]

    def _cleanup_subtask_lock(self, subtask_id: int) -> None:
        """Clean up the lock for a completed subtask.

        Args:
            subtask_id: Subtask ID
        """
        self._subtask_locks.pop(subtask_id, None)

    def _get_runtime_event_lock(self, sid: str) -> asyncio.Lock:
        """Return the ordered runtime-event relay lock for one device socket."""
        if sid not in self._runtime_event_locks:
            self._runtime_event_locks[sid] = asyncio.Lock()
        return self._runtime_event_locks[sid]

    @trace_websocket_event(
        exclude_events={"connect"},
        extract_event_data=True,
    )
    async def trigger_event(self, event: str, sid: str, *args):
        """
        Override trigger_event to handle colon-separated event names.

        Args:
            event: Event name (e.g., 'device:register')
            sid: Socket ID
            *args: Event arguments

        Returns:
            Result from the event handler
        """
        return await self._execute_handler(event, sid, *args)

    async def _execute_handler(self, event: str, sid: str, *args):
        """Execute the event handler for the given event."""
        if event in self._event_handlers:
            handler_name = self._event_handlers[event]
            handler = getattr(self, handler_name, None)
            if handler:
                logger.debug(
                    f"[Device WS] Routing event '{event}' to handler '{handler_name}'"
                )
                return await handler(sid, *args)

        # Handle OpenAI Responses API events (e.g., response.output_text.delta)
        if self._is_responses_api_event(event, args):
            return await self._handle_responses_api_event(sid, event, *args)

        return await super().trigger_event(event, sid, *args)

    def _is_responses_api_event(self, event: str, args: tuple[Any, ...]) -> bool:
        if event.startswith(self._responses_api_prefixes):
            return True
        if not args or not isinstance(args[0], dict):
            return False

        data = args[0]
        if not isinstance(data.get("data"), dict):
            return False
        return any(key in data for key in ("task_id", "subtask_id", "local_task_id"))

    def _get_client_ip(self, environ: dict) -> Optional[str]:
        """Extract the TCP peer IP from WSGI environ."""
        return environ.get("REMOTE_ADDR")

    def _get_client_ip_log_context(self, environ: dict) -> tuple[Optional[str], str]:
        """Build log context for WebSocket client IP attribution."""
        client_ip = self._get_client_ip(environ)
        return client_ip, (
            f"client_ip={client_ip} "
            f"remote_addr={environ.get('REMOTE_ADDR')} "
            f"x_forwarded_for={environ.get('HTTP_X_FORWARDED_FOR')} "
            f"x_real_ip={environ.get('HTTP_X_REAL_IP')}"
        )

    async def _match_cloud_device(
        self,
        user_id: int,
        client_ip: str,
        executor_device_id: str,
        runtime_instance_id: Optional[str] = None,
    ) -> Optional[str]:
        """Match cloud device by verifying server-generated device_id.

        When a cloud device executor connects, it should use the server-generated
        device_id (passed via DEVICE_ID environment variable). This method verifies
        that the executor's device_id matches the one stored in cloudConfig.deviceId.

        For backward compatibility: if cloudConfig.deviceId is not set (old device),
        falls back to the legacy matching logic.

        Args:
            user_id: User ID
            client_ip: WebSocket client IP address (kept for logging)
            executor_device_id: Device ID from executor (should match server-generated)

        Returns:
            Canonical Device CRD name if matched, None otherwise
        """
        try:
            # Run database query in executor to avoid blocking event loop
            result = await run_sync_in_executor(
                _match_cloud_device_sync,
                user_id,
                client_ip,
                executor_device_id,
                runtime_instance_id,
            )

            if result is None:
                return None

            logical_device_id, needs_migration, device_data = result

            # If legacy device needs migration, do it in executor
            if needs_migration and device_data:
                logical_device_id = await run_sync_in_executor(
                    _update_cloud_device_id_sync,
                    user_id,
                    device_data["device_id"],
                    executor_device_id,
                    device_data["sandbox_id"],
                    runtime_instance_id,
                )

            return logical_device_id

        except RuntimeInstanceMismatchError:
            raise
        except Exception as e:
            logger.error(f"[Device WS] Error matching cloud device: {e}")

        return None

    async def on_connect(self, sid: str, environ: dict, auth: Optional[dict] = None):
        """
        Handle device connection.

        Verifies JWT token or API Key and prepares for device registration.

        Authentication:
        - If token starts with 'wg-', treated as API Key (personal keys only)
        - Otherwise, treated as JWT Token

        Args:
            sid: Socket ID
            environ: WSGI environ dict
            auth: Authentication data (expected: {"token": "..."})
                  Token can be either JWT Token or API Key (starting with 'wg-')

        Raises:
            ConnectionRefusedError: If authentication fails
        """
        from app.core.shutdown import shutdown_manager

        request_id = str(uuid.uuid4())[:8]
        set_request_context(request_id)
        client_ip, ip_log_context = self._get_client_ip_log_context(environ)

        logger.info(f"[Device WS] Connection attempt sid={sid} {ip_log_context}")

        # Reject new connections during graceful shutdown
        if shutdown_manager.is_shutting_down:
            logger.warning(
                f"[Device WS] Rejecting connection during shutdown sid={sid}"
            )
            raise ConnectionRefusedError("Server is shutting down")

        rate_limit_key = f"ip:{client_ip or 'unknown'}"
        if self._is_connection_rate_limited(rate_limit_key):
            logger.warning(
                f"[Device WS] Rate limited connection sid={sid}, key={rate_limit_key}"
            )
            raise ConnectionRefusedError("Too many device connection attempts")

        # Check auth token
        if not auth or not isinstance(auth, dict):
            logger.warning(f"[Device WS] Missing auth data sid={sid}")
            DEVICE_WS_AUTH_FAILURES_TOTAL.labels(reason="missing_token").inc()
            raise ConnectionRefusedError("Missing authentication token")

        token = auth.get("token")
        if not token:
            logger.warning(f"[Device WS] Missing token in auth sid={sid}")
            DEVICE_WS_AUTH_FAILURES_TOTAL.labels(reason="missing_token").inc()
            raise ConnectionRefusedError("Missing authentication token")

        # Determine auth type and verify token
        user = None
        auth_type = ""
        token_exp = None

        if is_api_key(token):
            # API Key authentication - run in executor to avoid blocking event loop
            auth_type = "api_key"
            try:
                user_info = await run_sync_in_executor(_verify_api_key_sync, token)
            except SQLAlchemyError as exc:
                logger.error(
                    f"[Device WS] API key authentication storage unavailable sid={sid}: "
                    f"{exc.__class__.__name__}"
                )
                raise ConnectionRefusedError(
                    "Authentication service unavailable"
                ) from exc
            if not user_info:
                key_preview = token[:10] + "..." if len(token) > 10 else token
                logger.warning(
                    f"[Device WS] Invalid API key sid={sid}, key={key_preview}"
                )
                DEVICE_WS_AUTH_FAILURES_TOTAL.labels(reason="invalid_api_key").inc()
                raise ConnectionRefusedError("Invalid or expired API key")
            user_id, user_name = user_info
            # API Key has no expiry (token_exp stays None)
            token_exp = None
        else:
            # JWT Token authentication
            auth_type = "jwt"
            user = verify_jwt_token(token)
            if not user:
                logger.warning(f"[Device WS] Invalid JWT token sid={sid}")
                DEVICE_WS_AUTH_FAILURES_TOTAL.labels(reason="invalid_jwt").inc()
                raise ConnectionRefusedError("Invalid or expired token")
            user_id = user.id
            user_name = user.user_name
            # Extract token expiry for JWT
            token_exp = get_token_expiry(token)

        await save_connect_session(
            self,
            sid,
            session_data={
                "user_id": user_id,
                "user_name": user_name,
                "request_id": request_id,
                "token_exp": token_exp,
                "auth_token": token,
                "auth_type": auth_type,
                "device_id": None,
                "registered": False,
                "client_ip": client_ip,
            },
            logger=logger,
            log_prefix="[Device WS]",
        )

        set_user_context(user_id=str(user_id), user_name=user_name)

        # Join user room for device-related notifications
        user_room = f"user:{user_id}"
        await enter_connect_room(
            self,
            sid,
            user_room,
            logger=logger,
            log_prefix="[Device WS]",
        )

        logger.info(
            f"[Device WS] Connected user={user_id} ({user_name}) via {auth_type} "
            f"sid={sid} {ip_log_context}, awaiting registration"
        )

    async def on_disconnect(self, sid: str):
        """
        Handle device disconnection.

        Cleans up Redis online status, updates MySQL, and marks running tasks as failed.

        Args:
            sid: Socket ID
        """
        try:
            session = await self.get_session(sid)
            user_id = session.get("user_id")
            device_id = session.get("device_id")
            request_id = session.get("request_id")

            if request_id:
                set_request_context(request_id)
            if user_id:
                set_user_context(user_id=str(user_id))

            logger.info(
                f"[Device WS] Disconnected user={user_id}, device={device_id}, sid={sid}"
            )

            if user_id and device_id:
                online_info = await device_service.get_device_online_info(
                    user_id, device_id
                )
                online_socket_id = online_info.get("socket_id") if online_info else None
                if online_socket_id and online_socket_id != sid:
                    logger.info(
                        "[Device WS] Ignoring stale disconnect: user=%s, device=%s, "
                        "sid=%s, current_sid=%s",
                        user_id,
                        device_id,
                        sid,
                        online_socket_id,
                    )
                    return

                await asyncio.sleep(DEVICE_DISCONNECT_FAILURE_GRACE_SECONDS)
                online_info = await device_service.get_device_online_info(
                    user_id, device_id
                )
                online_socket_id = online_info.get("socket_id") if online_info else None
                if online_socket_id and online_socket_id != sid:
                    logger.info(
                        "[Device WS] Ignoring transient disconnect after reconnect: "
                        "user=%s, device=%s, sid=%s, current_sid=%s",
                        user_id,
                        device_id,
                        sid,
                        online_socket_id,
                    )
                    return

                # Remove from Redis online status
                await device_service.set_device_offline(user_id, device_id)

                # Database operation: run in executor to avoid blocking event loop
                # Returns list of failed subtasks for WebSocket emission
                failed_subtasks = await run_sync_in_executor(
                    _handle_device_disconnect, user_id, device_id
                )

                # WebSocket emissions happen AFTER database connection is released
                extended_emitter = get_extended_emitter()
                # Track unique task IDs to emit task:status only once per task
                emitted_task_ids = set()
                for info in failed_subtasks:
                    await extended_emitter.emit_chat_error(
                        task_id=info.task_id,
                        subtask_id=info.subtask_id,
                        error="Device disconnected",
                        message_id=info.message_id,
                    )

                # Broadcast device offline event
                await self._broadcast_device_offline(user_id, device_id)

        except Exception as e:
            logger.error(f"[Device WS] Error in disconnect handler: {e}")
        finally:
            self._runtime_event_locks.pop(sid, None)

    # ============================================================
    # Device Registration and Heartbeat Events
    # ============================================================

    async def on_device_register(self, sid: str, data: dict) -> dict:
        """
        Handle device:register event.

        Registers the device in MySQL and sets online status in Redis.

        Args:
            sid: Socket ID
            data: {"device_id": str, "name": str}

        Returns:
            {"success": True, "device_id": str} or {"error": str}
        """
        try:
            payload = DeviceRegisterPayload(**data)
        except Exception as e:
            logger.warning(f"[Device WS] Invalid register payload: {e}")
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")

        if not user_id:
            return {"error": "Not authenticated"}

        runtime_transfer_host = _normalize_runtime_transfer_host(
            payload.runtime_transfer_host or payload.client_ip
        )
        logger.info(
            f"[Device WS] device:register user={user_id}, device_id={payload.device_id}, "
            f"name={payload.name}, executor_version={payload.executor_version}, "
            f"tcp_client_ip={session.get('client_ip')}, "
            f"reported_client_ip={payload.client_ip}, "
            f"runtime_transfer_host={runtime_transfer_host}"
        )

        # Check if this is a cloud device registration (by IP matching)
        # Use the WebSocket TCP peer observed by backend. The executor-reported
        # address is advisory and must not drive transfer routing.
        client_ip = session.get("client_ip")
        registration_fingerprint = DeviceRegistrationFingerprint(
            display_name=payload.name.strip(),
            client_ip=str(client_ip or "").strip(),
            device_type=payload.device_type.value,
            bind_shell=payload.bind_shell.value,
            runtime_transfer_host=str(runtime_transfer_host or "").strip(),
            runtime_instance_id=str(payload.runtime_instance_id or "").strip(),
            app_device_id=str(payload.app_device_id or "").strip(),
        )
        is_cloud_device = False
        logical_device_id: Optional[str] = None
        if payload.device_type == DeviceType.CLOUD:
            try:
                logical_device_id = await self._match_cloud_device(
                    user_id,
                    client_ip or "",
                    payload.device_id,
                    payload.runtime_instance_id,
                )
            except RuntimeInstanceMismatchError as exc:
                logger.warning(
                    "[Device WS] Rejected cloud Runtime instance mismatch: "
                    "user=%s, device=%s",
                    user_id,
                    payload.device_id,
                )
                return {"error": f"Registration failed: {exc}"}
            if logical_device_id:
                is_cloud_device = True
                logger.info(
                    f"[Device WS] Matched cloud device: executor_device_id={payload.device_id}, "
                    f"logical_device_id={logical_device_id}"
                )

        # Database operation: skip if cloud device already updated in IP matching
        # Pass client_ip to _register_device for tracking
        # Run in executor to avoid blocking event loop
        if not is_cloud_device:
            persisted_display_name = self._get_recent_registration_display_name(
                user_id,
                payload.device_id,
                registration_fingerprint,
            )
            if persisted_display_name is None:
                success, persisted_display_name, error = await run_sync_in_executor(
                    _register_device,
                    user_id,
                    payload.device_id,
                    payload.name,
                    client_ip,
                    payload.device_type.value,
                    payload.bind_shell.value,
                    runtime_transfer_host,
                    payload.runtime_instance_id,
                    payload.app_device_id,
                )
                if not success:
                    return {"error": f"Registration failed: {error}"}
                self._remember_registration(
                    user_id,
                    payload.device_id,
                    registration_fingerprint,
                    persisted_display_name or payload.name,
                )
        else:
            persisted_display_name = payload.name

        effective_device_name = persisted_display_name or payload.name

        # Update the Socket.IO session before marking the device online. If the
        # connection disappeared, the online socket would be stale immediately.
        session["device_id"] = payload.device_id
        session["logical_device_id"] = logical_device_id or payload.device_id
        session["device_name"] = effective_device_name
        session["runtime_transfer_host"] = runtime_transfer_host
        session["runtime_instance_id"] = payload.runtime_instance_id
        session["device_type"] = payload.device_type.value
        session["execution_target_id"] = payload.app_device_id or payload.device_id
        session["execution_environment"] = "local" if payload.app_device_id else "cloud"
        session["registered"] = True

        device_room = f"device:{user_id}:{payload.device_id}"
        execution_target_room = (
            f"execution-target:{user_id}:{session['execution_target_id']}"
        )
        try:
            await self.save_session(sid, session)
            await self.enter_room(sid, device_room)
            await self.enter_room(sid, execution_target_room)
        except (KeyError, ValueError) as exc:
            logger.info(
                "[Device WS] Connection disappeared before device registration "
                "completed; user=%s, device=%s, sid=%s, error=%s",
                user_id,
                payload.device_id,
                sid,
                exc,
            )
            return {"error": "Client disconnected during device registration"}

        # Redis online state is written only after Socket.IO session and room
        # setup have succeeded.
        await device_service.set_device_online(
            user_id=user_id,
            device_id=payload.device_id,
            socket_id=sid,
            name=effective_device_name,
            executor_version=payload.executor_version,
            client_ip=client_ip,
            runtime_transfer_host=runtime_transfer_host,
            runtime_instance_id=payload.runtime_instance_id,
            runtime_features=(
                payload.runtime_features.model_dump(
                    by_alias=True,
                    exclude_none=True,
                )
                if payload.runtime_features is not None
                else None
            ),
        )

        # Broadcast device online event to user room (via chat namespace)
        await self._broadcast_device_online(
            user_id, payload.device_id, effective_device_name
        )
        self._schedule_background_task(
            self._sync_global_capabilities_to_registered_device(
                user_id=user_id,
                device_id=payload.device_id,
            ),
            "sync global capabilities after device registration",
        )
        if remote_control_is_enabled(payload.device_type):
            from app.tasks.robot_queue_tasks import reconcile_device_executions

            self._schedule_background_task(
                reconcile_device_executions(
                    user_id=int(user_id),
                    device_id=payload.device_id,
                ),
                "reconcile active executions after device registration",
            )

        logger.info(
            f"[Device WS] Device registered: user={user_id}, device={payload.device_id}"
        )

        return {"success": True, "device_id": payload.device_id}

    async def _sync_global_capabilities_to_registered_device(
        self,
        *,
        user_id: int,
        device_id: str,
    ) -> None:
        """Best-effort desired-state sync when a device comes online."""
        try:
            with _db_session() as db:
                plugin_marketplace_service.reconcile_stale_installed_catalog_refs(
                    db, user_id=user_id
                )
                plugin_device_installation_service.ensure_pending_for_device(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                )
                payload = device_capability_sync_service.build_desired_capabilities(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                )
            result = await device_capability_sync_service.sync_device_payload(
                user_id=user_id,
                device_id=device_id,
                payload=payload,
                timeout_seconds=REGISTER_CAPABILITY_SYNC_TIMEOUT_SECONDS,
            )
            with _db_session() as db:
                plugin_device_installation_service.record_device_sync_result(
                    db,
                    user_id=user_id,
                    result=result,
                )
            if not result.success:
                logger.warning(
                    "[Device WS] Capability sync after register failed: user=%s, device=%s, error=%s",
                    user_id,
                    device_id,
                    result.error,
                )
        except Exception:
            logger.exception(
                "[Device WS] Error syncing global capabilities after registration"
            )

    def _schedule_runtime_auth_sync_after_heartbeat(
        self,
        *,
        user_id: int,
        device_id: str,
        runtime_auth_files: Any,
    ) -> None:
        """Schedule best-effort runtime auth sync when heartbeat reports a missing file."""
        if not _runtime_auth_file_missing(runtime_auth_files, CODEX_RUNTIME):
            return

        key = (user_id, device_id, CODEX_RUNTIME)
        if key in self._runtime_auth_sync_inflight:
            return
        self._runtime_auth_sync_inflight.add(key)
        asyncio.create_task(
            self._sync_runtime_auth_for_heartbeat_device(
                user_id=user_id,
                device_id=device_id,
                runtime=CODEX_RUNTIME,
                key=key,
            )
        )

    async def _sync_runtime_auth_for_heartbeat_device(
        self,
        *,
        user_id: int,
        device_id: str,
        runtime: str,
        key: tuple[int, str, str],
    ) -> None:
        """Best-effort sync of enabled user runtime auth to one heartbeat device."""
        try:
            with _db_session() as db:
                user = db.query(User).filter(User.id == user_id).first()
                if not user:
                    logger.warning(
                        "[Device WS] Runtime auth sync skipped: user not found: user=%s",
                        user_id,
                    )
                    return
                status = user_runtime_config_service.get_config(
                    db,
                    user_id=user_id,
                    runtime=runtime,
                    preferences=user.preferences,
                )
                if not status.get("use_user_config") or not status.get("configured"):
                    return
                result = await user_runtime_config_service.sync_auth_to_devices(
                    db,
                    user_id=user_id,
                    runtime=runtime,
                    preferences=user.preferences,
                    device_ids=[device_id],
                )
            items = result.get("items") if isinstance(result, dict) else None
            target_item = next(
                (
                    item
                    for item in (items or [])
                    if isinstance(item, dict) and item.get("device_id") == device_id
                ),
                None,
            )
            if not target_item or not target_item.get("success"):
                logger.warning(
                    "[Device WS] Runtime auth heartbeat sync did not complete: "
                    "user=%s device=%s runtime=%s result=%s",
                    user_id,
                    device_id,
                    runtime,
                    target_item,
                )
        except (UserRuntimeConfigError, UserRuntimeConfigSyncError):
            logger.exception(
                "[Device WS] Runtime auth heartbeat sync failed: user=%s device=%s runtime=%s",
                user_id,
                device_id,
                runtime,
            )
        except Exception:
            logger.exception(
                "[Device WS] Runtime auth heartbeat sync errored: user=%s device=%s runtime=%s",
                user_id,
                device_id,
                runtime,
            )
        finally:
            self._runtime_auth_sync_inflight.discard(key)

    async def on_device_heartbeat(self, sid: str, data: dict) -> dict:
        """
        Handle device:heartbeat event.

        Refreshes the device's online status in Redis and updates MySQL.

        Args:
            sid: Socket ID
            data: {"device_id": str}

        Returns:
            {"success": True} or {"error": str}
        """
        try:
            payload = DeviceHeartbeatPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        session_device_id = session.get("device_id")

        if not user_id:
            return {"error": "Not authenticated"}

        if session_device_id != payload.device_id:
            return {"error": "Device ID mismatch"}

        online_info = await device_service.get_device_online_info(
            user_id, payload.device_id
        )
        online_socket_id = online_info.get("socket_id") if online_info else None
        if online_socket_id and online_socket_id != sid:
            logger.info(
                "[Device WS] Ignoring stale heartbeat: user=%s, device=%s, "
                "sid=%s, current_sid=%s",
                user_id,
                payload.device_id,
                sid,
                online_socket_id,
            )
            return {"error": "Stale device connection"}

        registered_runtime_instance_id = session.get("runtime_instance_id")
        if (
            registered_runtime_instance_id
            and payload.runtime_instance_id != registered_runtime_instance_id
        ):
            return {"error": "Runtime instance ID mismatch"}

        runtime_transfer_host = _normalize_runtime_transfer_host(
            payload.runtime_transfer_host
        ) or session.get("runtime_transfer_host")
        session["runtime_transfer_host"] = runtime_transfer_host
        await self.save_session(sid, session)

        # Refresh Redis TTL and update running_task_ids
        success = await device_service.refresh_device_heartbeat(
            user_id,
            payload.device_id,
            payload.running_task_ids,
            payload.executor_version,
            runtime_transfer_host=runtime_transfer_host,
            runtime_instance_id=payload.runtime_instance_id,
            runtime_capacity=(
                payload.runtime_capacity.model_dump()
                if payload.runtime_capacity is not None
                else None
            ),
            runtime_features=(
                payload.runtime_features.model_dump(
                    by_alias=True,
                    exclude_none=True,
                )
                if payload.runtime_features is not None
                else None
            ),
        )

        if not success:
            # Redis key expired, recreate it to recover from ghost-offline state
            device_name = session.get("device_name", f"device-{payload.device_id[:8]}")
            logger.warning(
                f"[Device WS] Heartbeat recovery: recreating Redis key for "
                f"user={user_id}, device={payload.device_id}"
            )
            await device_service.set_device_online(
                user_id=user_id,
                device_id=payload.device_id,
                socket_id=sid,
                name=device_name,
                executor_version=payload.executor_version,
                client_ip=session.get("client_ip"),
                runtime_transfer_host=runtime_transfer_host,
                runtime_instance_id=payload.runtime_instance_id,
                runtime_features=(
                    payload.runtime_features.model_dump(
                        by_alias=True,
                        exclude_none=True,
                    )
                    if payload.runtime_features is not None
                    else None
                ),
            )
            await device_service.refresh_device_heartbeat(
                user_id,
                payload.device_id,
                payload.running_task_ids,
                payload.executor_version,
                runtime_transfer_host=runtime_transfer_host,
                runtime_instance_id=payload.runtime_instance_id,
                runtime_capacity=(
                    payload.runtime_capacity.model_dump()
                    if payload.runtime_capacity is not None
                    else None
                ),
                runtime_features=(
                    payload.runtime_features.model_dump(
                        by_alias=True,
                        exclude_none=True,
                    )
                    if payload.runtime_features is not None
                    else None
                ),
            )
            # Re-broadcast device online event
            await self._broadcast_device_online(user_id, payload.device_id, device_name)

        if payload.capabilities:
            try:
                await _store_device_capabilities_state(
                    user_id, payload.device_id, payload.capabilities
                )
            except Exception as e:
                logger.warning(
                    "[Device WS] Ignored invalid capability heartbeat state: %s", e
                )

        self._schedule_runtime_auth_sync_after_heartbeat(
            user_id=user_id,
            device_id=payload.device_id,
            runtime_auth_files=payload.runtime_auth_files,
        )

        # Database operation: quick in, quick out
        _update_device_heartbeat(user_id, payload.device_id)

        # Broadcast slot update to user
        await self._broadcast_device_slot_update(user_id, payload.device_id)

        logger.debug(
            f"[Device WS] Heartbeat received: user={user_id}, device={payload.device_id}, "
            f"running_tasks={len(payload.running_task_ids)}"
        )
        try:
            device_type = DeviceType(session.get("device_type"))
        except (TypeError, ValueError):
            device_type = None
        if remote_control_is_enabled(device_type):
            from app.tasks.robot_queue_tasks import reconcile_device_executions

            self._schedule_background_task(
                reconcile_device_executions(
                    user_id=int(user_id),
                    device_id=payload.device_id,
                    needs_confirmation_only=True,
                ),
                "reconcile unconfirmed executions after device heartbeat",
            )

        return {"success": True}

    async def on_runtime_tasks_pull(self, sid: str, data: dict) -> dict:
        """Return one atomically claimed execution to this Executor."""

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        runtime_device_id = session.get("device_id")
        execution_target_id = session.get("execution_target_id")
        environment = session.get("execution_environment")
        runtime_instance_id = session.get("runtime_instance_id")
        try:
            device_type = DeviceType(session.get("device_type"))
        except (TypeError, ValueError):
            device_type = None
        if (
            not user_id
            or not runtime_device_id
            or not execution_target_id
            or environment not in {"local", "cloud"}
            or not runtime_instance_id
        ):
            return {"success": False, "error": "Device is not registered"}
        if not remote_control_is_enabled(device_type):
            return {"success": True, "task": None}
        runtime_capacity = (
            data.get("runtime_capacity")
            if isinstance(data, dict) and isinstance(data.get("runtime_capacity"), dict)
            else None
        )
        return await run_sync_in_executor(
            partial(
                pull_execution,
                owner_user_id=int(user_id),
                execution_target_id=str(execution_target_id),
                runtime_device_id=str(runtime_device_id),
                runtime_instance_id=str(runtime_instance_id),
                environment=str(environment),
                runtime_capacity=runtime_capacity,
            )
        )

    async def on_runtime_tasks_accept(self, sid: str, data: dict) -> dict:
        """Record whether Runtime accepted a task returned by pull."""

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        runtime_device_id = session.get("device_id")
        runtime_instance_id = session.get("runtime_instance_id")
        if not user_id or not runtime_device_id or not runtime_instance_id:
            return {"success": False, "error": "Device is not registered"}
        if not isinstance(data, dict):
            return {"success": False, "error": "Invalid acceptance payload"}
        try:
            execution_id = int(data.get("execution_id"))
        except (TypeError, ValueError):
            return {"success": False, "error": "execution_id is required"}
        runtime_task_id = data.get("runtime_task_id")
        if not isinstance(runtime_task_id, str) or not runtime_task_id:
            return {"success": False, "error": "runtime_task_id is required"}
        return await run_sync_in_executor(
            partial(
                acknowledge_execution,
                owner_user_id=int(user_id),
                runtime_device_id=str(runtime_device_id),
                runtime_instance_id=str(runtime_instance_id),
                execution_id=execution_id,
                runtime_task_id=runtime_task_id,
                accepted=bool(data.get("accepted")),
                prompt=(
                    data.get("prompt") if isinstance(data.get("prompt"), str) else None
                ),
                error=data.get("error") if isinstance(data.get("error"), str) else None,
            )
        )

    async def on_device_status(self, sid: str, data: dict) -> dict:
        """
        Handle device:status event.

        Updates the device status (online/busy) in Redis.

        Args:
            sid: Socket ID
            data: {"device_id": str, "status": str}

        Returns:
            {"success": True} or {"error": str}
        """
        try:
            payload = DeviceStatusPayload(**data)
        except Exception as e:
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        session_device_id = session.get("device_id")

        if not user_id:
            return {"error": "Not authenticated"}

        if session_device_id != payload.device_id:
            return {"error": "Device ID mismatch"}

        # Update status in Redis
        await device_service.update_device_status_in_redis(
            user_id, payload.device_id, payload.status.value
        )

        # Broadcast status change to user room
        await self._broadcast_device_status(
            user_id, payload.device_id, payload.status.value
        )

        logger.info(
            f"[Device WS] Status updated: user={user_id}, device={payload.device_id}, status={payload.status}"
        )

        return {"success": True}

    async def on_device_upgrade_status(self, sid: str, data: dict) -> dict:
        """
        Handle device:upgrade_status event from executor.

        Receives upgrade status updates from the executor and broadcasts
        them to the user's room via the chat namespace.

        Args:
            sid: Socket ID
            data: Upgrade status data containing device_id, status, message, etc.

        Returns:
            {"success": True} or {"error": str}
        """
        try:
            from app.schemas.device import DeviceUpgradeStatusEvent

            payload = DeviceUpgradeStatusEvent(**data)
        except Exception as e:
            logger.warning(f"[Device WS] Invalid upgrade_status payload: {e}")
            return {"error": f"Invalid payload: {e}"}

        session = await self.get_session(sid)
        user_id = session.get("user_id")
        session_device_id = session.get("device_id")

        if not user_id:
            return {"error": "Not authenticated"}

        if session_device_id != payload.device_id:
            return {"error": "Device ID mismatch"}

        logger.info(
            f"[Device WS] Upgrade status: user={user_id}, device={payload.device_id}, "
            f"status={payload.status}, message={payload.message}"
        )

        # Broadcast to user room via chat namespace
        await self._broadcast_device_upgrade_status(user_id, payload)

        # If terminal state (success/error/skipped), update device metadata
        if payload.status in ["success", "error", "skipped"]:
            logger.info(
                f"[Device WS] Upgrade terminal state reached: "
                f"status={payload.status}, device={payload.device_id}"
            )

        return {"success": True}

    async def on_terminal_output(self, sid: str, data: dict) -> dict:
        """Forward executor PTY output to the browser terminal namespace."""
        record, error = await self._authorize_terminal_event(sid, data)
        if error:
            return error

        payload = dict(data)
        payload["session_id"] = record.session_id
        await get_sio().emit(
            "terminal:output",
            payload,
            room=f"terminal:{record.session_id}",
            namespace="/terminal",
        )
        return {"success": True}

    async def on_terminal_exit(self, sid: str, data: dict) -> dict:
        """Forward executor PTY exit and remove the terminal session record."""
        record, error = await self._authorize_terminal_event(sid, data)
        if error:
            return error

        payload = dict(data)
        payload["session_id"] = record.session_id
        try:
            await get_sio().emit(
                "terminal:exit",
                payload,
                room=f"terminal:{record.session_id}",
                namespace="/terminal",
            )
        finally:
            await terminal_session_service.delete(record.session_id)
        return {"success": True}

    async def _authorize_terminal_event(
        self,
        sid: str,
        data: dict,
    ) -> tuple[Optional[TerminalSessionRecord], Optional[dict]]:
        """Verify that a terminal event came from the registered executor socket."""
        session = await self.get_session(sid)
        user_id = session.get("user_id")
        device_id = session.get("device_id")
        if not user_id or not device_id:
            return None, {"error": "Not authenticated or not registered"}

        session_id = data.get("session_id") if isinstance(data, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            return None, {"error": "Missing session_id"}

        record = await terminal_session_service.get(session_id.strip())
        if not record:
            return None, {"error": "Terminal session not found"}
        if (
            record.user_id != user_id
            or record.device_id != device_id
            or record.socket_id != sid
        ):
            return None, {"error": "Terminal session does not belong to this device"}
        return record, None

    # ============================================================
    # OpenAI Responses API Event Handler
    # ============================================================

    async def _handle_responses_api_event(
        self, sid: str, event_type: str, *args
    ) -> dict:
        """Handle OpenAI Responses API events from local executor.

        Reuses the same processing chain as /api/internal/callback:
        ResponsesAPIEventParser -> StatusUpdatingEmitter -> WebSocketResultEmitter

        IMPORTANT: Uses per-subtask locking to ensure events are processed in order.
        This prevents race conditions when multiple response.output_text.delta events
        arrive concurrently for the same subtask, which would cause text content to
        be appended to Redis in the wrong order.

        Args:
            sid: Socket ID
            event_type: OpenAI Responses API event type (e.g., response.output_text.delta)
            *args: Event arguments (first arg is the event data dict)

        Returns:
            {"success": True} or {"error": str}
        """
        session = await self.get_session(sid)
        user_id = session.get("user_id")
        device_id = session.get("device_id")

        if not user_id or not device_id:
            return {"error": "Not authenticated or not registered"}

        if not args:
            return {"error": "Missing event data"}

        # Project robot queue write-back: match the execution by runtime task
        # id. Streaming events extend the lease; terminal events complete or
        # fail the run.
        event_data = args[0]
        if isinstance(event_data, dict) and event_data.get("task_id"):
            workflow_continuation = await run_sync_in_executor(
                _execution_runtime_event_sync,
                device_id,
                event_data.get("task_id"),
                event_type,
                event_data,
            )
            await _continue_projected_workflow(workflow_continuation)

        data = args[0]
        if not isinstance(data, dict):
            return {"error": "Invalid event data format"}
        data = dict(data)

        task_id = data.get("task_id")
        subtask_id = data.get("subtask_id")
        event_data = data.get("data", {})
        message_id = data.get("message_id")
        local_task_id = data.get("local_task_id")

        if isinstance(local_task_id, str) and local_task_id.strip():
            return await self._handle_local_task_responses_api_event(
                user_id=user_id,
                device_id=device_id,
                event_type=event_type,
                data=data,
                event_data=event_data if isinstance(event_data, dict) else {},
                message_id=message_id,
            )

        if not task_id or not subtask_id:
            return {"error": "Missing task_id or subtask_id"}

        logger.debug(
            f"[Device WS] Responses API event: type={event_type}, "
            f"task_id={task_id}, subtask_id={subtask_id}"
        )

        # Get lock for this subtask to ensure events are processed in order
        # This prevents race conditions when multiple events arrive concurrently
        lock = self._get_subtask_lock(subtask_id)

        # Track whether this is a terminal event for lock cleanup
        is_terminal = False

        try:
            # Acquire lock to ensure sequential processing of events for this subtask
            async with lock:
                # Parse using shared ResponsesAPIEventParser
                await emit_response_api_event(
                    event_name=event_type,
                    payload=response_api_payload(data=data, device_id=device_id),
                    room=get_wework_task_room(task_id),
                )
                event = self._event_parser.parse(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    message_id=message_id,
                    event_type=event_type,
                    data=event_data,
                )

                if event is None:
                    # Lifecycle events (response.created, etc.) are skipped
                    return {"success": True}

                # Emit via StatusUpdatingEmitter -> WebSocketResultEmitter
                # Pass user_id for task:status notification
                ws_emitter = WebSocketResultEmitter(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    user_id=user_id,
                )
                emitter = StatusUpdatingEmitter(
                    wrapped=ws_emitter,
                    task_id=task_id,
                    subtask_id=subtask_id,
                )
                await emitter.emit(event)
                await emitter.close()

                await forward_event_to_channel_callbacks(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    event=event,
                    source="Device WS",
                )

                # Handle terminal events
                is_terminal = event.type in (
                    EventType.DONE.value,
                    EventType.ERROR.value,
                    EventType.CANCELLED.value,
                )
                if is_terminal:
                    logger.info(
                        "[Device WS] Terminal callback received: "
                        f"event_type={event_type}, task_id={task_id}, "
                        f"subtask_id={subtask_id}, device_id={device_id}"
                    )
                    await self._publish_task_completed_event(
                        task_id,
                        subtask_id,
                        user_id,
                        device_id,
                        event,
                    )

            # Clean up lock after terminal event (outside the lock context)
            if is_terminal:
                self._cleanup_subtask_lock(subtask_id)

            return {"success": True}

        except Exception as e:
            logger.exception(
                f"[Device WS] Error handling Responses API event: "
                f"type={event_type}, subtask_id={subtask_id}, error={e}"
            )
            # Clean up lock on error to prevent memory leak
            self._cleanup_subtask_lock(subtask_id)
            return {"error": str(e)}

    async def _handle_local_task_responses_api_event(
        self,
        *,
        user_id: int,
        device_id: str,
        event_type: str,
        data: dict,
        event_data: dict,
        message_id: Optional[int],
    ) -> dict:
        """Forward local-task Responses API events through the existing chat stream."""

        return await self._local_task_responses.handle(
            user_id=user_id,
            device_id=device_id,
            event_type=event_type,
            data=data,
            event_data=event_data,
            message_id=message_id,
            get_lock=self._get_subtask_lock,
            cleanup_lock=self._cleanup_subtask_lock,
        )

    async def on_runtime_task_updated(self, sid: str, data: dict) -> dict:
        """Handle native runtime task updates detected by a local executor watcher."""

        session = await self.get_session(sid)
        if not session:
            return {"error": "Device not authenticated"}

        user_id = int(session.get("user_id"))
        device_id = str(session.get("device_id") or "")
        local_task_id = str(data.get("localTaskId") or data.get("local_task_id") or "")
        workspace_path = str(
            data.get("workspacePath") or data.get("workspace_path") or ""
        )
        if not device_id or not local_task_id:
            return {"error": "Invalid runtime task update payload"}

        address = {
            "deviceId": device_id,
            "localTaskId": local_task_id,
        }
        if workspace_path:
            address["workspacePath"] = workspace_path

        status = str(data.get("status") or "updated")
        if not _is_runtime_task_terminal_status(status):
            logger.info(
                "[RuntimeTaskNotification] Skipped non-terminal update: "
                "user_id=%s device_id=%s local_task_id=%s status=%s",
                user_id,
                device_id,
                local_task_id,
                status,
            )
            return {"success": True, "notified": 0, "skipped": "non_terminal"}
        content = str(data.get("content") or "")

        if _is_runtime_task_terminal_status(status):
            event_name = (
                "runtime.task.failed"
                if _normalize_runtime_task_status(status)
                in {"failed", "error", "cancelled", "canceled"}
                else "runtime.task.completed"
            )
            logger.info(
                "[ProjectChat] Runtime task terminal update received: "
                "device_id=%s local_task_id=%s status=%s projected_event=%s "
                "content_length=%s",
                device_id,
                local_task_id,
                status,
                event_name,
                len(content),
            )
            projected = await run_sync_in_executor(
                _project_chat_runtime_event_sync,
                device_id,
                {
                    "event": event_name,
                    "payload": {
                        "taskId": local_task_id,
                        "localTaskId": local_task_id,
                        "deviceId": device_id,
                        "device_id": device_id,
                        "status": status,
                        "data": {
                            "status": status,
                            "value": content,
                        },
                    },
                },
                user_id,
                True,
            )
            await _continue_projected_workflow(
                projected.get("workflow_continuation") if projected else None
            )
            if projected and projected.get("message"):
                message = projected["message"]
                project_id = str(message["projectId"])
                project_task_id = message.get("taskId")
                logger.info(
                    "[ProjectChat] Emitting projected runtime task terminal update: "
                    "project_id=%s task_id=%s message_id=%s message_status=%s",
                    project_id,
                    project_task_id,
                    message.get("messageId"),
                    message.get("status"),
                )
                await get_sio().emit(
                    PROJECT_CHAT_CREATED_EVENT,
                    message,
                    room=project_chat_room(
                        project_id, str(project_task_id) if project_task_id else None
                    ),
                    namespace=WEWORK_RUNTIME_NAMESPACE,
                )

        if _is_runtime_task_reply_status(status) and not content.strip():
            logger.info(
                "[RuntimeTaskNotification] Skipped empty reply update: "
                "user_id=%s device_id=%s local_task_id=%s status=%s",
                user_id,
                device_id,
                local_task_id,
                status,
            )
            return {"success": True, "notified": 0, "skipped": "empty_content"}

        notification = (
            await im_notification_dispatcher.send_runtime_task_update_for_user(
                user_id=user_id,
                address=address,
                title=str(data.get("title") or local_task_id),
                status=status,
                content=content,
                source="codex_watcher",
            )
        )
        notified = int(notification.get("sent") or 0)
        if notified <= 0:
            logger.warning(
                "[RuntimeTaskNotification] Runtime task update notification "
                "was not delivered: user_id=%s device_id=%s local_task_id=%s "
                "status=%s results=%s",
                user_id,
                device_id,
                local_task_id,
                status,
                _summarize_runtime_notification_results(notification),
            )
        logger.info(
            "[RuntimeTaskNotification] Dispatched runtime task update: "
            "user_id=%s device_id=%s local_task_id=%s status=%s sent=%s",
            user_id,
            device_id,
            local_task_id,
            status,
            notified,
        )
        return {"success": True, "notified": notified}

    async def on_runtime_event(self, sid: str, data: dict) -> dict:
        """Forward native runtime app IPC events to Wework relay subscribers."""

        session = await self.get_session(sid)
        user_id = session.get("user_id") if session else None
        device_id = str(session.get("device_id") or "") if session else ""
        logical_device_id = (
            str(session.get("logical_device_id") or device_id) if session else ""
        )
        if not user_id or not device_id:
            return {"error": "Device not authenticated"}
        if not isinstance(data, dict):
            return {"error": "Invalid runtime event payload"}

        async with self._get_runtime_event_lock(sid):
            return await self._forward_runtime_event(
                user_id=int(user_id),
                device_id=device_id,
                logical_device_id=logical_device_id,
                data=data,
            )

    async def _forward_runtime_event(
        self,
        *,
        user_id: int,
        device_id: str,
        logical_device_id: str,
        data: dict,
    ) -> dict:
        """Persist and relay one runtime event without reordering its socket stream."""

        payload = dict(data)
        nested_payload = payload.get("payload")
        if isinstance(nested_payload, dict):
            nested_payload = dict(nested_payload)
            nested_payload["deviceId"] = logical_device_id
            nested_payload["device_id"] = logical_device_id
            payload["payload"] = nested_payload
        else:
            payload["payload"] = {
                "deviceId": logical_device_id,
                "device_id": logical_device_id,
            }

        # Persist project-chat output before acknowledging the executor event.
        # The browser relay is an ephemeral projection; it must not be able to
        # prevent the durable chat record from advancing.
        projected = await run_sync_in_executor(
            _project_chat_runtime_event_sync, device_id, payload, user_id
        )
        await _continue_projected_workflow(
            projected.get("workflow_continuation") if projected else None
        )
        if projected and projected.get("message"):
            message = projected["message"]
            project_id = str(message["projectId"])
            task_id = message.get("taskId")
            event_name = (
                PROJECT_CHAT_AGENT_CHUNK_EVENT
                if projected["mode"] == "delta"
                else PROJECT_CHAT_CREATED_EVENT
            )
            await get_sio().emit(
                event_name,
                message,
                room=project_chat_room(project_id, str(task_id) if task_id else None),
                namespace=WEWORK_RUNTIME_NAMESPACE,
            )
        await get_sio().emit(
            WEWORK_RUNTIME_EVENT,
            payload,
            room=wework_runtime_user_room(user_id),
            namespace=WEWORK_RUNTIME_NAMESPACE,
        )
        await self._local_task_responses.forward_runtime_event_to_channels(
            device_id=logical_device_id,
            payload=payload["payload"],
        )
        await self._notify_runtime_event(
            user_id=user_id,
            device_id=logical_device_id,
            payload=payload["payload"],
        )
        return {"success": True}

    async def _notify_runtime_event(
        self,
        *,
        user_id: int,
        device_id: str,
        payload: dict[str, Any],
    ) -> None:
        """Best-effort IM delivery for one terminal native Runtime event."""

        source = payload.get("source")
        source_name = source.get("source") if isinstance(source, dict) else None
        if source_name == "im":
            return

        local_task_id = str(payload.get("taskId") or "").strip()
        event_type = str(payload.get("event_type") or "").strip()
        if (
            not local_task_id
            or not event_type
            or not is_runtime_terminal_event_type(event_type)
        ):
            return

        event_data = payload.get("data")
        event_data = event_data if isinstance(event_data, dict) else {}
        subtask_id = runtime_subtask_id(payload, device_id, local_task_id)
        event = runtime_terminal_event(
            event_type=event_type,
            event_data=event_data,
            subtask_id=subtask_id,
        ) or self._local_task_responses.execution_event(
            event_type=event_type,
            event_data=event_data,
            subtask_id=subtask_id,
            message_id=None,
        )
        if event is None or not is_terminal_event(event):
            return

        status = local_task_terminal_status(event)
        result = event.result if isinstance(event.result, dict) else {}
        content = str(result.get("value") or event.error or "")
        if status == "COMPLETED" and not content.strip():
            logger.info(
                "[RuntimeTaskNotification] Skipped empty Runtime reply: "
                "user_id=%s device_id=%s local_task_id=%s event_type=%s",
                user_id,
                device_id,
                local_task_id,
                event_type,
            )
            return

        title = str(
            payload.get("taskTitle")
            or payload.get("task_title")
            or event_data.get("title")
            or local_task_id
        ).strip()
        try:
            notification = (
                await im_notification_dispatcher.send_runtime_task_update_for_user(
                    user_id=user_id,
                    address={
                        "deviceId": device_id,
                        "localTaskId": local_task_id,
                    },
                    title=title or local_task_id,
                    status=status,
                    content=content,
                    source=str(source_name) if source_name else None,
                )
            )
        except Exception:
            logger.exception(
                "[RuntimeTaskNotification] Runtime event IM delivery failed: "
                "user_id=%s device_id=%s local_task_id=%s event_type=%s",
                user_id,
                device_id,
                local_task_id,
                event_type,
            )
            return

        notified = int(notification.get("sent") or 0)
        results = _summarize_runtime_notification_results(notification)
        if results and notified <= 0:
            logger.warning(
                "[RuntimeTaskNotification] Runtime event was not delivered: "
                "user_id=%s device_id=%s local_task_id=%s event_type=%s results=%s",
                user_id,
                device_id,
                local_task_id,
                event_type,
                results,
            )
        else:
            logger.info(
                "[RuntimeTaskNotification] Runtime event dispatched: "
                "user_id=%s device_id=%s local_task_id=%s event_type=%s sent=%s",
                user_id,
                device_id,
                local_task_id,
                event_type,
                notified,
            )

    async def _publish_task_completed_event(
        self,
        task_id: int,
        subtask_id: int,
        user_id: int,
        device_id: str,
        event: Any,
    ) -> None:
        """Publish TaskCompletedEvent and broadcast slot update for terminal events."""
        try:
            if event.type == EventType.DONE.value:
                status = "COMPLETED"
                result = event.result if hasattr(event, "result") else None
                error = None
            elif event.type == EventType.ERROR.value:
                status = "FAILED"
                result = None
                error = event.error if hasattr(event, "error") else "Unknown error"
            else:
                status = "CANCELLED"
                result = None
                error = None

            event_bus = get_event_bus()
            await event_bus.publish(
                TaskCompletedEvent(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    user_id=user_id,
                    status=status,
                    result=result,
                    error=error,
                )
            )

            logger.info(
                f"[Device WS] Published TaskCompletedEvent: "
                f"task_id={task_id}, subtask_id={subtask_id}, status={status}"
            )

            # Broadcast slot update after task completion
            await self._broadcast_device_slot_update(user_id, device_id)

        except Exception as e:
            logger.error(
                f"[Device WS] Failed to publish TaskCompletedEvent: {e}",
                exc_info=True,
            )

    # ============================================================
    # Broadcast Helpers
    # ============================================================

    async def _broadcast_device_online(
        self, user_id: int, device_id: str, name: str
    ) -> None:
        """Broadcast device:online event to user room via chat namespace."""
        from app.schemas.device import DeviceStatusEnum

        event_data = DeviceOnlineEvent(
            device_id=device_id,
            name=name,
            status=DeviceStatusEnum.ONLINE,
        ).model_dump()

        await emit_chat_user_event(
            event_name="device:online", payload=event_data, user_id=user_id
        )
        logger.debug(f"[Device WS] Broadcast device:online to user rooms for {user_id}")

    async def _broadcast_device_offline(self, user_id: int, device_id: str) -> None:
        """Broadcast device:offline event to user room via chat namespace."""
        event_data = DeviceOfflineEvent(device_id=device_id).model_dump()

        await emit_chat_user_event(
            event_name="device:offline", payload=event_data, user_id=user_id
        )
        logger.debug(
            f"[Device WS] Broadcast device:offline to user rooms for {user_id}"
        )

    async def _broadcast_device_status(
        self, user_id: int, device_id: str, status: str
    ) -> None:
        """Broadcast device:status event to user room via chat namespace."""
        from app.schemas.device import DeviceStatusEnum

        # Convert string status to enum
        status_enum = DeviceStatusEnum(status)
        event_data = DeviceStatusEvent(
            device_id=device_id, status=status_enum
        ).model_dump()

        await emit_chat_user_event(
            event_name="device:status", payload=event_data, user_id=user_id
        )
        logger.debug(
            f"[Device WS] Broadcast device:status to user rooms for {user_id}, status={status}"
        )

    async def _broadcast_device_slot_update(self, user_id: int, device_id: str) -> None:
        """
        Broadcast device:slot_update event to user room via chat namespace.

        Queries current slot usage and emits the update.
        Uses run_sync_in_executor to avoid blocking the event loop.
        """
        from app.schemas.device import DeviceRunningTask

        try:
            # Run database query in executor to avoid blocking event loop
            slot_info = await run_sync_in_executor(
                _get_device_slot_usage_sync, user_id, device_id
            )

            event_data = DeviceSlotUpdateEvent(
                device_id=device_id,
                slot_used=slot_info["used"],
                slot_max=slot_info["max"],
                running_tasks=[
                    DeviceRunningTask(**task) for task in slot_info["running_tasks"]
                ],
            ).model_dump()

            await emit_chat_user_event(
                event_name="device:slot_update", payload=event_data, user_id=user_id
            )
            logger.debug(
                f"[Device WS] Broadcast device:slot_update to user rooms for {user_id}, "
                f"slot_used={slot_info['used']}"
            )
        except Exception as e:
            logger.error(f"[Device WS] Error broadcasting slot update: {e}")

    async def emit_upgrade_command(self, socket_id: str, params: dict) -> bool:
        """
        Emit device:upgrade command to a specific device.

        This method is called from the internal API to trigger a remote upgrade.

        Args:
            socket_id: The Socket.IO session ID of the target device
            params: Upgrade parameters (force, auto_confirm, verbose, etc.)

        Returns:
            True if the command was emitted successfully, False otherwise
        """
        try:
            await self.emit(
                "device:upgrade",
                params,
                room=socket_id,
            )
            logger.info(f"[Device WS] Sent upgrade command to socket {socket_id}")
            return True
        except Exception as e:
            logger.error(f"[Device WS] Failed to send upgrade command: {e}")
            return False

    async def _broadcast_device_upgrade_status(
        self, user_id: int, payload: "DeviceUpgradeStatusEvent"
    ) -> None:
        """
        Broadcast device:upgrade_status event to owner and admin rooms via chat namespace.

        Args:
            user_id: Device owner's user ID
            payload: DeviceUpgradeStatusEvent payload
        """
        try:
            event_data = payload.model_dump()
            target_user_ids = {user_id}

            with _db_session() as db:
                admin_user_ids = (
                    db.query(User.id)
                    .filter(User.role == "admin", User.is_active == True)
                    .all()
                )
                target_user_ids.update(admin_id for (admin_id,) in admin_user_ids)

            for target_user_id in target_user_ids:
                await emit_chat_user_event(
                    event_name="device:upgrade_status",
                    payload=event_data,
                    user_id=target_user_id,
                )
            logger.debug(
                f"[Device WS] Broadcast device:upgrade_status to users={sorted(target_user_ids)}, "
                f"device={payload.device_id}, status={payload.status}"
            )
        except Exception as e:
            logger.error(f"[Device WS] Error broadcasting upgrade status: {e}")


# Global singleton instance (initialized by register_device_namespace)
device_namespace: Optional[DeviceNamespace] = None


# Factory function to create the namespace
def create_device_namespace() -> DeviceNamespace:
    """Create and return a DeviceNamespace instance."""
    return DeviceNamespace()


def register_device_namespace(sio: socketio.AsyncServer) -> None:
    """
    Register the device namespace with the Socket.IO server.

    Args:
        sio: Socket.IO server instance
    """
    global device_namespace
    device_namespace = DeviceNamespace("/local-executor")
    sio.register_namespace(device_namespace)
    logger.info("Device namespace registered at /local-executor")

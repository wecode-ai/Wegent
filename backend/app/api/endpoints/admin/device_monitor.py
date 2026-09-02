# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin device monitor endpoints for viewing all user devices."""

import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.cache import cache_manager
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import BindShell, DeviceStatusEnum, DeviceType
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.device.admin_device_batch import (
    AdminDeviceBatchTarget,
    admin_device_batch_manager,
)
from app.services.device.admin_device_restart import restart_admin_device
from app.services.device.local_provider import (
    local_device_provider,
    runtime_capacity_slot_values,
)
from app.services.device_service import DeviceService as device_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/device-monitor")

# Stats cache configuration
_STATS_CACHE = {"data": None, "timestamp": 0, "ttl": 30}  # 30 seconds cache
VersionFilterOperator = Literal["gt", "gte", "eq", "lt", "lte"]


# ==================== Request/Response Models ====================


class AdminDeviceUpgradeRequest(BaseModel):
    """Request schema for admin device upgrade."""

    user_id: int = Field(..., description="Device owner user ID")
    force_stop_tasks: bool = Field(
        False, description="Force stop running tasks before upgrade"
    )


class AdminDeviceBatchUpgradeRequest(BaseModel):
    """Request schema for batch admin device upgrade."""

    force_stop_tasks: bool = Field(
        False, description="Force stop running tasks before upgrade"
    )


class AdminDeviceRestartRequest(BaseModel):
    """Request schema for admin device restart (cloud only)."""

    user_id: int = Field(..., description="Device owner user ID")


class AdminDeviceMigrateRequest(BaseModel):
    """Request schema for admin device migration (cloud only)."""

    user_id: int = Field(..., description="Device owner user ID")
    target_host: Optional[str] = Field(
        None, description="Target host for migration (future use)"
    )


class AdminDeviceActionResponse(BaseModel):
    """Response schema for admin device actions."""

    success: bool = Field(..., description="Whether the action was successful")
    message: str = Field(..., description="Action result message")


class AdminDeviceBatchStartResponse(BaseModel):
    """Response schema for starting an admin device batch action."""

    success: bool = Field(..., description="Whether the batch was accepted")
    batch_id: str = Field(..., description="Batch action ID")
    action: str = Field(..., description="Batch action type")
    status: str = Field(..., description="Batch status")
    total: int = Field(..., description="Total devices considered")
    message: str = Field(..., description="Batch start message")


class AdminDeviceBatchItemResponse(BaseModel):
    """Response schema for one device inside an admin batch action."""

    user_id: int = Field(..., description="Device owner user ID")
    device_id: str = Field(..., description="Device unique identifier")
    status: str = Field(..., description="Per-device batch status")
    message: str = Field(..., description="Per-device batch message")


class AdminDeviceBatchStatusResponse(AdminDeviceBatchStartResponse):
    """Response schema for admin batch device action status."""

    triggered: int = Field(..., description="Devices that accepted the action")
    failed: int = Field(..., description="Devices that failed the action")
    skipped: int = Field(..., description="Devices skipped as ineligible")
    errors: List[str] = Field(default_factory=list, description="Per-device errors")
    items: List[AdminDeviceBatchItemResponse] = Field(
        default_factory=list,
        description="Per-device batch action states",
    )


class AdminDeviceInfo(BaseModel):
    """Device information for admin monitoring."""

    id: int = Field(..., description="Device CRD ID in kinds table")
    device_id: str = Field(..., description="Device unique identifier")
    name: str = Field(..., description="Device name")
    status: DeviceStatusEnum = Field(..., description="Device online status")
    device_type: DeviceType = Field(
        DeviceType.LOCAL, description="Device type (local, app, cloud, or remote)"
    )
    bind_shell: BindShell = Field(
        BindShell.CLAUDECODE, description="Shell runtime binding"
    )
    user_id: int = Field(..., description="Owner user ID")
    user_name: str = Field(..., description="Owner username")
    client_ip: Optional[str] = Field(None, description="Device client IP")
    executor_version: Optional[str] = Field(None, description="Executor version")
    slot_used: int = Field(0, description="Number of slots in use")
    slot_max: int = Field(0, description="Maximum slots")
    created_at: Optional[str] = Field(None, description="Device creation timestamp")


class AdminDeviceListResponse(BaseModel):
    """Response schema for admin device list."""

    items: List[AdminDeviceInfo]
    total: int


class AdminDeviceStats(BaseModel):
    """Statistics for admin device monitoring."""

    total: int = Field(..., description="Total device count")
    user_count: int = Field(..., description="Total user count with devices")
    by_status: Dict[str, int] = Field(
        ..., description="Count by status (online, offline, busy)"
    )
    by_device_type: Dict[str, int] = Field(
        ..., description="Count by device type (local, app, cloud, remote)"
    )
    by_bind_shell: Dict[str, int] = Field(
        ..., description="Count by bind shell (claudecode, openclaw)"
    )


@dataclass(frozen=True)
class _AdminDeviceRecord:
    """Detached device fields safe to carry across the event-loop boundary."""

    id: int
    device_id: str
    name: str
    device_type: str
    bind_shell: str
    user_id: int
    user_name: str
    client_ip: str | None
    created_at: str | None

    @property
    def redis_key(self) -> str:
        return local_device_provider.generate_online_key(self.user_id, self.device_id)


@dataclass(frozen=True)
class _AdminDeviceQuerySnapshot:
    """One detached database result for the admin device list."""

    records: tuple[_AdminDeviceRecord, ...]
    total: int


@dataclass(frozen=True)
class _AdminDeviceStatsSnapshot:
    """Static device counters and Redis identities loaded in a DB worker."""

    total: int
    user_count: int
    by_device_type: Dict[str, int]
    by_bind_shell: Dict[str, int]
    redis_keys: tuple[str, ...]
    device_types: tuple[str, ...]


@dataclass(frozen=True)
class _AdminDeviceActionTarget:
    """Detached device identity used before async action dispatch."""

    device_type: str


def _build_device_query(
    db: Session,
    device_type: Optional[str],
    bind_shell: Optional[str],
    search: Optional[str],
    search_user_ids: Optional[List[int]] = None,
):
    """Build optimized query with SQL-level JSON filtering.

    Args:
        db: Database session
        device_type: Filter by device type (local/app/cloud/remote)
        bind_shell: Filter by bind shell (claudecode/openclaw)
        search: Search by device name or device ID
        search_user_ids: User IDs matching the search term (for username search)

    Returns:
        SQLAlchemy query object
    """
    query = db.query(Kind).filter(
        and_(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
    )

    # Filter by device type using JSON_EXTRACT with COALESCE for default value
    if device_type:
        query = query.filter(
            func.coalesce(
                func.json_unquote(func.json_extract(Kind.json, "$.spec.deviceType")),
                DeviceType.LOCAL.value,
            )
            == device_type
        )

    # Filter by bind shell using JSON_EXTRACT with COALESCE for default value
    if bind_shell:
        query = query.filter(
            func.coalesce(
                func.json_unquote(func.json_extract(Kind.json, "$.spec.bindShell")),
                BindShell.CLAUDECODE.value,
            )
            == bind_shell
        )

    # Search filter: device name, device ID, or username
    if search:
        search_pattern = f"%{search}%"
        search_conditions = [
            # Search by displayName (with fallback to name column)
            func.coalesce(
                func.json_unquote(func.json_extract(Kind.json, "$.spec.displayName")),
                Kind.name,
            ).ilike(search_pattern),
            # Search by deviceId (with fallback to name column)
            func.coalesce(
                func.json_unquote(func.json_extract(Kind.json, "$.spec.deviceId")),
                Kind.name,
            ).ilike(search_pattern),
        ]
        # Add user_id filter if there are matching users
        if search_user_ids:
            search_conditions.append(Kind.user_id.in_(search_user_ids))

        query = query.filter(or_(*search_conditions))

    return query


def _detach_device_records(
    db: Session,
    device_kinds: List[Kind],
) -> tuple[_AdminDeviceRecord, ...]:
    """Materialize ORM rows into immutable values before closing the Session."""
    user_ids = {kind.user_id for kind in device_kinds}
    users_map = (
        {
            user.id: user.user_name
            for user in db.query(User).filter(User.id.in_(user_ids)).all()
        }
        if user_ids
        else {}
    )
    records: list[_AdminDeviceRecord] = []
    for kind in device_kinds:
        spec = kind.json.get("spec", {}) if kind.json else {}
        device_id = spec.get("deviceId", kind.name)
        records.append(
            _AdminDeviceRecord(
                id=kind.id,
                device_id=device_id,
                name=spec.get("displayName", device_id),
                device_type=spec.get("deviceType", DeviceType.LOCAL.value),
                bind_shell=spec.get("bindShell", BindShell.CLAUDECODE.value),
                user_id=kind.user_id,
                user_name=users_map.get(kind.user_id, "Unknown"),
                client_ip=spec.get("clientIp"),
                created_at=(kind.created_at.isoformat() if kind.created_at else None),
            )
        )
    return tuple(records)


def _load_device_query_snapshot_from_store(
    page: int,
    limit: int,
    device_type: str | None,
    bind_shell: str | None,
    search: str | None,
    paginate_in_store: bool,
) -> _AdminDeviceQuerySnapshot:
    """Load and detach one list-query phase in a worker-owned Session."""
    with get_db_session() as db:
        search_user_ids: list[int] | None = None
        if search:
            matching_users = (
                db.query(User.id).filter(User.user_name.ilike(f"%{search}%")).all()
            )
            search_user_ids = [user.id for user in matching_users]

        query = _build_device_query(
            db,
            device_type,
            bind_shell,
            search,
            search_user_ids,
        )
        if paginate_in_store:
            total = query.count()
            offset = (page - 1) * limit
            device_kinds = query.offset(offset).limit(limit).all()
        else:
            device_kinds = query.all()
            total = len(device_kinds)
        return _AdminDeviceQuerySnapshot(
            records=_detach_device_records(db, device_kinds),
            total=total,
        )


async def _get_devices_redis_status(
    records: tuple[_AdminDeviceRecord, ...],
) -> Dict[str, Any]:
    """Get Redis status for detached devices in one batch."""
    if not records:
        return {}
    return await cache_manager.mget([record.redis_key for record in records])


def _build_device_info(
    record: _AdminDeviceRecord,
    online_info: Optional[Dict[str, Any]],
) -> AdminDeviceInfo:
    """Build an API response from detached DB values and live Redis state."""
    if online_info:
        status_val = online_info.get("status", DeviceStatusEnum.ONLINE.value)
        executor_version = online_info.get("executor_version")
        slot_used, slot_max = runtime_capacity_slot_values(online_info)
    else:
        status_val = DeviceStatusEnum.OFFLINE.value
        executor_version = None
        slot_used = 0
        slot_max = 0

    return AdminDeviceInfo(
        id=record.id,
        device_id=record.device_id,
        name=record.name,
        status=status_val,
        device_type=record.device_type,
        bind_shell=record.bind_shell,
        user_id=record.user_id,
        user_name=record.user_name,
        client_ip=record.client_ip,
        executor_version=executor_version,
        slot_used=slot_used,
        slot_max=slot_max,
        created_at=record.created_at,
    )


def _normalize_version_filter(
    version_op: Optional[VersionFilterOperator], version: Optional[str]
) -> Optional[tuple[VersionFilterOperator, Version]]:
    """Normalize version filter query params."""
    normalized_version = (version or "").strip()
    if not normalized_version:
        return None

    try:
        parsed_version = Version(normalized_version)
    except InvalidVersion as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid version filter: {normalized_version}",
        ) from exc

    return (version_op or "gte", parsed_version)


def _matches_version_filter(
    executor_version: Optional[str],
    version_filter: tuple[VersionFilterOperator, Version],
) -> bool:
    """Check whether an executor version matches the requested filter."""
    if not executor_version:
        return False

    try:
        parsed_executor_version = Version(executor_version.strip())
    except InvalidVersion:
        logger.warning(
            f"[DeviceMonitor] Skipping device with invalid executor version: {executor_version}"
        )
        return False

    version_op, target_version = version_filter
    if version_op == "gt":
        return parsed_executor_version > target_version
    if version_op == "gte":
        return parsed_executor_version >= target_version
    if version_op == "eq":
        return parsed_executor_version == target_version
    if version_op == "lt":
        return parsed_executor_version < target_version
    return parsed_executor_version <= target_version


def _load_device_stats_snapshot_from_store() -> _AdminDeviceStatsSnapshot:
    """Load all static statistics in a worker-owned database Session."""
    with get_db_session() as db:
        device_kinds = (
            db.query(Kind)
            .filter(
                and_(
                    Kind.kind == "Device",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
            )
            .all()
        )

        by_device_type = {
            DeviceType.LOCAL.value: 0,
            DeviceType.APP.value: 0,
            DeviceType.CLOUD.value: 0,
            DeviceType.REMOTE.value: 0,
        }
        by_bind_shell = {
            BindShell.CLAUDECODE.value: 0,
            BindShell.OPENCLAW.value: 0,
        }
        redis_keys: list[str] = []
        device_types: list[str] = []
        user_ids: set[int] = set()
        for kind in device_kinds:
            spec = kind.json.get("spec", {}) if kind.json else {}
            device_id = spec.get("deviceId", kind.name)
            device_type = spec.get("deviceType", DeviceType.LOCAL.value)
            bind_shell = spec.get("bindShell", BindShell.CLAUDECODE.value)
            if device_type in by_device_type:
                by_device_type[device_type] += 1
            if bind_shell in by_bind_shell:
                by_bind_shell[bind_shell] += 1
            redis_keys.append(
                local_device_provider.generate_online_key(kind.user_id, device_id)
            )
            device_types.append(device_type)
            user_ids.add(kind.user_id)

        return _AdminDeviceStatsSnapshot(
            total=len(device_kinds),
            user_count=len(user_ids),
            by_device_type=by_device_type,
            by_bind_shell=by_bind_shell,
            redis_keys=tuple(redis_keys),
            device_types=tuple(device_types),
        )


@router.get("/devices", response_model=AdminDeviceListResponse)
async def get_all_devices(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    status: Optional[DeviceStatusEnum] = Query(None, description="Filter by status"),
    device_type: Optional[str] = Query(None, description="Filter by device type"),
    bind_shell: Optional[str] = Query(None, description="Filter by bind shell"),
    search: Optional[str] = Query(
        None, description="Search by device name, ID or username"
    ),
    version_op: Optional[VersionFilterOperator] = Query(
        None, description="Version comparison operator"
    ),
    version: Optional[str] = Query(
        None, description="Filter online devices by executor version"
    ),
    current_user: User = Depends(security.get_admin_user),
):
    """Get all devices across all users for admin monitoring (optimized).

    This endpoint uses SQL-level JSON filtering for better performance:
    1. Filters device_type and bind_shell using MySQL JSON_EXTRACT
    2. Search uses SQL LIKE on JSON fields plus user_id lookup
    3. Only queries Redis for the current page devices (batch mget)

    Note: Status filter is removed for performance. Status is displayed
    but cannot be used as a filter criterion.

    Args:
        page: Page number (1-indexed)
        limit: Items per page
        device_type: Filter by device type (local/app/cloud/remote)
        bind_shell: Filter by bind shell (claudecode/openclaw)
        search: Search by device name, device ID or username
        current_user: Must be admin

    Returns:
        AdminDeviceListResponse with paginated devices
    """
    effective_version = None if status == DeviceStatusEnum.OFFLINE else version
    normalized_version_filter = _normalize_version_filter(version_op, effective_version)
    paginate_in_store = normalized_version_filter is None and status is None
    snapshot = await run_sync_in_executor(
        _load_device_query_snapshot_from_store,
        page,
        limit,
        device_type,
        bind_shell,
        search,
        paginate_in_store,
    )
    online_info_map = await _get_devices_redis_status(snapshot.records)

    if paginate_in_store:
        return AdminDeviceListResponse(
            items=[
                _build_device_info(record, online_info_map.get(record.redis_key))
                for record in snapshot.records
            ],
            total=snapshot.total,
        )

    filtered_pairs: list[tuple[_AdminDeviceRecord, Dict[str, Any] | None]] = []
    for record in snapshot.records:
        online_info = online_info_map.get(record.redis_key)

        status_val = (
            online_info.get("status", DeviceStatusEnum.ONLINE.value)
            if online_info
            else DeviceStatusEnum.OFFLINE.value
        )
        if status is not None and status_val != status.value:
            continue

        if normalized_version_filter is not None and not _matches_version_filter(
            online_info.get("executor_version") if online_info else None,
            normalized_version_filter,
        ):
            continue

        filtered_pairs.append((record, online_info))

    total = len(filtered_pairs)
    offset = (page - 1) * limit
    page_pairs = filtered_pairs[offset : offset + limit]
    return AdminDeviceListResponse(
        items=[
            _build_device_info(record, online_info)
            for record, online_info in page_pairs
        ],
        total=total,
    )


@router.get("/stats", response_model=AdminDeviceStats)
async def get_device_stats(
    current_user: User = Depends(security.get_admin_user),
):
    """Get device statistics for admin monitoring (with caching).

    Uses a 30-second in-memory cache to reduce Redis load for frequent requests.

    Args:
        current_user: Must be admin

    Returns:
        AdminDeviceStats with counts by status, type, and shell
    """
    global _STATS_CACHE

    # Check cache
    now = time.time()
    if _STATS_CACHE["data"] and (now - _STATS_CACHE["timestamp"]) < _STATS_CACHE["ttl"]:
        logger.debug("Returning cached device stats")
        return _STATS_CACHE["data"]

    by_status: Dict[str, int] = {
        DeviceStatusEnum.ONLINE.value: 0,
        DeviceStatusEnum.OFFLINE.value: 0,
        DeviceStatusEnum.BUSY.value: 0,
    }
    snapshot = await run_sync_in_executor(_load_device_stats_snapshot_from_store)
    online_info_map = await cache_manager.mget(list(snapshot.redis_keys))
    for redis_key, device_type in zip(
        snapshot.redis_keys,
        snapshot.device_types,
        strict=True,
    ):
        online_info = online_info_map.get(redis_key)
        status_val = (
            online_info.get("status", DeviceStatusEnum.ONLINE.value)
            if online_info
            else DeviceStatusEnum.OFFLINE.value
        )
        if status_val == DeviceStatusEnum.OFFLINE.value:
            if device_type == DeviceType.CLOUD.value:
                by_status[status_val] += 1
        elif status_val in by_status:
            by_status[status_val] += 1

    result = AdminDeviceStats(
        total=snapshot.total,
        user_count=snapshot.user_count,
        by_status=by_status,
        by_device_type=snapshot.by_device_type,
        by_bind_shell=snapshot.by_bind_shell,
    )

    # Update cache
    _STATS_CACHE["data"] = result
    _STATS_CACHE["timestamp"] = now

    return result


# ==================== Device Action Endpoints ====================


def _load_device_action_target_from_store(
    user_id: int,
    device_id: str,
) -> _AdminDeviceActionTarget | None:
    """Load one action target using a worker-owned database Session."""
    with get_db_session() as db:
        device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
        if device_kind is None:
            return None
        spec = device_kind.json.get("spec", {}) if device_kind.json else {}
        return _AdminDeviceActionTarget(
            device_type=spec.get("deviceType", DeviceType.LOCAL.value)
        )


async def _get_device_for_action(device_id: str, user_id: int) -> Dict[str, Any]:
    """Validate stored ownership, then load live status without blocking the loop."""
    target = await run_sync_in_executor(
        _load_device_action_target_from_store,
        user_id,
        device_id,
    )
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    online_info = await device_service.get_device_online_info(user_id, device_id)
    if not online_info:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device is offline",
        )

    if not online_info.get("socket_id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device socket information not found",
        )

    return online_info


def _get_device_id(kind: Kind) -> str:
    """Resolve a Device CRD's public device ID."""
    spec = kind.json.get("spec", {}) if kind.json else {}
    return spec.get("deviceId", kind.name)


def _get_active_devices_by_type(db: Session, device_type: DeviceType) -> List[Kind]:
    """Return active Device CRDs for the requested device type."""
    device_kinds = (
        db.query(Kind)
        .filter(
            and_(
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
        )
        .all()
    )
    return [
        kind
        for kind in device_kinds
        if (kind.json.get("spec", {}) if kind.json else {}).get(
            "deviceType", DeviceType.LOCAL.value
        )
        == device_type.value
    ]


def _load_batch_targets_from_store(
    device_type: DeviceType,
    bind_shell: BindShell | None = None,
) -> List[AdminDeviceBatchTarget]:
    """Load detached batch target identities in a worker-owned Session."""
    with get_db_session() as db:
        devices = _get_active_devices_by_type(db, device_type)
        if bind_shell is not None:
            devices = [
                kind
                for kind in devices
                if (kind.json.get("spec", {}) if kind.json else {}).get(
                    "bindShell", BindShell.CLAUDECODE.value
                )
                == bind_shell.value
            ]
        return [
            AdminDeviceBatchTarget(
                user_id=kind.user_id,
                device_id=_get_device_id(kind),
            )
            for kind in devices
        ]


def _get_upgrade_params(force_stop_tasks: bool) -> Dict[str, Any]:
    """Build local executor upgrade command params."""
    return {
        "force": False,
        "auto_confirm": True,
        "verbose": False,
        "force_stop_tasks": force_stop_tasks,
    }


@router.post(
    "/devices/{device_id}/upgrade",
    response_model=AdminDeviceActionResponse,
)
async def upgrade_device(
    device_id: str = Path(..., description="Device unique identifier"),
    request: AdminDeviceUpgradeRequest = ...,
    current_user: User = Depends(security.get_admin_user),
):
    """Trigger device upgrade for any user's device (admin only).

    Args:
        device_id: Device unique identifier
        request: Upgrade request with user_id and options
        current_user: Must be admin

    Returns:
        AdminDeviceActionResponse indicating success/failure
    """
    user_id = request.user_id

    # Validate device exists and is online
    online_info = await _get_device_for_action(device_id, user_id)

    # Check for running tasks
    running_task_ids = online_info.get("running_task_ids", [])
    if running_task_ids and not request.force_stop_tasks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Device has {len(running_task_ids)} running task(s). "
            f"Use force_stop_tasks=true to proceed.",
        )

    # Emit upgrade command via WebSocket
    try:
        from app.api.ws.device_namespace import device_namespace

        socket_id = online_info["socket_id"]
        upgrade_params = _get_upgrade_params(request.force_stop_tasks)

        success = await device_namespace.emit_upgrade_command(socket_id, upgrade_params)

        if success:
            logger.info(
                f"[Admin Device Upgrade] Command sent: "
                f"admin={current_user.user_name}, user_id={user_id}, device_id={device_id}"
            )
            return AdminDeviceActionResponse(
                success=True, message="Upgrade command sent to device"
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to send upgrade command",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            f"[Admin Device Upgrade] Error: device_id={device_id}, error={e}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to trigger upgrade: {str(e)}",
        )


@router.post(
    "/devices/local/upgrade-all",
    response_model=AdminDeviceBatchStartResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def upgrade_all_local_devices(
    request: AdminDeviceBatchUpgradeRequest = AdminDeviceBatchUpgradeRequest(),
    current_user: User = Depends(security.get_admin_user),
):
    """Start a batch upgrade for all eligible local ClaudeCode devices."""
    targets = await run_sync_in_executor(
        _load_batch_targets_from_store,
        DeviceType.LOCAL,
        BindShell.CLAUDECODE,
    )
    batch = admin_device_batch_manager.start_local_upgrade(
        targets=targets,
        force_stop_tasks=request.force_stop_tasks,
        admin_name=current_user.user_name,
    )
    logger.info(
        "[Admin Device Batch Upgrade] Started: admin=%s, batch_id=%s, total=%d",
        current_user.user_name,
        batch.batch_id,
        batch.total,
    )
    return AdminDeviceBatchStartResponse(**batch.to_start_dict())


@router.post(
    "/devices/{device_id}/restart",
    response_model=AdminDeviceActionResponse,
)
async def restart_device(
    device_id: str = Path(..., description="Device unique identifier"),
    request: AdminDeviceRestartRequest = ...,
    current_user: User = Depends(security.get_admin_user),
):
    """Restart a cloud device (admin only). Currently not implemented.

    Args:
        device_id: Device unique identifier
        request: Restart request with user_id
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceActionResponse indicating the feature is not implemented
    """
    user_id = request.user_id

    target = await run_sync_in_executor(
        _load_device_action_target_from_store,
        user_id,
        device_id,
    )
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    # Check device type - only cloud devices can be restarted
    if target.device_type != DeviceType.CLOUD.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only cloud devices can be restarted",
        )

    try:
        result = await restart_admin_device(user_id, device_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            f"[Admin Device Restart] Error: device_id={device_id}, error={e}"
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to trigger restart: {str(e)}",
        )

    logger.info(
        f"[Admin Device Restart] Completed: "
        f"admin={current_user.user_name}, user_id={user_id}, "
        f"device_id={device_id}, success={result.success}"
    )
    return AdminDeviceActionResponse(
        success=result.success,
        message=result.message,
    )


@router.post(
    "/devices/cloud/restart-all",
    response_model=AdminDeviceBatchStartResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def restart_all_cloud_devices(
    current_user: User = Depends(security.get_admin_user),
):
    """Start a batch restart for all cloud devices."""
    targets = await run_sync_in_executor(
        _load_batch_targets_from_store,
        DeviceType.CLOUD,
    )
    batch = admin_device_batch_manager.start_cloud_restart(
        targets=targets,
        admin_name=current_user.user_name,
    )
    logger.info(
        "[Admin Device Batch Restart] Started: admin=%s, batch_id=%s, total=%d",
        current_user.user_name,
        batch.batch_id,
        batch.total,
    )
    return AdminDeviceBatchStartResponse(**batch.to_start_dict())


@router.get(
    "/batches/{batch_id}",
    response_model=AdminDeviceBatchStatusResponse,
)
def get_device_batch_status(
    batch_id: str = Path(..., description="Admin device batch action ID"),
    current_user: User = Depends(security.get_admin_user),
):
    """Get status for an admin device batch action."""
    batch = admin_device_batch_manager.get_batch(batch_id)
    if batch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device batch not found: {batch_id}",
        )

    return AdminDeviceBatchStatusResponse(
        **batch.to_status_dict(),
    )


@router.post(
    "/devices/{device_id}/migrate",
    response_model=AdminDeviceActionResponse,
)
def migrate_device(
    device_id: str = Path(..., description="Device unique identifier"),
    request: AdminDeviceMigrateRequest = ...,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """Migrate a cloud device to another host (admin only). Currently not implemented.

    Args:
        device_id: Device unique identifier
        request: Migrate request with user_id and optional target_host
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceActionResponse indicating the feature is not implemented
    """
    user_id = request.user_id

    # Validate device exists
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    # Check device type - only cloud devices can be migrated
    spec = device_kind.json.get("spec", {}) if device_kind.json else {}
    device_type = spec.get("deviceType", DeviceType.LOCAL.value)
    if device_type != DeviceType.CLOUD.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only cloud devices can be migrated",
        )

    logger.info(
        f"[Admin Device Migrate] Stub called: "
        f"admin={current_user.user_name}, user_id={user_id}, device_id={device_id}, "
        f"target_host={request.target_host}"
    )

    # TODO: Implement actual migration logic for cloud devices
    return AdminDeviceActionResponse(
        success=False,
        message="Device migration is not yet implemented. This feature will be available in a future release.",
    )

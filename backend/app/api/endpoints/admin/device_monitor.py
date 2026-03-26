# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin device monitor endpoints for viewing all user devices."""

import logging
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.cache import cache_manager
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import BindShell, DeviceStatusEnum, DeviceType
from app.services.device.local_provider import local_device_provider
from app.services.device_service import DeviceService as device_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/device-monitor")

# Stats cache configuration
_STATS_CACHE = {"data": None, "timestamp": 0, "ttl": 30}  # 30 seconds cache


# ==================== Request/Response Models ====================


class AdminDeviceUpgradeRequest(BaseModel):
    """Request schema for admin device upgrade."""

    user_id: int = Field(..., description="Device owner user ID")
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


class AdminDeviceInfo(BaseModel):
    """Device information for admin monitoring."""

    id: int = Field(..., description="Device CRD ID in kinds table")
    device_id: str = Field(..., description="Device unique identifier")
    name: str = Field(..., description="Device name")
    status: DeviceStatusEnum = Field(..., description="Device online status")
    device_type: DeviceType = Field(
        DeviceType.LOCAL, description="Device type (local or cloud)"
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
        ..., description="Count by device type (local, cloud)"
    )
    by_bind_shell: Dict[str, int] = Field(
        ..., description="Count by bind shell (claudecode, openclaw)"
    )


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
        device_type: Filter by device type (local/cloud)
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


async def _get_devices_redis_status(
    device_kinds: List[Kind],
) -> Dict[str, Any]:
    """Get Redis status for devices in batch.

    Args:
        device_kinds: List of device Kind objects

    Returns:
        Dict mapping Redis keys to device status info
    """
    if not device_kinds:
        return {}

    # Build Redis keys for all devices
    redis_keys = []
    for kind in device_kinds:
        spec = kind.json.get("spec", {}) if kind.json else {}
        device_id = spec.get("deviceId", kind.name)
        redis_key = local_device_provider.generate_online_key(kind.user_id, device_id)
        redis_keys.append(redis_key)

    # Batch get all Redis status (single round-trip)
    return await cache_manager.mget(redis_keys)


def _build_device_info(
    kind: Kind,
    users_map: Dict[int, str],
    online_info: Optional[Dict[str, Any]],
) -> AdminDeviceInfo:
    """Build AdminDeviceInfo from Kind and Redis status.

    Args:
        kind: Device Kind object
        users_map: Map of user_id to user_name
        online_info: Redis status info or None

    Returns:
        AdminDeviceInfo object
    """
    spec = kind.json.get("spec", {}) if kind.json else {}
    device_id = spec.get("deviceId", kind.name)

    # Determine status from Redis
    if online_info:
        status_val = online_info.get("status", DeviceStatusEnum.ONLINE.value)
        executor_version = online_info.get("executor_version")
        running_task_ids = online_info.get("running_task_ids", [])
        slot_used = len(running_task_ids)
    else:
        status_val = DeviceStatusEnum.OFFLINE.value
        executor_version = None
        slot_used = 0

    # Format created_at as ISO string
    created_at_str = None
    if kind.created_at:
        created_at_str = kind.created_at.isoformat()

    return AdminDeviceInfo(
        id=kind.id,
        device_id=device_id,
        name=spec.get("displayName", device_id),
        status=status_val,
        device_type=spec.get("deviceType", DeviceType.LOCAL.value),
        bind_shell=spec.get("bindShell", BindShell.CLAUDECODE.value),
        user_id=kind.user_id,
        user_name=users_map.get(kind.user_id, "Unknown"),
        client_ip=spec.get("clientIp"),
        executor_version=executor_version,
        slot_used=slot_used,
        slot_max=5,  # MAX_DEVICE_SLOTS default
        created_at=created_at_str,
    )


@router.get("/devices", response_model=AdminDeviceListResponse)
async def get_all_devices(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    device_type: Optional[str] = Query(None, description="Filter by device type"),
    bind_shell: Optional[str] = Query(None, description="Filter by bind shell"),
    search: Optional[str] = Query(
        None, description="Search by device name, ID or username"
    ),
    db: Session = Depends(get_db),
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
        device_type: Filter by device type (local/cloud)
        bind_shell: Filter by bind shell (claudecode/openclaw)
        search: Search by device name, device ID or username
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceListResponse with paginated devices
    """
    # Step 1: If search term provided, find matching user IDs first
    search_user_ids: Optional[List[int]] = None
    if search:
        matching_users = (
            db.query(User.id).filter(User.user_name.ilike(f"%{search}%")).all()
        )
        search_user_ids = [u.id for u in matching_users] if matching_users else []

    # Step 2: Build optimized query with SQL-level filtering
    query = _build_device_query(db, device_type, bind_shell, search, search_user_ids)

    # Step 3: Get total count and paginated results
    total = query.count()
    offset = (page - 1) * limit
    page_kinds = query.offset(offset).limit(limit).all()

    # Step 4: Build user map only for current page (not all devices)
    page_user_ids = list({d.user_id for d in page_kinds})
    users_map: Dict[int, str] = {}
    if page_user_ids:
        users = db.query(User).filter(User.id.in_(page_user_ids)).all()
        users_map = {u.id: u.user_name for u in users}

    # Step 5: Get Redis status for current page only (batch query)
    online_info_map = await _get_devices_redis_status(page_kinds)

    # Step 6: Build device info list
    items = []
    for kind in page_kinds:
        spec = kind.json.get("spec", {}) if kind.json else {}
        device_id = spec.get("deviceId", kind.name)
        redis_key = local_device_provider.generate_online_key(kind.user_id, device_id)
        online_info = online_info_map.get(redis_key)

        device_info = _build_device_info(kind, users_map, online_info)
        items.append(device_info)

    return AdminDeviceListResponse(items=items, total=total)


@router.get("/stats", response_model=AdminDeviceStats)
async def get_device_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """Get device statistics for admin monitoring (with caching).

    Uses a 30-second in-memory cache to reduce Redis load for frequent requests.

    Args:
        db: Database session
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

    # Get all Device CRDs
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

    # Initialize counters
    by_status: Dict[str, int] = {
        DeviceStatusEnum.ONLINE.value: 0,
        DeviceStatusEnum.OFFLINE.value: 0,
        DeviceStatusEnum.BUSY.value: 0,
    }
    by_device_type: Dict[str, int] = {
        DeviceType.LOCAL.value: 0,
        DeviceType.CLOUD.value: 0,
    }
    by_bind_shell: Dict[str, int] = {
        BindShell.CLAUDECODE.value: 0,
        BindShell.OPENCLAW.value: 0,
    }

    # Count unique users with devices
    user_ids = {d.user_id for d in device_kinds}

    # Build Redis keys for all devices and collect static data
    redis_keys = []
    device_metadata = []

    for kind in device_kinds:
        spec = kind.json.get("spec", {}) if kind.json else {}
        device_id = spec.get("deviceId", kind.name)
        device_type_val = spec.get("deviceType", DeviceType.LOCAL.value)
        bind_shell_val = spec.get("bindShell", BindShell.CLAUDECODE.value)

        # Count by device type (static data)
        if device_type_val in by_device_type:
            by_device_type[device_type_val] += 1

        # Count by bind shell (static data)
        if bind_shell_val in by_bind_shell:
            by_bind_shell[bind_shell_val] += 1

        # Prepare for Redis batch query
        redis_key = local_device_provider.generate_online_key(kind.user_id, device_id)
        redis_keys.append(redis_key)
        device_metadata.append({"type": device_type_val, "shell": bind_shell_val})

    # Batch get all Redis status (single round-trip for all devices)
    online_info_map = await cache_manager.mget(redis_keys)

    # Count by status
    for i, metadata in enumerate(device_metadata):
        redis_key = redis_keys[i]
        online_info = online_info_map.get(redis_key)

        if online_info:
            status_val = online_info.get("status", DeviceStatusEnum.ONLINE.value)
        else:
            status_val = DeviceStatusEnum.OFFLINE.value

        # Only count offline cloud devices (not all offline devices)
        if status_val == DeviceStatusEnum.OFFLINE.value:
            if metadata["type"] == DeviceType.CLOUD.value:
                by_status[status_val] += 1
        elif status_val in by_status:
            by_status[status_val] += 1

    result = AdminDeviceStats(
        total=len(device_kinds),
        user_count=len(user_ids),
        by_status=by_status,
        by_device_type=by_device_type,
        by_bind_shell=by_bind_shell,
    )

    # Update cache
    _STATS_CACHE["data"] = result
    _STATS_CACHE["timestamp"] = now

    return result


# ==================== Device Action Endpoints ====================


async def _get_device_for_action(
    db: Session, device_id: str, user_id: int
) -> tuple[Kind, Dict[str, Any]]:
    """Get device and validate it exists and is online.

    Args:
        db: Database session
        device_id: Device unique identifier
        user_id: Device owner user ID

    Returns:
        Tuple of (device Kind, online_info dict)

    Raises:
        HTTPException: If device not found, offline, or socket_id missing
    """
    # Get device from database
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    # Get online info from Redis
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

    return device_kind, online_info


@router.post(
    "/devices/{device_id}/upgrade",
    response_model=AdminDeviceActionResponse,
)
async def upgrade_device(
    device_id: str = Path(..., description="Device unique identifier"),
    request: AdminDeviceUpgradeRequest = ...,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """Trigger device upgrade for any user's device (admin only).

    Args:
        device_id: Device unique identifier
        request: Upgrade request with user_id and options
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceActionResponse indicating success/failure
    """
    user_id = request.user_id

    # Validate device exists and is online
    device_kind, online_info = await _get_device_for_action(db, device_id, user_id)

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
        upgrade_params = {
            "force": False,
            "auto_confirm": True,
            "verbose": False,
            "force_stop_tasks": request.force_stop_tasks,
        }

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
    "/devices/{device_id}/restart",
    response_model=AdminDeviceActionResponse,
)
async def restart_device(
    device_id: str = Path(..., description="Device unique identifier"),
    request: AdminDeviceRestartRequest = ...,
    db: Session = Depends(get_db),
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

    # Validate device exists
    device_kind = device_service.get_device_by_device_id(db, user_id, device_id)
    if not device_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Device not found: device_id={device_id}, user_id={user_id}",
        )

    # Check device type - only cloud devices can be restarted
    spec = device_kind.json.get("spec", {}) if device_kind.json else {}
    device_type = spec.get("deviceType", DeviceType.LOCAL.value)
    if device_type != DeviceType.CLOUD.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only cloud devices can be restarted",
        )

    logger.info(
        f"[Admin Device Restart] Stub called: "
        f"admin={current_user.user_name}, user_id={user_id}, device_id={device_id}"
    )

    # TODO: Implement actual restart logic for cloud devices
    return AdminDeviceActionResponse(
        success=False,
        message="Device restart is not yet implemented. This feature will be available in a future release.",
    )


@router.post(
    "/devices/{device_id}/migrate",
    response_model=AdminDeviceActionResponse,
)
async def migrate_device(
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

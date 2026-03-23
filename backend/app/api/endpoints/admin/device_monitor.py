# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin device monitor endpoints for viewing all user devices."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import BindShell, DeviceStatusEnum, DeviceType
from app.services.device.provider_factory import DeviceProviderFactory

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/device-monitor")


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


@router.get("/devices", response_model=AdminDeviceListResponse)
async def get_all_devices(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status: Optional[str] = Query(None, description="Filter by status"),
    device_type: Optional[str] = Query(None, description="Filter by device type"),
    bind_shell: Optional[str] = Query(None, description="Filter by bind shell"),
    search: Optional[str] = Query(None, description="Search by device name or ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """
    Get all devices across all users for admin monitoring.

    Args:
        page: Page number (1-indexed)
        limit: Items per page
        status: Filter by device status (online/offline/busy)
        device_type: Filter by device type (local/cloud)
        bind_shell: Filter by bind shell (claudecode/openclaw)
        search: Search by device name or device ID
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceListResponse with all devices matching filters
    """
    # Get all Device CRDs from the database
    query = db.query(Kind).filter(
        and_(
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
    )

    # Get all devices with user info
    device_kinds = query.all()

    # Build user ID to username map
    user_ids = list({d.user_id for d in device_kinds})
    users_map: Dict[int, str] = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        users_map = {u.id: u.user_name for u in users}

    # Get online status for all devices from Redis
    all_devices: List[Dict[str, Any]] = []
    for device_kind in device_kinds:
        spec = device_kind.json.get("spec", {})
        device_id = spec.get("deviceId", device_kind.name)
        device_type_val = spec.get("deviceType", DeviceType.LOCAL.value)
        bind_shell_val = spec.get("bindShell", BindShell.CLAUDECODE.value)

        # Get device provider and online status
        try:
            provider_type = DeviceType(device_type_val)
            provider = DeviceProviderFactory.get_provider(provider_type)
            if provider:
                device_status = await provider.get_status(
                    db, device_kind.user_id, device_id
                )
                status_val = device_status.get("status", DeviceStatusEnum.OFFLINE.value)
                executor_version = device_status.get("executor_version")
                slot_used = device_status.get("slot_used", 0)
                slot_max = device_status.get("slot_max", 0)
            else:
                status_val = DeviceStatusEnum.OFFLINE.value
                executor_version = None
                slot_used = 0
                slot_max = 0
        except Exception:
            status_val = DeviceStatusEnum.OFFLINE.value
            executor_version = None
            slot_used = 0
            slot_max = 0

        device_info = {
            "id": device_kind.id,
            "device_id": device_id,
            "name": spec.get("displayName", device_kind.name),
            "status": status_val,
            "device_type": device_type_val,
            "bind_shell": bind_shell_val,
            "user_id": device_kind.user_id,
            "user_name": users_map.get(device_kind.user_id, "Unknown"),
            "client_ip": spec.get("clientIp"),
            "executor_version": executor_version,
            "slot_used": slot_used,
            "slot_max": slot_max,
        }
        all_devices.append(device_info)

    # Apply filters
    filtered_devices = all_devices

    if status:
        filtered_devices = [d for d in filtered_devices if d["status"] == status]

    if device_type:
        filtered_devices = [
            d for d in filtered_devices if d["device_type"] == device_type
        ]

    if bind_shell:
        filtered_devices = [
            d for d in filtered_devices if d["bind_shell"] == bind_shell
        ]

    if search:
        search_lower = search.lower()
        filtered_devices = [
            d
            for d in filtered_devices
            if search_lower in d["name"].lower()
            or search_lower in d["device_id"].lower()
            or search_lower in d["user_name"].lower()
        ]

    # Pagination
    total = len(filtered_devices)
    start = (page - 1) * limit
    end = start + limit
    paginated_devices = filtered_devices[start:end]

    return AdminDeviceListResponse(
        items=[AdminDeviceInfo(**d) for d in paginated_devices],
        total=total,
    )


@router.get("/stats", response_model=AdminDeviceStats)
async def get_device_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_admin_user),
):
    """
    Get device statistics for admin monitoring.

    Args:
        db: Database session
        current_user: Must be admin

    Returns:
        AdminDeviceStats with counts by status, type, and shell
    """
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

    # Count devices
    for device_kind in device_kinds:
        spec = device_kind.json.get("spec", {})
        device_id = spec.get("deviceId", device_kind.name)
        device_type_val = spec.get("deviceType", DeviceType.LOCAL.value)
        bind_shell_val = spec.get("bindShell", BindShell.CLAUDECODE.value)

        # Count by device type
        if device_type_val in by_device_type:
            by_device_type[device_type_val] += 1

        # Count by bind shell
        if bind_shell_val in by_bind_shell:
            by_bind_shell[bind_shell_val] += 1

        # Get online status
        try:
            provider_type = DeviceType(device_type_val)
            provider = DeviceProviderFactory.get_provider(provider_type)
            if provider:
                device_status = await provider.get_status(
                    db, device_kind.user_id, device_id
                )
                status_val = device_status.get("status", DeviceStatusEnum.OFFLINE.value)
            else:
                status_val = DeviceStatusEnum.OFFLINE.value
        except Exception:
            status_val = DeviceStatusEnum.OFFLINE.value

        # Count by status
        if status_val in by_status:
            by_status[status_val] += 1

    return AdminDeviceStats(
        total=len(device_kinds),
        user_count=len(user_ids),
        by_status=by_status,
        by_device_type=by_device_type,
        by_bind_shell=by_bind_shell,
    )

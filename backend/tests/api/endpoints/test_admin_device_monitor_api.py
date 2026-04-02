# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from packaging.version import Version
from sqlalchemy.orm import Session

from app.api.endpoints.admin import device_monitor
from app.models.kind import Kind
from app.models.user import User


def _create_device_kind(test_db: Session, user_id: int, device_id: str, name: str) -> Kind:
    device = Kind(
        user_id=user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": device_id,
                "namespace": "default",
                "displayName": name,
            },
            "spec": {
                "deviceId": device_id,
                "displayName": name,
                "deviceType": "local",
                "bindShell": "claudecode",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()
    test_db.refresh(device)
    return device


@pytest.mark.asyncio
async def test_admin_device_monitor_filters_online_devices_by_version(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
):
    online_device = _create_device_kind(test_db, test_user.id, "device-online", "Online")
    busy_device = _create_device_kind(test_db, test_user.id, "device-busy", "Busy")
    _create_device_kind(test_db, test_user.id, "device-offline", "Offline")

    online_key = device_monitor.local_device_provider.generate_online_key(
        test_user.id, "device-online"
    )
    busy_key = device_monitor.local_device_provider.generate_online_key(
        test_user.id, "device-busy"
    )
    offline_key = device_monitor.local_device_provider.generate_online_key(
        test_user.id, "device-offline"
    )

    with patch(
        "app.api.endpoints.admin.device_monitor.cache_manager.mget",
        new=AsyncMock(
            return_value={
                online_key: {
                    "status": "online",
                    "executor_version": "1.7.0",
                    "running_task_ids": [],
                },
                busy_key: {
                    "status": "busy",
                    "executor_version": "1.8.0",
                    "running_task_ids": [],
                },
                offline_key: None,
            }
        ),
    ):
        response = await device_monitor.get_all_devices(
            page=1,
            limit=20,
            status=None,
            device_type=None,
            bind_shell=None,
            search=None,
            version_op="gte",
            version="1.7.0",
            db=test_db,
            current_user=test_admin_user,
        )

    assert response.total == 2
    assert {item.device_id for item in response.items} == {
        online_device.name,
        busy_device.name,
    }
    assert {item.status.value for item in response.items} == {"online", "busy"}


@pytest.mark.asyncio
async def test_admin_device_monitor_ignores_version_filter_for_offline_status(
    test_db: Session,
    test_admin_user: User,
    test_user: User,
):
    _create_device_kind(test_db, test_user.id, "device-online", "Online")
    offline_device = _create_device_kind(test_db, test_user.id, "device-offline", "Offline")

    online_key = device_monitor.local_device_provider.generate_online_key(
        test_user.id, "device-online"
    )
    offline_key = device_monitor.local_device_provider.generate_online_key(
        test_user.id, "device-offline"
    )

    with patch(
        "app.api.endpoints.admin.device_monitor.cache_manager.mget",
        new=AsyncMock(
            return_value={
                online_key: {
                    "status": "online",
                    "executor_version": "1.5.0",
                    "running_task_ids": [],
                },
                offline_key: None,
            }
        ),
    ):
        response = await device_monitor.get_all_devices(
            page=1,
            limit=20,
            status=device_monitor.DeviceStatusEnum.OFFLINE,
            device_type=None,
            bind_shell=None,
            search=None,
            version_op="gte",
            version="9.9.9",
            db=test_db,
            current_user=test_admin_user,
        )

    assert response.total == 1
    assert response.items[0].device_id == offline_device.name
    assert response.items[0].status.value == "offline"


def test_admin_device_monitor_rejects_invalid_version_filter():
    with pytest.raises(HTTPException) as exc_info:
        device_monitor._normalize_version_filter("gte", "bad-version")

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Invalid version filter: bad-version"


def test_admin_device_monitor_matches_version_filter():
    version_filter = ("lte", Version("1.6.5"))

    assert device_monitor._matches_version_filter("1.6.5", version_filter) is True
    assert device_monitor._matches_version_filter("1.6.4", version_filter) is True
    assert device_monitor._matches_version_filter("1.7.0", version_filter) is False
    assert device_monitor._matches_version_filter(None, version_filter) is False

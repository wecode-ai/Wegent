# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import logging
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.device import DeviceHeartbeatPayload
from app.services.device.capacity import (
    get_runtime_capacity,
    get_runtime_capacity_sync,
    validate_runtime_capacity_observation_sync,
)

pytestmark = pytest.mark.unit


def _device(db: Session, user: User) -> None:
    db.add(
        Kind(
            kind="Device",
            namespace="default",
            name="app-route",
            user_id=user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": "app",
                    "runtimeInstanceId": "runtime-1",
                }
            },
        )
    )
    db.commit()


def test_sync_capacity_requires_matching_runtime_identity(
    test_db: Session, test_user: User, caplog
) -> None:
    _device(test_db, test_user)
    online = {
        "runtime_instance_id": "different-runtime",
        "runtime_capacity": {
            "limit": 4,
            "active": 1,
            "active_task_ids": ["manual-1"],
            "queued": 2,
        },
    }

    with (
        patch(
            "app.services.device.capacity.cache_manager.get_sync",
            return_value=online,
        ),
        caplog.at_level(logging.DEBUG, logger="app.services.device.capacity"),
    ):
        capacity = get_runtime_capacity_sync(
            test_db,
            owner_user_id=test_user.id,
            device_id="app-route",
        )

    assert capacity is None
    assert "runtime_capacity_unavailable reason=invalid_snapshot" in caplog.text
    assert "expected_instance_id=runtime-1" in caplog.text
    assert "reported_instance_id=different-runtime" in caplog.text


def test_pull_capacity_uses_current_observation(
    test_db: Session,
    test_user: User,
) -> None:
    _device(test_db, test_user)

    capacity = validate_runtime_capacity_observation_sync(
        test_db,
        owner_user_id=test_user.id,
        device_id="app-route",
        runtime_instance_id="runtime-1",
        runtime_capacity={
            "limit": 4,
            "active": 1,
            "active_task_ids": ["manual-1"],
            "queued": 2,
        },
    )

    assert capacity is not None
    assert (capacity.limit, capacity.active, capacity.queued) == (4, 1, 2)
    assert capacity.active_task_ids == frozenset({"manual-1"})


@pytest.mark.asyncio
async def test_async_capacity_reads_live_runtime_snapshot(
    test_db: Session, test_user: User
) -> None:
    _device(test_db, test_user)
    online = {
        "runtime_instance_id": "runtime-1",
        "runtime_capacity": {
            "limit": 4,
            "active": 1,
            "active_task_ids": ["manual-1"],
            "queued": 2,
        },
    }

    with patch(
        "app.services.device.capacity.cache_manager.get",
        AsyncMock(return_value=online),
    ):
        capacity = await get_runtime_capacity(
            test_db,
            owner_user_id=test_user.id,
            device_id="app-route",
        )

    assert capacity is not None
    assert capacity.runtime_instance_id == "runtime-1"
    assert (capacity.limit, capacity.active, capacity.queued) == (4, 1, 2)
    assert capacity.active_task_ids == frozenset({"manual-1"})


def test_heartbeat_capacity_validation_has_no_silent_clamping() -> None:
    with pytest.raises(ValueError):
        DeviceHeartbeatPayload.model_validate(
            {
                "device_id": "app-route",
                "runtime_instance_id": "runtime-1",
                "runtime_capacity": {
                    "limit": 21,
                    "active": 0,
                    "active_task_ids": [],
                    "queued": 0,
                },
            }
        )


def test_heartbeat_capacity_requires_identity_for_every_active_task() -> None:
    with pytest.raises(ValueError, match="active_task_ids"):
        DeviceHeartbeatPayload.model_validate(
            {
                "device_id": "app-route",
                "runtime_instance_id": "runtime-1",
                "runtime_capacity": {
                    "limit": 4,
                    "active": 1,
                    "active_task_ids": [],
                    "queued": 0,
                },
            }
        )

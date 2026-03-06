# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for execution target persistence in SubscriptionService."""

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.schemas.subscription import SubscriptionCreate, SubscriptionUpdate
from app.services.subscription.service import SubscriptionService


def _create_team(db: Session, owner_user_id: int, name: str) -> Kind:
    team = Kind(
        user_id=owner_user_id,
        kind="Team",
        name=name,
        namespace="default",
        json={},
        is_active=True,
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def _create_device(
    db: Session,
    owner_user_id: int,
    device_id: str,
    device_type: DeviceType,
    *,
    is_default: bool = False,
) -> Kind:
    device = Kind(
        user_id=owner_user_id,
        kind="Device",
        name=device_id,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {
                "deviceId": device_id,
                "displayName": device_id,
                "deviceType": device_type.value,
                "connectionMode": "websocket",
                "isDefault": is_default,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def _build_create_payload(team_id: int, execution_target: dict) -> SubscriptionCreate:
    suffix = uuid.uuid4().hex[:8]
    return SubscriptionCreate(
        name=f"execution-target-{suffix}",
        namespace="default",
        display_name="Execution Target Subscription",
        task_type="collection",
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=team_id,
        prompt_template="device aware task",
        execution_target=execution_target,
    )


def test_create_subscription_persists_specific_execution_target(
    test_db: Session, test_user
):
    """Create should persist a specific device execution target."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    device = _create_device(
        test_db,
        test_user.id,
        "local-device-1",
        DeviceType.LOCAL,
        is_default=True,
    )

    created = service.create_subscription(
        test_db,
        subscription_in=_build_create_payload(
            team.id,
            {
                "type": "local",
                "device_id": device.name,
            },
        ),
        user_id=test_user.id,
    )

    assert created.execution_target.type == "local"
    assert created.execution_target.device_id == device.name

    created_kind = test_db.query(Kind).filter(Kind.id == created.id).first()
    assert created_kind is not None
    assert created_kind.json["spec"]["executionTarget"]["type"] == "local"
    assert created_kind.json["spec"]["executionTarget"]["device_id"] == device.name


def test_update_subscription_persists_cloud_execution_target(
    test_db: Session, test_user
):
    """Update should allow switching to a specific cloud execution target."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    cloud_device = _create_device(
        test_db,
        test_user.id,
        "cloud-device-1",
        DeviceType.CLOUD,
        is_default=True,
    )
    created = service.create_subscription(
        test_db,
        subscription_in=_build_create_payload(team.id, {"type": "managed"}),
        user_id=test_user.id,
    )

    updated = service.update_subscription(
        test_db,
        subscription_id=created.id,
        subscription_in=SubscriptionUpdate(
            execution_target={"type": "cloud", "device_id": cloud_device.name}
        ),
        user_id=test_user.id,
    )

    assert updated.execution_target.type == "cloud"
    assert updated.execution_target.device_id == cloud_device.name


def test_create_subscription_rejects_execution_target_device_type_mismatch(
    test_db: Session, test_user
):
    """Create should reject a device whose type does not match the target type."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")
    _create_device(
        test_db,
        test_user.id,
        "cloud-device-1",
        DeviceType.CLOUD,
        is_default=True,
    )

    with pytest.raises(HTTPException) as exc_info:
        service.create_subscription(
            test_db,
            subscription_in=_build_create_payload(
                team.id,
                {
                    "type": "local",
                    "device_id": "cloud-device-1",
                },
            ),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 400
    assert "expected 'local'" in str(exc_info.value.detail)


def test_create_subscription_rejects_device_target_without_device_id(
    test_db: Session, test_user
):
    """Create should reject local/cloud targets that omit device_id."""
    service = SubscriptionService()
    team = _create_team(test_db, test_user.id, name=f"team-{uuid.uuid4().hex[:6]}")

    with pytest.raises(HTTPException) as exc_info:
        service.create_subscription(
            test_db,
            subscription_in=_build_create_payload(team.id, {"type": "local"}),
            user_id=test_user.id,
        )

    assert exc_info.value.status_code == 400
    assert "device_id is required" in str(exc_info.value.detail)

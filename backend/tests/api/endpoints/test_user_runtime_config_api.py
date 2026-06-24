# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints import users as users_endpoint
from app.core import security
from app.models.kind import Kind
from app.models.user import User


@pytest.fixture
def runtime_config_client(test_db: Session, test_user: User) -> TestClient:
    app = FastAPI()
    app.include_router(users_endpoint.router, prefix="/api/users")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


def _create_device(test_db: Session, user_id: int, device_id: str) -> Kind:
    device = Kind(
        user_id=user_id,
        kind="Device",
        namespace="default",
        name=device_id,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": device_id, "namespace": "default"},
            "spec": {"deviceId": device_id, "displayName": device_id},
        },
        is_active=True,
    )
    test_db.add(device)
    test_db.commit()
    return device


@pytest.mark.api
def test_update_runtime_config_accepts_auth_sync_and_syncs_slaves(
    runtime_config_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_device(test_db, test_user.id, "master-device")
    _create_device(test_db, test_user.id, "slave-a")
    users_endpoint.user_runtime_config_service.save_auth_json(
        test_db,
        user_id=test_user.id,
        runtime="codex",
        auth_json='{"token":"secret"}',
        preferences=test_user.preferences,
    )
    sync_auth_to_slave_devices = AsyncMock(
        return_value={"runtime": "codex", "total": 1, "items": []}
    )
    monkeypatch.setattr(
        users_endpoint.user_runtime_config_service,
        "sync_auth_to_slave_devices",
        sync_auth_to_slave_devices,
    )

    response = runtime_config_client.put(
        "/api/users/me/runtime-configs/codex",
        json={
            "use_user_config": True,
            "auth_sync": {
                "master_device_id": "master-device",
                "slave_device_ids": ["slave-a"],
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["auth_sync"] == {
        "master_device_id": "master-device",
        "slave_device_ids": ["slave-a"],
    }
    test_db.refresh(test_user)
    sync_auth_to_slave_devices.assert_awaited_once_with(
        test_db,
        user_id=test_user.id,
        runtime="codex",
        preferences=test_user.preferences,
    )


@pytest.mark.api
def test_upload_runtime_auth_json_syncs_slaves(
    runtime_config_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_user.preferences = json.dumps(
        {
            "runtime_configs": {
                "codex": {
                    "use_user_config": True,
                    "auth_sync": {
                        "master_device_id": "master-device",
                        "slave_device_ids": ["slave-a"],
                    },
                }
            }
        }
    )
    test_db.add(test_user)
    test_db.commit()
    sync_auth_to_slave_devices = AsyncMock(
        return_value={"runtime": "codex", "total": 1, "items": []}
    )
    monkeypatch.setattr(
        users_endpoint.user_runtime_config_service,
        "sync_auth_to_slave_devices",
        sync_auth_to_slave_devices,
    )

    response = runtime_config_client.post(
        "/api/users/me/runtime-configs/codex/auth-json",
        json={"auth_json": '{"token":"secret"}'},
    )

    assert response.status_code == 200
    assert response.json()["auth_sync"] == {
        "master_device_id": "master-device",
        "slave_device_ids": ["slave-a"],
    }
    sync_auth_to_slave_devices.assert_awaited_once_with(
        test_db,
        user_id=test_user.id,
        runtime="codex",
        preferences=test_user.preferences,
    )

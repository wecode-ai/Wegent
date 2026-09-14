# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execution-environment APIs must agree with the device page's live presence."""

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User


def _device(user_id: int, name: str, device_type: str, **spec: object) -> Kind:
    return Kind(
        user_id=user_id,
        kind="Device",
        namespace="default",
        name=name,
        is_active=True,
        json={
            "spec": {
                "deviceType": device_type,
                "displayName": name,
                "status": "online",
                **spec,
            }
        },
    )


def _get(test_client: TestClient, headers: dict[str, str], path: str) -> dict:
    response = test_client.get(path, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def _create(
    test_client: TestClient, headers: dict[str, str], path: str, body: dict
) -> dict:
    response = test_client.post(path, headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_all_environment_scopes_follow_device_heartbeats(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange: all CRDs say online, while only the cloud device has a heartbeat.
    offline = _device(test_user.id, "offline-mac", "local")
    cloud = _device(test_user.id, "cloud-record", "cloud", deviceId="cloud-socket")
    app = _device(
        test_user.id, "app-device", "app", runtimeInstanceId="runtime-current"
    )
    test_db.add_all([offline, cloud, app])
    test_db.commit()
    for device in [offline, cloud, app]:
        test_db.refresh(device)
    cloud_key = f"device:online:{test_user.id}:cloud-socket"
    app_key = f"device:online:{test_user.id}:app-record-{app.id}"
    live = {
        cloud_key: {"status": "online"},
        app_key: {"status": "online", "runtime_instance_id": "runtime-old"},
    }
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise",
        AsyncMock(
            side_effect=lambda keys: {key: live[key] for key in keys if key in live}
        ),
    )
    monkeypatch.setattr(
        "app.services.device.version_service.executor_version_service.get_latest_version",
        AsyncMock(return_value="1.0.0"),
    )
    headers = {"Authorization": f"Bearer {test_token}"}
    workspace = _create(
        test_client, headers, "/api/v1/workspaces", {"name": "Presence"}
    )
    project = _create(
        test_client,
        headers,
        f"/api/v1/workspaces/{workspace['id']}/projects",
        {"name": "Presence"},
    )
    workspace_path = f"/api/v1/workspaces/{workspace['id']}/execution-environments"
    project_path = f"/api/v1/cloud-projects/{project['id']}/execution-environments"

    # Act and assert: add responses and all three list APIs agree with device presence.
    expected = {offline.id: "offline", cloud.id: "online", app.id: "offline"}
    for device in [offline, cloud, app]:
        for path in [workspace_path, project_path]:
            created = _create(test_client, headers, path, {"device_id": device.id})
            assert created["status"] == expected[device.id]

    def assert_statuses(expected: dict[int, str]) -> None:
        devices = _get(test_client, headers, "/api/devices")["items"]
        device_statuses = {row["id"]: row["status"] for row in devices}
        assert device_statuses == expected
        resources = _get(test_client, headers, "/api/v1/resources")[
            "execution_environments"
        ]
        assert {row["device_id"]: row["status"] for row in resources} == expected
        for path in [workspace_path, project_path]:
            rows = _get(test_client, headers, path)["items"]
            assert {row["device_id"]: row["status"] for row in rows} == expected

    assert_statuses(expected)

    # A later request must observe disconnect/reconnect without editing the CRDs.
    live.pop(cloud_key)
    live[app_key] = {"status": "online", "runtime_instance_id": "runtime-current"}
    live[f"device:online:{test_user.id}:{offline.name}"] = {"status": "online"}
    assert_statuses({offline.id: "online", cloud.id: "offline", app.id: "online"})

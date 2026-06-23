# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_list_runtime_work_endpoint_uses_current_user(
    test_client, test_token, monkeypatch
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "projects": [],
            "unmappedDeviceWorkspaces": [],
            "totalLocalTasks": 0,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "list_runtime_work", service_mock
    )

    response = test_client.get("/api/runtime-work", headers=_auth_headers(test_token))

    assert response.status_code == 200
    assert response.json()["totalLocalTasks"] == 0
    assert "client_origin" not in service_mock.await_args.kwargs


def test_upsert_device_workspace_endpoint_returns_mapping(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = MagicMock(
        return_value={
            "id": 1,
            "userId": 7,
            "projectId": 3,
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "repoUrl": None,
            "repoRootFingerprint": None,
            "label": "MacBook",
            "createdAt": "2026-06-20T01:00:00",
            "updatedAt": "2026-06-20T01:00:00",
            "lastSeenAt": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "upsert_device_workspace", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/device-workspaces",
        headers=_auth_headers(test_token),
        json={
            "projectId": 3,
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "label": "MacBook",
        },
    )

    assert response.status_code == 200
    assert response.json()["workspacePath"] == "/repo/Wegent"
    assert service_mock.call_args.kwargs["payload"].device_id == "device-1"


def test_prepare_device_workspace_endpoint_dispatches_payload(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "mapping": {
                "id": 1,
                "userId": 7,
                "projectId": 3,
                "deviceId": "device-1",
                "workspacePath": "/repo/Wegent",
                "repoUrl": "https://github.com/wecode-ai/Wegent.git",
                "repoRootFingerprint": None,
                "label": "MacBook",
                "createdAt": "2026-06-20T01:00:00",
                "updatedAt": "2026-06-20T01:00:00",
                "lastSeenAt": None,
            },
            "preparedAction": "cloned",
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "prepare_device_workspace", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/device-workspaces/prepare",
        headers=_auth_headers(test_token),
        json={
            "projectId": 3,
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "action": "select",
            "label": "MacBook",
        },
    )

    assert response.status_code == 200
    assert response.json()["preparedAction"] == "cloned"
    payload = service_mock.await_args.kwargs["payload"]
    assert payload.project_id == 3
    assert payload.device_id == "device-1"
    assert payload.workspace_path == "/repo/Wegent"
    assert payload.action == "select"


def test_delete_device_workspace_endpoint_dispatches_payload(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = MagicMock(return_value=True)
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "delete_device_workspace",
        service_mock,
    )

    response = test_client.request(
        "DELETE",
        "/api/runtime-work/device-workspaces",
        headers=_auth_headers(test_token),
        params={
            "project_id": 3,
            "device_id": "device-1",
            "workspace_path": "/repo/Wegent",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert service_mock.call_args.kwargs["project_id"] == 3
    assert service_mock.call_args.kwargs["device_id"] == "device-1"
    assert service_mock.call_args.kwargs["workspace_path"] == "/repo/Wegent"


def test_runtime_transcript_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "localTaskId": "codex-1",
            "workspacePath": "/repo/Wegent",
            "runtime": "codex",
            "messages": [],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "get_runtime_transcript", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/transcript",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "localTaskId": "codex-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["localTaskId"] == "codex-1"
    assert service_mock.await_args.kwargs["address"].local_task_id == "codex-1"


def test_runtime_archive_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "localTaskId": "codex-1",
            "workspacePath": "/repo/Wegent",
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "archive_runtime_task", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/archive",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "localTaskId": "codex-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert service_mock.await_args.kwargs["address"].local_task_id == "codex-1"


def test_runtime_im_notification_settings_endpoint_uses_current_user(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "global": {
                "enabled": True,
                "sessionKey": "session-1",
                "session": None,
            },
            "runtimeTaskSubscriptions": [],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "get_im_notification_settings",
        service_mock,
    )

    response = test_client.get(
        "/api/runtime-work/im-notifications",
        headers=_auth_headers(test_token),
    )

    assert response.status_code == 200
    assert response.json()["global"]["enabled"] is True
    assert service_mock.await_args.kwargs["user_id"] > 0


def test_runtime_global_im_notification_endpoint_dispatches_payload(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "global": {
                "enabled": True,
                "sessionKey": "session-1",
                "session": None,
            },
            "runtimeTaskSubscriptions": [],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "update_global_im_notification",
        service_mock,
    )

    response = test_client.put(
        "/api/runtime-work/im-notifications/global",
        headers=_auth_headers(test_token),
        json={"enabled": True, "sessionKey": "session-1"},
    )

    assert response.status_code == 200
    payload = service_mock.await_args.kwargs["request"]
    assert payload.enabled is True
    assert payload.session_key == "session-1"


def test_runtime_task_im_notification_subscribe_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "address": {
                "deviceId": "device-1",
                "localTaskId": "codex-1",
            },
            "subscribed": True,
            "sessionKeys": ["session-1"],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "subscribe_runtime_task_im_notification",
        service_mock,
    )

    response = test_client.put(
        "/api/runtime-work/im-notifications/runtime-task",
        headers=_auth_headers(test_token),
        json={
            "address": {
                "deviceId": "device-1",
                "localTaskId": "codex-1",
            },
            "sessionKeys": ["session-1"],
        },
    )

    assert response.status_code == 200
    request = service_mock.await_args.kwargs["request"]
    assert request.address.device_id == "device-1"
    assert request.address.local_task_id == "codex-1"
    assert request.session_keys == ["session-1"]


def test_runtime_task_im_notification_unsubscribe_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "address": {
                "deviceId": "device-1",
                "localTaskId": "codex-1",
            },
            "subscribed": False,
            "sessionKeys": [],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "unsubscribe_runtime_task_im_notification",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/im-notifications/runtime-task/unsubscribe",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "localTaskId": "codex-1",
        },
    )

    assert response.status_code == 200
    address = service_mock.await_args.kwargs["address"]
    assert address.device_id == "device-1"
    assert address.local_task_id == "codex-1"

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

    response = test_client.get(
        "/api/runtime-work?client_origin=wework",
        headers=_auth_headers(test_token),
    )

    assert response.status_code == 200
    assert response.json()["totalLocalTasks"] == 0
    assert service_mock.await_args.kwargs["client_origin"] == "wework"


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

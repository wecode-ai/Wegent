# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.responses import StreamingResponse


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_list_runtime_work_endpoint_uses_current_user(
    test_client, test_token, monkeypatch
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "projects": [],
            "chats": [],
            "totalTasks": 0,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "list_runtime_work", service_mock
    )

    response = test_client.get("/api/runtime-work", headers=_auth_headers(test_token))

    assert response.status_code == 200
    assert response.json()["totalTasks"] == 0
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
            "taskId": "codex-1",
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
            "taskId": "codex-1",
            "limit": 25,
            "beforeCursor": "offset:120",
        },
    )

    assert response.status_code == 200
    assert response.json()["taskId"] == "codex-1"
    assert service_mock.await_args.kwargs["address"].local_task_id == "codex-1"
    assert service_mock.await_args.kwargs["address"].limit == 25
    assert service_mock.await_args.kwargs["address"].before_cursor == "offset:120"


def test_runtime_search_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "items": [
                {
                    "address": {
                        "deviceId": "device-1",
                        "workspacePath": "/repo/Wegent",
                        "taskId": "codex-1",
                    },
                    "runtime": "codex",
                    "title": "执行 pwd",
                    "snippet": "执行 pwd",
                    "matchStart": 3,
                    "matchEnd": 6,
                    "messageId": "m1",
                    "messageRole": "user",
                    "messageCreatedAt": "2026-06-21T12:00:00Z",
                    "updatedAt": "2026-06-21T12:00:01Z",
                    "deviceName": "MacBook",
                    "workspacePath": "/repo/Wegent",
                    "project": {"id": 1, "name": "Wegent"},
                }
            ]
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "search_runtime_work", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/search",
        headers=_auth_headers(test_token),
        json={"query": "pwd", "limit": 20},
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["snippet"] == "执行 pwd"
    request = service_mock.await_args.kwargs["request"]
    assert request.query == "pwd"
    assert request.limit == 20


def test_runtime_archive_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "taskId": "codex-1",
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
            "taskId": "codex-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert service_mock.await_args.kwargs["address"].local_task_id == "codex-1"


def test_runtime_rename_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "taskId": "codex-1",
            "workspacePath": "/repo/Wegent",
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "rename_runtime_task", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/rename",
        headers=_auth_headers(test_token),
        json={
            "address": {
                "deviceId": "device-1",
                "workspacePath": "/repo/Wegent",
                "taskId": "codex-1",
            },
            "title": "对齐需求核心点",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    request = service_mock.await_args.kwargs["request"]
    assert request.address.local_task_id == "codex-1"
    assert request.title == "对齐需求核心点"


def test_runtime_cancel_endpoint_dispatches_address(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "taskId": "codex-1",
            "workspacePath": "/repo/Wegent",
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "cancel_runtime_task", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/cancel",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/repo/Wegent",
            "taskId": "codex-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    assert service_mock.await_args.kwargs["address"].local_task_id == "codex-1"


def test_runtime_guidance_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "success": True,
            "taskId": "codex-1",
            "guidanceId": "guide-1",
            "turnId": "turn-1",
            "error": None,
            "code": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service, "send_runtime_guidance", service_mock
    )

    response = test_client.post(
        "/api/runtime-work/guidance",
        headers=_auth_headers(test_token),
        json={
            "address": {
                "deviceId": "device-1",
                "workspacePath": "/repo/Wegent",
                "taskId": "codex-1",
            },
            "message": "use this context",
            "clientGuidanceId": "guide-1",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    request = service_mock.await_args.kwargs["request"]
    assert request.address.local_task_id == "codex-1"
    assert request.client_guidance_id == "guide-1"


def test_archived_conversations_list_endpoint_dispatches_filters(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "items": [],
            "projectGroups": [],
            "total": 0,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "list_archived_conversations",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/archived-conversations/list",
        headers=_auth_headers(test_token),
        json={"search": "hello", "source": "local", "sort": "updated"},
    )

    assert response.status_code == 200
    assert response.json()["total"] == 0
    request = service_mock.await_args.kwargs["request"]
    assert request.search == "hello"
    assert request.source == "local"


def test_archived_conversations_delete_bulk_endpoint_dispatches_items(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "requestedCount": 1,
            "acceptedCount": 1,
            "deletedCount": 1,
            "results": [],
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "delete_archived_conversations_bulk",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/archived-conversations/delete-bulk",
        headers=_auth_headers(test_token),
        json={
            "items": [
                {
                    "deviceId": "device-1",
                    "workspacePath": "/repo/Wegent",
                    "taskId": "codex-1",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["deletedCount"] == 1
    request = service_mock.await_args.kwargs["request"]
    assert request.items[0].local_task_id == "codex-1"


def test_runtime_workspace_open_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "open_runtime_workspace",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/workspaces/open",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
            "label": "Hello project",
        },
    )

    assert response.status_code == 200
    assert response.json()["threadId"] is None
    request = service_mock.await_args.kwargs["request"]
    assert request.device_id == "device-1"
    assert request.workspace_path == "/Users/crystal/Documents/hello-0"
    assert request.label == "Hello project"


def test_runtime_workspace_rename_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
            "threadId": None,
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "rename_runtime_workspace",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/workspaces/rename",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
            "name": "Hello project",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    request = service_mock.await_args.kwargs["request"]
    assert request.device_id == "device-1"
    assert request.workspace_path == "/Users/crystal/Documents/hello-0"
    assert request.name == "Hello project"


def test_runtime_workspace_remove_endpoint_dispatches_request(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = AsyncMock(
        return_value={
            "accepted": True,
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
            "threadId": None,
            "error": None,
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "remove_runtime_workspace",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/workspaces/remove",
        headers=_auth_headers(test_token),
        json={
            "deviceId": "device-1",
            "workspacePath": "/Users/crystal/Documents/hello-0",
            "runtime": "codex",
        },
    )

    assert response.status_code == 200
    assert response.json()["accepted"] is True
    request = service_mock.await_args.kwargs["request"]
    assert request.device_id == "device-1"
    assert request.workspace_path == "/Users/crystal/Documents/hello-0"


def test_runtime_resolve_model_config_endpoint_returns_model_config_alias(
    test_client,
    test_token,
    monkeypatch,
):
    from app.api.endpoints import runtime_work

    service_mock = MagicMock(
        return_value={
            "model": "openai",
            "model_id": "gpt-4-turbo",
            "api_format": "responses",
            "protocol": "openai-responses",
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-test",
        }
    )
    monkeypatch.setattr(
        runtime_work.runtime_work_service,
        "resolve_codex_runtime_model_config",
        service_mock,
    )

    response = test_client.post(
        "/api/runtime-work/resolve-model-config",
        headers=_auth_headers(test_token),
        json={
            "modelId": "deepseek-v4-flash",
            "modelType": "user",
            "modelOptions": {},
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert "modelConfig" in data
    assert data["modelConfig"]["model_id"] == "gpt-4-turbo"
    assert "model_config" not in data
    assert service_mock.call_args.kwargs["model_id"] == "deepseek-v4-flash"
    assert service_mock.call_args.kwargs["proxy_backend_base_url"].endswith(
        "/api/runtime-work"
    )


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
                "taskId": "codex-1",
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
                "taskId": "codex-1",
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
                "taskId": "codex-1",
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
            "taskId": "codex-1",
        },
    )

    assert response.status_code == 200
    address = service_mock.await_args.kwargs["address"]
    assert address.device_id == "device-1"
    assert address.local_task_id == "codex-1"


def test_llm_responses_proxy_endpoint_streams_from_provider(
    test_client,
    monkeypatch,
):
    from app.services import llm_proxy_service

    async def stream():
        yield b"data: ok\n\n"

    proxy_mock = AsyncMock(
        return_value=StreamingResponse(stream(), media_type="text/event-stream")
    )
    monkeypatch.setattr(
        llm_proxy_service,
        "proxy_llm_responses",
        proxy_mock,
    )

    response = test_client.post(
        "/api/runtime-work/llm-responses-proxy/test-token/responses",
        headers={"content-type": "application/json", "accept": "text/event-stream"},
        json={"model": "gpt-4-turbo", "input": "hello"},
    )

    assert response.status_code == 200
    proxy_mock.assert_awaited_once()
    call_args = proxy_mock.await_args
    assert call_args.args[0] == "test-token"


def test_llm_responses_proxy_endpoint_does_not_require_bearer_auth(
    test_client,
    monkeypatch,
):
    from app.services import llm_proxy_service

    async def stream():
        yield b"data: ok\n\n"

    proxy_mock = AsyncMock(
        return_value=StreamingResponse(stream(), media_type="text/event-stream")
    )
    monkeypatch.setattr(
        llm_proxy_service,
        "proxy_llm_responses",
        proxy_mock,
    )

    response = test_client.post(
        "/api/runtime-work/llm-responses-proxy/test-token/responses",
        headers={"content-type": "application/json", "accept": "text/event-stream"},
        json={"model": "gpt-4-turbo", "input": "hello"},
    )

    assert response.status_code == 200

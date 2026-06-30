# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


def test_create_device_chat_task_endpoint_requires_auth(test_client):
    response = test_client.post(
        "/api/device-chat/tasks",
        json={
            "teamId": 1289,
            "message": "Run pwd",
        },
    )

    assert response.status_code == 401


def test_create_device_chat_task_endpoint_dispatches_payload(
    test_client,
    test_token,
    monkeypatch,
):
    from unittest.mock import AsyncMock

    from app.api.endpoints import device_chat_tasks
    from app.schemas.device_chat_task import DeviceChatTaskResponse

    service_mock = AsyncMock(
        return_value=DeviceChatTaskResponse(
            taskId=2267,
            userSubtaskId=3332,
            assistantSubtaskId=3333,
            messageId=5,
            aiTriggered=True,
            deviceId="device-1",
            chatUrl="/devices/chat?taskId=2267",
        )
    )
    monkeypatch.setattr(
        device_chat_tasks.device_chat_task_service,
        "create_device_chat_task",
        service_mock,
    )

    response = test_client.post(
        "/api/device-chat/tasks",
        headers={"Authorization": f"Bearer {test_token}"},
        json={
            "teamId": 1289,
            "taskId": 2267,
            "deviceId": "device-1",
            "modelId": "kimi-k2.5",
            "modelType": "public",
            "modelOptions": {"reasoning": {"effort": "medium"}},
            "message": "Run pwd",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "taskId": 2267,
        "userSubtaskId": 3332,
        "assistantSubtaskId": 3333,
        "messageId": 5,
        "aiTriggered": True,
        "deviceId": "device-1",
        "chatUrl": "/devices/chat?taskId=2267",
    }
    payload = service_mock.await_args.kwargs["request"]
    assert payload.team_id == 1289
    assert payload.task_id == 2267
    assert payload.device_id == "device-1"
    assert payload.model_id == "kimi-k2.5"
    assert payload.model_type == "public"
    assert payload.model_options == {"reasoning": {"effort": "medium"}}
    assert payload.message == "Run pwd"
    assert service_mock.await_args.kwargs["auth_token"] == test_token

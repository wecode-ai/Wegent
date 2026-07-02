# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.device_chat_task import DeviceChatTaskRequest


def _team(test_db, *, team_id: int = 1289) -> Kind:
    team = Kind(
        id=team_id,
        user_id=0,
        kind="Team",
        name="wegent-wework",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "wegent-wework", "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    return team


def _task(
    test_db,
    *,
    task_id: int,
    user_id: int,
    device_id: str = "device-old",
    client_origin: str = CLIENT_ORIGIN_FRONTEND,
):
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
                "labels": {"type": "online", "taskType": "task"},
            },
            "spec": {
                "title": "Existing device chat",
                "prompt": "Existing device chat",
                "device_id": device_id,
                "is_group_chat": False,
            },
            "status": {"status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin=client_origin,
    )
    test_db.add(task)
    test_db.commit()
    return task


def _creation_result(*, task_id: int, message_id: int = 1):
    return SimpleNamespace(
        task=SimpleNamespace(id=task_id),
        user_subtask=SimpleNamespace(id=3332, message_id=message_id),
        assistant_subtask=SimpleNamespace(id=3333),
        ai_triggered=True,
        rag_prompt=None,
    )


def _device(device_id: str):
    return SimpleNamespace(name=device_id)


@pytest.mark.asyncio
async def test_create_device_chat_task_creates_new_task_and_schedules_ai(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    create_chat_task = AsyncMock(return_value=_creation_result(task_id=2268))
    schedule_ai = MagicMock()
    monkeypatch.setattr(
        device_chat_task_service,
        "process_context_and_rag",
        AsyncMock(return_value=(None, None)),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_chat_task_dispatch_device_id",
        AsyncMock(return_value="device-1"),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "create_chat_task",
        create_chat_task,
    )
    monkeypatch.setattr(device_chat_task_service, "_schedule_ai_response", schedule_ai)

    response = await device_chat_task_service.create_device_chat_task(
        db=test_db,
        user=test_user,
        request=DeviceChatTaskRequest(
            teamId=team.id,
            deviceId="device-1",
            modelId="kimi-k2.5",
            modelType="public",
            modelOptions={"reasoning": {"effort": "medium"}},
            message="Run pwd",
        ),
        auth_token="jwt-token",
    )

    assert response.task_id == 2268
    assert response.user_subtask_id == 3332
    assert response.assistant_subtask_id == 3333
    assert response.message_id == 1
    assert response.ai_triggered is True
    assert response.device_id == "device-1"
    assert response.chat_url == "/devices/chat?taskId=2268"
    call_kwargs = create_chat_task.await_args.kwargs
    assert call_kwargs["task_id"] is None
    assert call_kwargs["message"] == "Run pwd"
    assert call_kwargs["should_trigger_ai"] is True
    assert call_kwargs["source"] == "web"
    params = call_kwargs["params"]
    assert params.task_type == "task"
    assert params.client_origin == CLIENT_ORIGIN_FRONTEND
    assert params.device_id == "device-1"
    assert params.model_id == "kimi-k2.5"
    assert params.force_override_bot_model_type == "public"
    assert params.model_options == {"reasoning": {"effort": "medium"}}
    schedule_ai.assert_called_once()
    assert schedule_ai.call_args.kwargs["auth_token"] == "jwt-token"


@pytest.mark.asyncio
async def test_create_device_chat_task_continues_existing_task(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    existing_task = _task(test_db, task_id=2267, user_id=test_user.id)
    create_chat_task = AsyncMock(
        return_value=_creation_result(task_id=existing_task.id, message_id=5)
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "process_context_and_rag",
        AsyncMock(return_value=(None, None)),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_chat_task_dispatch_device_id",
        AsyncMock(return_value="device-new"),
    )
    monkeypatch.setattr(device_chat_task_service, "create_chat_task", create_chat_task)
    monkeypatch.setattr(device_chat_task_service, "_schedule_ai_response", MagicMock())

    response = await device_chat_task_service.create_device_chat_task(
        db=test_db,
        user=test_user,
        request=DeviceChatTaskRequest(
            teamId=team.id,
            taskId=existing_task.id,
            message="Continue task",
        ),
    )

    assert response.task_id == existing_task.id
    assert response.message_id == 5
    assert response.device_id == "device-new"
    call_kwargs = create_chat_task.await_args.kwargs
    assert call_kwargs["task_id"] == existing_task.id
    assert call_kwargs["params"].device_id == "device-new"


@pytest.mark.asyncio
async def test_create_device_chat_task_continuation_uses_existing_client_origin(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    existing_task = _task(
        test_db,
        task_id=2267,
        user_id=test_user.id,
        client_origin=CLIENT_ORIGIN_WEWORK,
    )
    create_chat_task = AsyncMock(
        return_value=_creation_result(task_id=existing_task.id, message_id=5)
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "process_context_and_rag",
        AsyncMock(return_value=(None, None)),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_chat_task_dispatch_device_id",
        AsyncMock(return_value="device-old"),
    )
    monkeypatch.setattr(device_chat_task_service, "create_chat_task", create_chat_task)
    monkeypatch.setattr(device_chat_task_service, "_schedule_ai_response", MagicMock())

    await device_chat_task_service.create_device_chat_task(
        db=test_db,
        user=test_user,
        request=DeviceChatTaskRequest(
            teamId=team.id,
            taskId=existing_task.id,
            message="Continue task",
        ),
    )

    assert create_chat_task.await_args.kwargs["params"].client_origin == (
        CLIENT_ORIGIN_WEWORK
    )


@pytest.mark.asyncio
async def test_create_device_chat_task_rejects_inaccessible_existing_task(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    existing_task = _task(test_db, task_id=2267, user_id=test_user.id + 1000)
    create_chat_task = AsyncMock()
    monkeypatch.setattr(device_chat_task_service, "create_chat_task", create_chat_task)

    with pytest.raises(HTTPException) as exc_info:
        await device_chat_task_service.create_device_chat_task(
            db=test_db,
            user=test_user,
            request=DeviceChatTaskRequest(
                teamId=team.id,
                taskId=existing_task.id,
                message="Continue task",
            ),
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Task 2267 not found"
    create_chat_task.assert_not_called()


@pytest.mark.asyncio
async def test_create_device_chat_task_uses_default_local_device_when_not_specified(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    create_chat_task = AsyncMock(return_value=_creation_result(task_id=2269))
    monkeypatch.setattr(
        device_chat_task_service,
        "process_context_and_rag",
        AsyncMock(return_value=(None, None)),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_chat_task_dispatch_device_id",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        device_chat_task_service.device_service,
        "get_default_device_for_type",
        MagicMock(return_value=_device("device-default")),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_online_local_executor_device_id",
        AsyncMock(return_value="device-default"),
    )
    monkeypatch.setattr(device_chat_task_service, "create_chat_task", create_chat_task)
    monkeypatch.setattr(device_chat_task_service, "_schedule_ai_response", MagicMock())

    response = await device_chat_task_service.create_device_chat_task(
        db=test_db,
        user=test_user,
        request=DeviceChatTaskRequest(
            teamId=team.id,
            message="Use default device",
        ),
    )

    assert response.device_id == "device-default"
    assert create_chat_task.await_args.kwargs["params"].device_id == "device-default"


@pytest.mark.asyncio
async def test_create_device_chat_task_applies_wework_defaults_for_new_task(
    test_db,
    test_user,
    monkeypatch,
):
    from app.services import device_chat_task_service

    team = _team(test_db)
    create_chat_task = AsyncMock(return_value=_creation_result(task_id=2270))
    apply_defaults = AsyncMock(side_effect=lambda db, user, params: params)
    monkeypatch.setattr(
        device_chat_task_service,
        "process_context_and_rag",
        AsyncMock(return_value=(None, None)),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "resolve_chat_task_dispatch_device_id",
        AsyncMock(return_value="device-wework"),
    )
    monkeypatch.setattr(
        device_chat_task_service,
        "apply_wework_task_defaults",
        apply_defaults,
    )
    monkeypatch.setattr(device_chat_task_service, "create_chat_task", create_chat_task)
    monkeypatch.setattr(device_chat_task_service, "_schedule_ai_response", MagicMock())

    response = await device_chat_task_service.create_device_chat_task(
        db=test_db,
        user=test_user,
        request=DeviceChatTaskRequest(
            teamId=team.id,
            clientOrigin=CLIENT_ORIGIN_WEWORK,
            message="Use Wework defaults",
        ),
    )

    assert response.device_id == "device-wework"
    apply_defaults.assert_awaited_once()
    assert create_chat_task.await_args.kwargs["params"].client_origin == (
        CLIENT_ORIGIN_WEWORK
    )


@pytest.mark.asyncio
async def test_run_ai_response_passes_deep_thinking_flag(monkeypatch):
    from app.services import device_chat_task_service

    trigger = AsyncMock()
    monkeypatch.setattr(
        device_chat_task_service,
        "trigger_ai_response_unified",
        trigger,
    )

    await device_chat_task_service._run_ai_response(
        task=SimpleNamespace(id=2267),
        assistant_subtask=SimpleNamespace(id=3333),
        team=SimpleNamespace(id=1289),
        user=SimpleNamespace(id=2),
        message="Run pwd",
        payload=DeviceChatTaskRequest(
            teamId=1289,
            message="Run pwd",
            enableDeepThinking=False,
        ),
        device_id="device-1",
        user_subtask_id=3332,
        auth_token="jwt-token",
    )

    call_kwargs = trigger.await_args.kwargs
    assert call_kwargs["enable_tools"] is False
    assert call_kwargs["enable_deep_thinking"] is False

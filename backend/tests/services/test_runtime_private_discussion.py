# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from app.models.task import TaskResource
from app.schemas.runtime_work import (
    RuntimeGuidanceRequest,
    RuntimeSendRequest,
    RuntimeTranscriptResponse,
)
from app.services import runtime_work_service as service


@pytest.mark.parametrize("schema", [RuntimeSendRequest, RuntimeGuidanceRequest])
def test_runtime_conversation_context_is_typed_and_optional(schema):
    payload = {
        "address": {"deviceId": "device-1", "taskId": "original-task"},
        "message": "Discussion",
    }
    assert schema(**payload).conversation_context is None
    assert (
        schema(**payload, conversationContext="private_discussion").conversation_context
        == "private_discussion"
    )
    with pytest.raises(ValidationError):
        schema(**payload, conversationContext="unknown")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation,method,schema",
    [
        (service.send_runtime_message, "runtime.tasks.send", RuntimeSendRequest),
        (
            service.interrupt_and_send_runtime_message,
            "runtime.tasks.interrupt_and_send",
            RuntimeSendRequest,
        ),
        (
            service.send_runtime_guidance,
            "runtime.tasks.guidance",
            RuntimeGuidanceRequest,
        ),
    ],
)
async def test_remote_private_context_is_per_send_and_preserves_native_identity(
    test_db, test_user, monkeypatch, operation, method, schema
):
    owner = Mock(return_value=object())
    monkeypatch.setattr(
        service.device_service,
        "get_device_by_device_id",
        lambda db, user_id, device_id: owner(user_id, device_id),
    )

    async def history(**kwargs):
        return RuntimeTranscriptResponse(
            taskId=kwargs["address"].local_task_id,
            workspacePath="/project",
            runtime="codex",
            turns=[],
        )

    monkeypatch.setattr(service, "get_runtime_transcript", history)
    monkeypatch.setattr(
        service,
        "_build_runtime_send_execution_request",
        lambda **kwargs: SimpleNamespace(to_dict=lambda: {"prompt": kwargs["message"]}),
    )
    rpc = AsyncMock(
        return_value={
            "success": True,
            "accepted": True,
            "taskId": "original-task",
            "status": "running",
        }
    )
    monkeypatch.setattr(service.runtime_rpc_service, "call", rpc)
    address = {
        "deviceId": "device-1",
        "taskId": "original-task",
        "workspacePath": "/project",
    }
    for context in ["private_discussion", None]:
        request = schema(
            address=address,
            message="Continue in the original session",
            **({"conversationContext": context} if context else {}),
        )
        response = await operation(db=test_db, user_id=test_user.id, request=request)

        assert response.accepted is True
        dispatch = rpc.await_args.kwargs
        assert dispatch["method"] == method
        assert dispatch["user_id"] == test_user.id
        assert dispatch["device_id"] == address["deviceId"]
        payload = dispatch["payload"]
        assert payload["taskId"] == address["taskId"]
        assert payload["workspacePath"] == address["workspacePath"]
        assert "startNewSession" not in payload
        assert "forkRuntime" not in payload
        if context:
            assert payload["conversationContext"] == context
        else:
            assert "conversationContext" not in payload
    assert test_db.query(TaskResource).count() == 0
    assert owner.call_count >= 2
    assert all(
        call.args == (test_user.id, address["deviceId"])
        for call in owner.call_args_list
    )

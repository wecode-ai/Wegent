# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.responses import StreamingResponse

from app.services.execution import web_stream_execution as execution_module
from app.services.execution.web_stream_execution import (
    WebStreamExecutionService,
    WebStreamRequestError,
)
from app.services.execution.web_stream_protocol import (
    DEEP_RESEARCH_CREATE_EXECUTE,
    DEEP_RESEARCH_STATUS_EXECUTE,
    DEEP_RESEARCH_STREAM,
    EXECUTION_CANCEL_EXECUTE,
    MODEL_RUNTIME_EXECUTE,
    MODEL_RUNTIME_STREAM,
    PROMPT_DRAFT_EXECUTE,
    PROMPT_DRAFT_STREAM,
    REMOTE_WORKSPACE_STATUS_EXECUTE,
    REMOTE_WORKSPACE_TREE_EXECUTE,
    SUBTASK_SUBSCRIPTION_STREAM,
    TASK_RUNTIME_ACTIVE_STREAM_EXECUTE,
    WIZARD_PROMPT_EXECUTE,
    WIZARD_PROMPT_STREAM,
)
from shared.models import ExecutionRequest


async def _collect(operation: str, payload: dict) -> list[bytes]:
    return [
        frame async for frame in WebStreamExecutionService().stream(operation, payload)
    ]


@pytest.mark.asyncio
async def test_model_runtime_point_execution_is_worker_owned(monkeypatch) -> None:
    complete = AsyncMock(return_value="completed")
    monkeypatch.setattr(
        execution_module.stateless_runtime_service,
        "complete_text",
        complete,
    )

    result = await WebStreamExecutionService().execute(
        MODEL_RUNTIME_EXECUTE,
        {
            "model": "model",
            "input": "hello",
            "instructions": None,
            "model_config": {"model_id": "model"},
            "metadata": None,
            "tools": None,
        },
    )

    assert result == {"output_text": "completed"}
    assert complete.await_args.kwargs["input_data"] == "hello"


@pytest.mark.asyncio
async def test_prompt_and_wizard_point_execution_are_worker_owned(monkeypatch) -> None:
    prompt_result = {
        "title": "title",
        "prompt": "prompt",
        "model": "model",
        "version": 1,
        "created_at": "2026-01-01T00:00:00Z",
    }
    generate = AsyncMock(return_value=prompt_result)
    chat = AsyncMock(return_value="wizard")
    monkeypatch.setattr(
        execution_module.prompt_draft_service,
        "generate_prompt_draft_result",
        generate,
    )
    monkeypatch.setattr(
        execution_module.simple_chat_service,
        "chat_completion",
        chat,
    )
    context = {
        "task_id": 1,
        "user_id": 2,
        "selected_model": "model",
        "model_config": {"model_id": "model"},
        "conversation_blocks": [["user", "hello"], ["assistant", "hi"]],
    }

    prompt = await WebStreamExecutionService().execute(
        PROMPT_DRAFT_EXECUTE,
        {
            "context": context,
            "source": "panel",
            "current_prompt": None,
            "regenerate": False,
        },
    )
    wizard = await WebStreamExecutionService().execute(
        WIZARD_PROMPT_EXECUTE,
        {
            "message": "hello",
            "model_config": {"model_id": "model"},
            "system_prompt": "system",
        },
    )

    assert prompt == prompt_result
    assert wizard == {"response": "wizard"}
    assert generate.await_args.args[0].conversation_blocks[0] == ("user", "hello")
    chat.assert_awaited_once()


@pytest.mark.asyncio
async def test_deep_research_point_execution_is_worker_owned(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["base_url"] == "https://example.com"

        async def create_interaction(self, *, input_text, agent):
            assert input_text == "research"
            assert agent == "agent"
            return {"id": "created", "status": "in_progress"}

        async def get_interaction_status(self, interaction_id):
            assert interaction_id == "created"
            return {"id": interaction_id, "status": "completed"}

    monkeypatch.setattr(execution_module, "GeminiInteractionClient", Client)
    model_config = {
        "base_url": "https://example.com",
        "api_key": "key",
        "default_headers": {},
    }

    created = await WebStreamExecutionService().execute(
        DEEP_RESEARCH_CREATE_EXECUTE,
        {"model_config": model_config, "input": "research", "agent": "agent"},
    )
    status = await WebStreamExecutionService().execute(
        DEEP_RESEARCH_STATUS_EXECUTE,
        {"model_config": model_config, "interaction_id": "created"},
    )

    assert created["id"] == "created"
    assert status == {"id": "created", "status": "completed"}


@pytest.mark.asyncio
async def test_remote_workspace_point_execution_is_worker_owned(monkeypatch) -> None:
    run_sync = AsyncMock(
        side_effect=[
            {"connected": True, "available": False, "root_path": "/workspace/1"},
            {"path": "/workspace/1", "entries": []},
        ]
    )
    monkeypatch.setattr(execution_module, "_run_remote_workspace_sync", run_sync)
    service = WebStreamExecutionService()

    status_result = await service.execute(
        REMOTE_WORKSPACE_STATUS_EXECUTE,
        {"task_id": 1, "user_id": 2},
    )
    tree_result = await service.execute(
        REMOTE_WORKSPACE_TREE_EXECUTE,
        {"task_id": 1, "user_id": 2, "path": "/workspace"},
    )

    assert status_result["connected"] is True
    assert tree_result == {"path": "/workspace/1", "entries": []}
    assert run_sync.await_count == 2


@pytest.mark.asyncio
async def test_execution_cancel_is_worker_owned(monkeypatch) -> None:
    cancel = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "app.services.execution.dispatcher.execution_dispatcher.cancel_worker_owned",
        cancel,
    )
    request = ExecutionRequest(
        task_id=10,
        subtask_id=11,
        bot=[{"shell_type": "ClaudeCode"}],
    )

    result = await WebStreamExecutionService().execute(
        EXECUTION_CANCEL_EXECUTE,
        {"request": request.to_dict()},
    )

    assert result == {"success": True}
    received = cancel.await_args.args[0]
    assert (received.task_id, received.subtask_id) == (10, 11)


@pytest.mark.asyncio
async def test_task_runtime_cursor_is_calculated_in_stream_worker(monkeypatch) -> None:
    get_status = AsyncMock(
        return_value={
            "subtask_id": "11",
            "last_activity_at": "2026-09-02T08:00:00+00:00",
        }
    )
    get_length = AsyncMock(return_value=37)
    monkeypatch.setattr(
        execution_module.session_manager,
        "get_task_streaming_status",
        get_status,
    )
    monkeypatch.setattr(
        execution_module.session_manager,
        "get_streaming_content_length",
        get_length,
    )

    result = await WebStreamExecutionService().execute(
        TASK_RUNTIME_ACTIVE_STREAM_EXECUTE,
        {"task_id": 10},
    )

    assert result == {
        "active_stream": {
            "subtask_id": 11,
            "cursor": 37,
            "last_activity_at": "2026-09-02T08:00:00+00:00",
        }
    }
    get_status.assert_awaited_once_with(10)
    get_length.assert_awaited_once_with(11)


@pytest.mark.asyncio
async def test_model_runtime_stream_is_worker_owned(monkeypatch) -> None:
    calls: list[dict] = []

    async def stream_response(**kwargs):
        calls.append(kwargs)
        yield "data: model\n\n"

    monkeypatch.setattr(
        execution_module.stateless_runtime_service,
        "stream_response",
        stream_response,
    )

    frames = await _collect(
        MODEL_RUNTIME_STREAM,
        {
            "model": "model",
            "input": [{"role": "user", "content": "hello"}],
            "instructions": None,
            "model_config": {"model_id": "upstream"},
            "metadata": {"source": "test"},
            "tools": [],
        },
    )

    assert frames == [b"data: model\n\n"]
    assert calls[0]["model"] == "model"
    assert calls[0]["input_data"][0]["content"] == "hello"


@pytest.mark.asyncio
async def test_prompt_draft_projection_and_context_live_in_worker(monkeypatch) -> None:
    contexts = []

    async def generate_prompt_draft_stream(**kwargs):
        contexts.append(kwargs["context"])
        yield {"type": "prompt_delta", "delta": "你是"}
        yield {"type": "completed", "data": {"prompt": "你是助手"}}

    monkeypatch.setattr(
        execution_module.prompt_draft_service,
        "generate_prompt_draft_stream",
        generate_prompt_draft_stream,
    )

    frames = await _collect(
        PROMPT_DRAFT_STREAM,
        {
            "context": {
                "task_id": 1,
                "user_id": 2,
                "selected_model": "model",
                "model_config": {"model_id": "model"},
                "conversation_blocks": [["user", "hello"], ["assistant", "hi"]],
            },
            "source": "panel",
            "current_prompt": None,
            "regenerate": False,
        },
    )

    assert b'"type": "prompt_delta"' in frames[0]
    assert b'"type": "completed"' in frames[1]
    assert contexts[0].conversation_blocks == (
        ("user", "hello"),
        ("assistant", "hi"),
    )


@pytest.mark.asyncio
async def test_wizard_stream_iterates_and_closes_worker_response(monkeypatch) -> None:
    closed = asyncio.Event()

    async def body():
        try:
            yield "data: first\n\n"
        finally:
            closed.set()

    chat_stream = AsyncMock(
        return_value=StreamingResponse(body(), media_type="text/event-stream")
    )
    monkeypatch.setattr(
        execution_module.simple_chat_service,
        "chat_stream",
        chat_stream,
    )

    frames = await _collect(
        WIZARD_PROMPT_STREAM,
        {
            "message": "hello",
            "model_config": {"model": "openai", "model_id": "model"},
            "system_prompt": "system",
        },
    )

    assert frames == [b"data: first\n\n"]
    assert closed.is_set()
    chat_stream.assert_awaited_once()


@pytest.mark.asyncio
async def test_deep_research_mapping_and_codec_run_in_worker(monkeypatch) -> None:
    class Client:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def stream_interaction_result(self, interaction_id):
            assert interaction_id == "interaction"
            yield "content.delta", '{"value":1}'
            yield "interaction.complete", '{"status":"done"}'

    monkeypatch.setattr(execution_module, "GeminiInteractionClient", Client)

    frames = await _collect(
        DEEP_RESEARCH_STREAM,
        {
            "interaction_id": "interaction",
            "model_config": {
                "base_url": "https://example.com",
                "api_key": "key",
                "default_headers": {"x-test": "value"},
            },
        },
    )

    assert frames[0].startswith(b"event: content.delta\n")
    assert b'"value": 1' in frames[0]
    assert frames[1].startswith(b"event: response.done\n")


@pytest.mark.asyncio
async def test_subtask_redis_lifecycle_and_projection_are_worker_owned(
    monkeypatch,
) -> None:
    pubsub = SimpleNamespace(
        get_message=AsyncMock(
            side_effect=[
                {"type": "message", "data": b"next"},
                {
                    "type": "message",
                    "data": b'{"__type__":"STREAM_DONE","result":"ok"}',
                },
            ]
        ),
        unsubscribe=AsyncMock(),
    )
    redis_client = SimpleNamespace(aclose=AsyncMock())
    monkeypatch.setattr(
        execution_module.session_manager,
        "get_streaming_content",
        AsyncMock(return_value="cached"),
    )
    monkeypatch.setattr(
        execution_module.session_manager,
        "subscribe_streaming_channel",
        AsyncMock(return_value=(redis_client, pubsub)),
    )

    frames = await _collect(
        SUBTASK_SUBSCRIPTION_STREAM,
        {"subtask_id": 7, "offset": 3},
    )

    assert b'"content": "hed"' in frames[0]
    assert b'"content": "next"' in frames[1]
    assert b'"done": true' in frames[2]
    pubsub.unsubscribe.assert_awaited_once()
    redis_client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_subtask_cancellation_closes_pubsub_and_redis(monkeypatch) -> None:
    waiting = asyncio.Event()

    async def get_message(**kwargs):
        del kwargs
        waiting.set()
        await asyncio.Future()

    pubsub = SimpleNamespace(
        get_message=get_message,
        unsubscribe=AsyncMock(),
    )
    redis_client = SimpleNamespace(aclose=AsyncMock())
    monkeypatch.setattr(
        execution_module.session_manager,
        "get_streaming_content",
        AsyncMock(return_value=None),
    )
    monkeypatch.setattr(
        execution_module.session_manager,
        "subscribe_streaming_channel",
        AsyncMock(return_value=(redis_client, pubsub)),
    )

    stream = WebStreamExecutionService().stream(
        SUBTASK_SUBSCRIPTION_STREAM,
        {"subtask_id": 7, "offset": 0},
    )
    read_task = asyncio.create_task(anext(stream))
    await asyncio.wait_for(waiting.wait(), timeout=1)
    read_task.cancel()
    await asyncio.gather(read_task, return_exceptions=True)
    await stream.aclose()

    pubsub.unsubscribe.assert_awaited_once()
    redis_client.aclose.assert_awaited_once()


@pytest.mark.asyncio
async def test_unknown_operation_is_rejected_without_fallback() -> None:
    with pytest.raises(WebStreamRequestError, match="Unknown"):
        _ = [frame async for frame in WebStreamExecutionService().stream("unknown", {})]
    with pytest.raises(WebStreamRequestError, match="Unknown"):
        await WebStreamExecutionService().execute("unknown", {})

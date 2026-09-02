# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for worker-owned OpenAPI execution and projection."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.services.execution.router import CommunicationMode
from app.services.openapi.worker_execution import (
    OpenAPIEventProjector,
    OpenAPIStreamLimitError,
    OpenAPIWorkerExecutionService,
)
from app.services.openapi.worker_protocol import OpenAPIStreamSpec
from shared.models import EventType, ExecutionEvent, ExecutionRequest


class _UnusedSessionManager:
    async def attach_stream(self, subtask_id):
        raise AssertionError(f"callback session not expected: {subtask_id}")


class _EventDispatcher:
    def __init__(self, mode: CommunicationMode, events=None) -> None:
        self.mode = mode
        self.events = events or []
        self.worker_owned_calls = []

    def execution_mode(self, request):
        del request
        return self.mode

    async def dispatch_worker_owned(self, request, emitter) -> None:
        self.worker_owned_calls.append(request)
        for event in self.events:
            await emitter.emit(event)


def _request() -> ExecutionRequest:
    return ExecutionRequest(task_id=20, subtask_id=21, message_id=22)


def _event(event_type: EventType, **kwargs) -> ExecutionEvent:
    return ExecutionEvent.create(event_type, 20, 21, message_id=22, **kwargs)


@pytest.mark.asyncio
async def test_inprocess_sync_execution_is_dispatched_only_by_worker() -> None:
    dispatcher = _EventDispatcher(
        CommunicationMode.INPROCESS,
        events=[
            _event(EventType.CHUNK, content="answer", offset=0),
            _event(EventType.DONE, result={"value": "answer"}),
        ],
    )
    service = OpenAPIWorkerExecutionService(dispatcher, _UnusedSessionManager())

    assert service.immediate_status(_request(), background=False) is None
    outcome = await service.collect(_request())

    assert outcome.status == "completed"
    assert outcome.terminal_type == EventType.DONE.value
    assert len(dispatcher.worker_owned_calls) == 1


@pytest.mark.asyncio
async def test_polling_execution_is_queued_then_drained_by_worker() -> None:
    dispatcher = _EventDispatcher(
        CommunicationMode.POLLING,
        events=[_event(EventType.DONE)],
    )
    service = OpenAPIWorkerExecutionService(dispatcher, _UnusedSessionManager())

    assert service.immediate_status(_request(), background=False) == "queued"
    await service.run_background(_request())

    assert len(dispatcher.worker_owned_calls) == 1


def test_event_projector_owns_tool_block_text_and_reasoning_state() -> None:
    projector = OpenAPIEventProjector()

    reasoning = projector.project(_event(EventType.THINKING, content="why"))
    text = projector.project(_event(EventType.CHUNK, content="answer", offset=0))
    tool_added = projector.project(
        _event(
            EventType.TOOL_START,
            tool_use_id="call-1",
            tool_name="lookup",
            tool_input={"q": "x"},
        )
    )
    block_added = projector.project(
        _event(
            EventType.CHUNK,
            result={"blocks": [{"id": "block-1", "status": "streaming"}]},
        )
    )
    block_updated = projector.project(
        _event(
            EventType.DONE,
            result={"blocks": [{"id": "block-1", "status": "done"}]},
        )
    )

    assert reasoning[0].type == "reasoning"
    assert text[0].type == "text"
    assert tool_added[0].type == "function_call_added"
    assert block_added[0].type == "block_created"
    assert block_updated[0].type == "block_updated"


@pytest.mark.asyncio
async def test_worker_projects_complete_responses_sse() -> None:
    dispatcher = _EventDispatcher(
        CommunicationMode.INPROCESS,
        events=[
            _event(EventType.THINKING, content="why"),
            _event(EventType.CHUNK, content="answer", offset=0),
            _event(
                EventType.TOOL_START,
                tool_use_id="call-1",
                tool_name="lookup",
                tool_input={"q": "x"},
            ),
            _event(
                EventType.TOOL_RESULT,
                tool_use_id="call-1",
                tool_name="lookup",
                tool_input={"q": "x"},
                tool_output="ok",
            ),
            _event(EventType.DONE),
        ],
    )
    service = OpenAPIWorkerExecutionService(dispatcher, _UnusedSessionManager())

    payload = b"".join(
        [
            frame
            async for frame in service.stream_sse(
                _request(),
                OpenAPIStreamSpec(
                    response_id="resp_20",
                    model_string="default#team",
                    created_at=1,
                ),
            )
        ]
    )

    assert b"response.reasoning_summary_text.delta" in payload
    assert b"response.output_text.delta" in payload
    assert b"response.output_item.added" in payload
    assert b"response.completed" in payload
    assert len(dispatcher.worker_owned_calls) == 1


class _PubSub:
    def __init__(self) -> None:
        self.messages = [
            None,
            {
                "type": "message",
                "data": json.dumps({"type": "done", "task_id": 20, "subtask_id": 21}),
            },
        ]
        self.unsubscribed = False

    async def get_message(self, **kwargs):
        del kwargs
        return self.messages.pop(0)

    async def unsubscribe(self):
        self.unsubscribed = True


class _Redis:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self):
        self.closed = True


class _CallbackSessionManager:
    def __init__(self) -> None:
        self.pubsub = _PubSub()
        self.redis = _Redis()
        self.cancel_checks = 0
        self.unregistered = []
        self.deleted = []

    async def attach_stream(self, subtask_id):
        assert subtask_id == 21
        return asyncio.Event()

    async def subscribe_callback_channel(self, subtask_id):
        assert subtask_id == 21
        return self.redis, self.pubsub

    async def is_cancelled(self, subtask_id):
        assert subtask_id == 21
        self.cancel_checks += 1
        return False

    async def unregister_stream(self, subtask_id):
        self.unregistered.append(subtask_id)

    async def delete_streaming_content(self, subtask_id):
        self.deleted.append(subtask_id)
        return True


@pytest.mark.asyncio
async def test_callback_subscription_and_cancellation_checks_live_in_worker() -> None:
    dispatcher = _EventDispatcher(CommunicationMode.HTTP_CALLBACK)
    session_manager = _CallbackSessionManager()
    service = OpenAPIWorkerExecutionService(dispatcher, session_manager)

    payload = b"".join(
        [
            frame
            async for frame in service.stream_sse(
                _request(),
                OpenAPIStreamSpec(
                    response_id="resp_20",
                    model_string="default#team",
                    created_at=1,
                ),
            )
        ]
    )

    assert b"response.completed" in payload
    assert session_manager.cancel_checks == 2
    assert session_manager.pubsub.unsubscribed
    assert session_manager.redis.closed
    assert session_manager.unregistered == [21]
    assert session_manager.deleted == [21]
    assert len(dispatcher.worker_owned_calls) == 1


@pytest.mark.asyncio
async def test_callback_cancellation_projects_failed_terminal_sse_in_worker() -> None:
    dispatcher = _EventDispatcher(CommunicationMode.HTTP_CALLBACK)
    session_manager = _CallbackSessionManager()

    async def cancelled(subtask_id):
        assert subtask_id == 21
        session_manager.cancel_checks += 1
        return True

    session_manager.is_cancelled = cancelled
    service = OpenAPIWorkerExecutionService(dispatcher, session_manager)

    payload = b"".join(
        [
            frame
            async for frame in service.stream_sse(
                _request(),
                OpenAPIStreamSpec(
                    response_id="resp_20",
                    model_string="default#team",
                    created_at=1,
                ),
            )
        ]
    )

    assert b"response.failed" in payload
    assert b"Execution cancelled" in payload
    assert session_manager.cancel_checks == 1
    assert session_manager.unregistered == [21]


@pytest.mark.asyncio
async def test_worker_rejects_one_projected_sse_frame_above_bound() -> None:
    dispatcher = _EventDispatcher(
        CommunicationMode.INPROCESS,
        events=[_event(EventType.DONE)],
    )
    service = OpenAPIWorkerExecutionService(
        dispatcher,
        _UnusedSessionManager(),
        max_frame_bytes=128,
        max_total_bytes=1024,
    )

    with pytest.raises(OpenAPIStreamLimitError, match="single-frame"):
        async for _ in service.stream_sse(
            _request(),
            OpenAPIStreamSpec(
                response_id="resp_20",
                model_string="default#team",
                created_at=1,
            ),
        ):
            pass


@pytest.mark.asyncio
async def test_worker_enforces_total_stream_duration() -> None:
    cancelled = asyncio.Event()

    class BlockingDispatcher(_EventDispatcher):
        async def dispatch_worker_owned(self, request, emitter) -> None:
            self.worker_owned_calls.append(request)
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

    dispatcher = BlockingDispatcher(CommunicationMode.INPROCESS)
    service = OpenAPIWorkerExecutionService(
        dispatcher,
        _UnusedSessionManager(),
        max_duration_seconds=0.02,
    )

    with pytest.raises(OpenAPIStreamLimitError, match="total duration"):
        async for _ in service.stream_sse(
            _request(),
            OpenAPIStreamSpec(
                response_id="resp_20",
                model_string="default#team",
                created_at=1,
            ),
        ):
            pass

    await asyncio.wait_for(cancelled.wait(), timeout=1)


@pytest.mark.asyncio
async def test_worker_event_queue_applies_backpressure_at_capacity() -> None:
    third_emit_started = asyncio.Event()
    third_emit_finished = asyncio.Event()

    class BurstDispatcher(_EventDispatcher):
        async def dispatch_worker_owned(self, request, emitter) -> None:
            self.worker_owned_calls.append(request)
            await emitter.emit(_event(EventType.CHUNK, content="one", offset=0))
            await emitter.emit(_event(EventType.CHUNK, content="two", offset=1))
            third_emit_started.set()
            await emitter.emit(_event(EventType.DONE))
            third_emit_finished.set()

    dispatcher = BurstDispatcher(CommunicationMode.INPROCESS)
    service = OpenAPIWorkerExecutionService(
        dispatcher,
        _UnusedSessionManager(),
        event_queue_capacity=1,
    )
    events = service._direct_events(_request())
    try:
        assert (await anext(events)).content == "one"
        await asyncio.wait_for(third_emit_started.wait(), timeout=1)
        await asyncio.sleep(0)
        assert not third_emit_finished.is_set()

        assert (await anext(events)).content == "two"
        assert (await anext(events)).type == EventType.DONE.value
        await asyncio.wait_for(third_emit_finished.wait(), timeout=1)
    finally:
        await events.aclose()

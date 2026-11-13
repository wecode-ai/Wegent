# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the execution callback endpoints."""

from types import SimpleNamespace

import pytest

from app.api.endpoints.internal import callback as callback_module


class _RecordingEmitter:
    """Minimal emitter double that records forwarded execution events."""

    def __init__(self, **_kwargs) -> None:
        self.events = []
        self.closed = False
        self.terminal_transition_lost = False

    async def emit(self, event) -> None:
        self.events.append(event)

    async def close(self) -> None:
        self.closed = True


def _batch_payload(subtask_id: int = 18) -> list:
    return [
        {
            "event_type": "response.output_text.delta",
            "task_id": 2,
            "subtask_id": subtask_id,
            "message_id": 5,
            "data": {"type": "response.output_text.delta", "delta": "hello"},
        },
        {
            "event_type": "response.completed",
            "task_id": 2,
            "subtask_id": subtask_id,
            "message_id": 5,
            "data": {
                "type": "response.completed",
                "response": {
                    "id": "resp_2",
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "hello"}],
                        }
                    ],
                },
            },
        },
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("terminal_transition_lost", "stored_status"),
    [(False, "COMPLETED"), (True, "CANCELLED"), (True, "COMPLETED")],
)
async def test_batch_callback_publishes_events_for_openapi_streams(
    monkeypatch,
    terminal_transition_lost,
    stored_status,
):
    """Batch callbacks must reach active v1/responses SSE consumers."""
    published: list[tuple[int, str]] = []

    async def _publish(subtask_id: int, event) -> bool:
        published.append((subtask_id, event.type))
        return True

    monkeypatch.setattr(
        callback_module.session_manager,
        "publish_callback_event",
        _publish,
    )

    async def _publish_terminal(event) -> None:
        if terminal_transition_lost:
            assert event.result == {"value": "committed"}
        await _publish(event.subtask_id, event)

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(
        callback_module, "_publish_terminal_callback", _publish_terminal
    )
    monkeypatch.setattr(callback_module, "SessionLocal", Session)
    monkeypatch.setattr(
        callback_module.subtask_store,
        "get_basic_by_id_for_update",
        lambda *_args, **_kwargs: SimpleNamespace(
            task_id=2,
            status=SimpleNamespace(value=stored_status),
            result={"value": "committed"},
            error_message=None,
        ),
    )
    monkeypatch.setattr(callback_module, "WebSocketResultEmitter", _RecordingEmitter)

    class RecordingStatusEmitter(_RecordingEmitter):
        async def emit(self, event) -> None:
            await super().emit(event)
            self.terminal_transition_lost = (
                terminal_transition_lost and event.type == "done"
            )

    monkeypatch.setattr(
        callback_module, "StatusUpdatingEmitter", RecordingStatusEmitter
    )
    monkeypatch.setattr(
        callback_module,
        "_get_task_status_user_id",
        lambda task_id, event_type: None,
    )

    response = await callback_module.handle_batch_callback(
        [callback_module.CallbackRequest(**item) for item in _batch_payload()]
    )

    assert response.status == "ok"
    expected_events = [(18, "chunk")]
    if stored_status == "COMPLETED":
        expected_events.append((18, "done"))
    assert published == expected_events

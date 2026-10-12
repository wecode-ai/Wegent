# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the execution callback endpoints."""

import pytest

from app.api.endpoints.internal import callback as callback_module


class _RecordingEmitter:
    """Minimal emitter double that records forwarded execution events."""

    def __init__(self, **_kwargs) -> None:
        self.events = []
        self.closed = False

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
async def test_batch_callback_publishes_events_for_openapi_streams(
    monkeypatch,
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
    monkeypatch.setattr(callback_module, "WebSocketResultEmitter", _RecordingEmitter)
    monkeypatch.setattr(callback_module, "StatusUpdatingEmitter", _RecordingEmitter)
    monkeypatch.setattr(
        callback_module,
        "_get_task_status_user_id",
        lambda task_id, event_type: None,
    )

    response = await callback_module.handle_batch_callback(
        [callback_module.CallbackRequest(**item) for item in _batch_payload()]
    )

    assert response.status == "ok"
    assert published == [(18, "chunk"), (18, "done")]

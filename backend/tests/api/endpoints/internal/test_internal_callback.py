# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.api.endpoints.internal import callback
from shared.models.responses_api import ResponsesAPIStreamEvents


class _SessionContext:
    def __init__(self, session, state):
        self._session = session
        self._state = state

    def __enter__(self):
        self._state["open"] = True
        return self._session

    def __exit__(self, exc_type, exc, traceback):
        self._state["open"] = False


def _patch_emitters(monkeypatch, state):
    emitter = SimpleNamespace(
        emit=AsyncMock(
            side_effect=lambda event: (
                pytest.fail("database session remained open during async emit")
                if state["open"]
                else None
            )
        ),
        close=AsyncMock(),
    )
    monkeypatch.setattr(callback, "WebSocketResultEmitter", lambda **kwargs: object())
    monkeypatch.setattr(callback, "StatusUpdatingEmitter", lambda **kwargs: emitter)
    monkeypatch.setattr(
        callback.session_manager,
        "publish_callback_event",
        AsyncMock(return_value=True),
    )
    monkeypatch.setattr(
        callback,
        "forward_event_to_channel_callbacks",
        AsyncMock(),
    )
    return emitter


@pytest.mark.asyncio
async def test_streaming_callback_does_not_open_database_session(monkeypatch):
    state = {"open": False}
    emitter = _patch_emitters(monkeypatch, state)
    monkeypatch.setattr(
        callback,
        "SessionLocal",
        lambda: pytest.fail("streaming callback must not open a database session"),
    )

    response = await callback.handle_callback(
        callback.CallbackRequest(
            event_type=ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
            task_id=1,
            subtask_id=2,
            data={"delta": "thinking"},
        )
    )

    assert response.status == "ok"
    emitter.emit.assert_awaited_once()


@pytest.mark.asyncio
async def test_terminal_callback_closes_database_before_async_emit(monkeypatch):
    state = {"open": False}
    session = object()
    emitter = _patch_emitters(monkeypatch, state)
    monkeypatch.setattr(
        callback,
        "SessionLocal",
        lambda: _SessionContext(session, state),
    )
    monkeypatch.setattr(
        callback.task_store,
        "get_task_by_states",
        lambda db, **kwargs: SimpleNamespace(user_id=7),
    )

    response = await callback.handle_callback(
        callback.CallbackRequest(
            event_type=ResponsesAPIStreamEvents.ERROR.value,
            task_id=1,
            subtask_id=2,
            data={"message": "failed", "code": "runtime_error"},
        )
    )

    assert response.status == "ok"
    assert state["open"] is False
    emitter.emit.assert_awaited_once()

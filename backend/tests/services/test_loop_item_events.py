# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
from concurrent.futures import Future
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from app.services import loop_item_events


class _OpenLoop:
    @staticmethod
    def is_closed() -> bool:
        return False


class _Socket:
    def __init__(self) -> None:
        self.emissions: list[dict[str, Any]] = []

    async def emit(
        self,
        event: str,
        payload: dict[str, Any],
        *,
        room: str,
        namespace: str,
    ) -> None:
        self.emissions.append(
            {
                "event": event,
                "payload": payload,
                "room": room,
                "namespace": namespace,
            }
        )


class _Item:
    def __init__(self) -> None:
        self.detached = False

    def _value(self, value: Any) -> Any:
        if self.detached:
            raise AssertionError("detached item accessed")
        return value

    @property
    def cloud_project_id(self) -> str:
        return self._value("project-1")

    @property
    def id(self) -> str:
        return self._value("issue-1")

    @property
    def version(self) -> int:
        return self._value(3)

    @property
    def created_by_user_id(self) -> int:
        return self._value(7)


def test_publish_loop_item_changed_snapshots_item_before_async_emit(
    monkeypatch: Any,
) -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    item = _Item()
    scheduled: list[Any] = []
    future: Future[None] = Future()
    socket = _Socket()

    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: _OpenLoop())
    monkeypatch.setattr(
        asyncio,
        "run_coroutine_threadsafe",
        lambda coroutine, loop: scheduled.append(coroutine) or future,
    )
    monkeypatch.setattr("app.core.socketio.get_sio", lambda: socket)

    loop_item_events.publish_loop_item_changed(
        db,
        item=item,
        reason="execution_updated",
        actor_user_id=7,
    )
    assert len(scheduled) == 1

    item.detached = True

    asyncio.run(scheduled[0])
    future.set_result(None)

    assert socket.emissions == [
        {
            "event": loop_item_events.LOOP_ITEM_CHANGED_EVENT,
            "payload": {
                "projectId": "project-1",
                "itemId": "issue-1",
                "version": 3,
                "reason": "execution_updated",
            },
            "room": "wework-runtime:user:7",
            "namespace": "/wework-runtime",
        }
    ]


@pytest.mark.parametrize(
    ("loop", "creator_id", "cause"),
    [
        (None, 7, "loop_unavailable"),
        (SimpleNamespace(is_closed=lambda: True), 7, "loop_closed"),
        (_OpenLoop(), 0, "no_recipients"),
    ],
)
def test_publish_loop_item_changed_explains_skipped_delivery(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    loop: Any,
    creator_id: int,
    cause: str,
) -> None:
    caplog.set_level("INFO", logger=loop_item_events.__name__)
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    schedule = MagicMock()
    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: loop)
    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", schedule)

    loop_item_events.publish_loop_item_changed(
        db,
        item=SimpleNamespace(
            cloud_project_id="project-1",
            id="issue-1",
            version=3,
            created_by_user_id=creator_id,
        ),
        reason="user_update",
        actor_user_id=creator_id,
    )

    schedule.assert_not_called()
    assert any(f"cause={cause}" in message for message in caplog.messages)


def test_publish_loop_item_changed_logs_failed_delivery_without_raising(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO", logger=loop_item_events.__name__)
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []
    future: Future[None] = Future()

    def schedule(coroutine: Any, loop: Any) -> Future[None]:
        coroutine.close()
        return future

    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: _OpenLoop())
    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", schedule)
    loop_item_events.publish_loop_item_changed(
        db, item=_Item(), reason="user_update", actor_user_id=7
    )

    future.set_exception(RuntimeError("socket unavailable"))

    assert "emit_failed" in caplog.messages[-1]
    assert isinstance(caplog.records[-1].exc_info[1], RuntimeError)


def test_publish_loop_item_changed_logs_failed_schedule_without_raising(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.all.return_value = []

    def schedule(coroutine: Any, loop: Any) -> None:
        coroutine.close()
        raise RuntimeError("loop unavailable")

    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: _OpenLoop())
    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", schedule)

    loop_item_events.publish_loop_item_changed(
        db, item=_Item(), reason="user_update", actor_user_id=7
    )

    assert "schedule_failed" in caplog.messages[-1]
    assert isinstance(caplog.records[-1].exc_info[1], RuntimeError)

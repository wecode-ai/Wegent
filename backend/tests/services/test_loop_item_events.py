# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
from typing import Any
from unittest.mock import MagicMock

from app.services import loop_item_events


class _ScheduledFuture:
    def add_done_callback(self, callback: Any) -> None:
        del callback


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
    socket = _Socket()

    monkeypatch.setattr(loop_item_events, "get_socketio_loop", lambda: _OpenLoop())
    monkeypatch.setattr(
        asyncio,
        "run_coroutine_threadsafe",
        lambda coroutine, loop: scheduled.append(coroutine) or _ScheduledFuture(),
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

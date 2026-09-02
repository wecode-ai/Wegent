# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.events import MemoryCreatedEvent
from app.services.pet import event_handlers


@pytest.mark.asyncio
async def test_memory_pet_update_does_not_block_event_loop_and_closes_db(
    monkeypatch,
):
    entered = threading.Event()
    release = threading.Event()
    session = SimpleNamespace(closed=False)
    emitter = SimpleNamespace(emit_pet_traits_updated=AsyncMock())

    def close() -> None:
        session.closed = True

    session.close = close

    def blocking_update(db, user_id, memory_texts):
        assert db is session
        assert user_id == 7
        assert memory_texts == ["python"]
        entered.set()
        assert release.wait(timeout=1)
        return (
            SimpleNamespace(
                json={"spec": {"appearanceTraits": {"domain": "engineer"}}}
            ),
            True,
        )

    async def emit_traits(**kwargs) -> None:
        assert session.closed is True
        assert kwargs == {
            "user_id": 7,
            "traits": {"domain": "engineer"},
        }

    emitter.emit_pet_traits_updated.side_effect = emit_traits
    monkeypatch.setattr(event_handlers, "SessionLocal", lambda: session)
    monkeypatch.setattr(
        event_handlers.pet_service,
        "update_domain_from_memories",
        blocking_update,
    )
    monkeypatch.setattr(
        "app.services.chat.webpage_ws_extended_emitter.get_extended_emitter",
        lambda: emitter,
    )
    task = asyncio.create_task(
        event_handlers.handle_memory_created(
            MemoryCreatedEvent(
                user_id=7,
                memory_count=1,
                memory_texts=["python"],
            )
        )
    )

    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.001)
        assert entered.is_set()

        loop_tick = asyncio.Event()
        asyncio.get_running_loop().call_soon(loop_tick.set)
        await asyncio.wait_for(loop_tick.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    await task
    emitter.emit_pet_traits_updated.assert_awaited_once()

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import threading
from unittest.mock import AsyncMock

import pytest

from app.services.chat import webpage_ws_chat_emitter as emitter_module
from app.services.chat.webpage_ws_extended_emitter import ExtendedEventEmitter
from app.utils import client_payload_sanitizer as sanitizer_module


@pytest.mark.asyncio
async def test_extended_emit_waits_for_socketio_delivery(monkeypatch) -> None:
    publish_started = asyncio.Event()
    release_publish = asyncio.Event()

    async def controlled_emit(*args, **kwargs) -> None:
        publish_started.set()
        await release_publish.wait()

    ws_emitter = emitter_module.WebPageSocketEmitter(AsyncMock())
    ws_emitter.sio.emit.side_effect = controlled_emit
    emitter = ExtendedEventEmitter()
    monkeypatch.setattr(emitter, "_get_ws_emitter", lambda: ws_emitter)

    emit_task = asyncio.create_task(
        emitter.emit_pet_experience_gained(
            user_id=7,
            amount=1,
            total=2,
            source="chat",
        )
    )
    await asyncio.wait_for(publish_started.wait(), timeout=0.2)
    assert not emit_task.done()

    release_publish.set()
    await emit_task


@pytest.mark.asyncio
async def test_large_result_sanitization_does_not_block_event_loop(
    monkeypatch,
) -> None:
    sanitize_started = threading.Event()
    release_sanitize = threading.Event()

    def blocking_sanitize(payload):
        del payload
        sanitize_started.set()
        assert release_sanitize.wait(timeout=1)
        return {"safe": True}

    monkeypatch.setattr(
        sanitizer_module,
        "sanitize_client_payload",
        blocking_sanitize,
    )
    sio = AsyncMock()
    emitter = emitter_module.WebPageSocketEmitter(sio)
    emit_task = asyncio.create_task(
        emitter.emit_chat_done(
            task_id=1,
            subtask_id=2,
            offset=3,
            result={"value": "x" * (64 * 1024)},
        )
    )
    for _ in range(100):
        if sanitize_started.is_set():
            break
        await asyncio.sleep(0.001)
    assert sanitize_started.is_set()

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.1)
    assert not emit_task.done()

    release_sanitize.set()
    await emit_task
    assert sio.emit.await_args.args[1]["result"] == {"safe": True}

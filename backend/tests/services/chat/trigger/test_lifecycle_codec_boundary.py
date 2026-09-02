# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Event-loop boundary for terminal result assembly."""

import asyncio
import threading
from typing import Any
from unittest.mock import AsyncMock

import pytest

import app.services.chat.storage as chat_storage
from app.services.chat.trigger import lifecycle

_LARGE_TEXT = "x" * (70 * 1024)


@pytest.mark.asyncio
async def test_large_completed_result_merge_does_not_block_loop(monkeypatch) -> None:
    monkeypatch.setattr(
        chat_storage.session_manager,
        "get_accumulated_content",
        AsyncMock(return_value=""),
    )
    monkeypatch.setattr(
        chat_storage.session_manager,
        "finalize_and_get_blocks",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        lifecycle,
        "_get_existing_subtask_result",
        AsyncMock(return_value={}),
    )
    started = threading.Event()
    release = threading.Event()
    original = lifecycle._assemble_completed_result

    def blocking_assemble(*args: Any):
        started.set()
        release.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(lifecycle, "_assemble_completed_result", blocking_assemble)
    task = asyncio.create_task(
        lifecycle.collect_completed_result(
            101,
            status="COMPLETED",
            result={"value": _LARGE_TEXT},
        )
    )
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.005)
        else:
            pytest.fail("terminal result codec worker did not start")

        progressed = asyncio.Event()
        asyncio.get_running_loop().call_soon(progressed.set)
        await asyncio.wait_for(progressed.wait(), timeout=0.1)
        assert not task.done()
    finally:
        release.set()

    assert await task == {"value": _LARGE_TEXT}

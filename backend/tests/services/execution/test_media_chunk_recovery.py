# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Media placeholders must be recoverable without replaying socket events."""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.chat.storage.session import SessionManager
from app.services.execution.emitters.status_updating import StatusUpdatingEmitter
from shared.models import EventType, ExecutionEvent
from tests.services.chat.storage.test_session_blocks import FakeCache, FakeRedisClient


@pytest.mark.asyncio
@pytest.mark.parametrize("media_type", ["image", "video"])
async def test_media_chunks_preserve_latest_block_for_refresh(media_type: str) -> None:
    session_manager = SessionManager()
    session_manager._cache = FakeCache(FakeRedisClient())
    wrapped = AsyncMock()
    emitter = StatusUpdatingEmitter(wrapped=wrapped, task_id=101, subtask_id=202)
    block = {
        "id": f"{media_type}-1",
        "type": media_type,
        "status": "streaming",
        "is_placeholder": True,
        "content": "",
        "timestamp": 1789611825000,
    }
    if media_type == "image":
        block.update(image_urls=[], image_size="1512x648")
    else:
        block.update(video_url="", video_progress=5)

    with patch("app.services.chat.storage.session_manager", session_manager):
        for progress in (5, 35):
            if media_type == "video":
                block["video_progress"] = progress
            event = ExecutionEvent(
                type=EventType.CHUNK,
                task_id=101,
                subtask_id=202,
                content="",
                result={"blocks": [dict(block)]},
            )
            await emitter.emit(event)

            assert await session_manager.get_blocks(202) == [block]
            wrapped.emit.assert_awaited_with(event)

    assert await session_manager.get_streaming_content(202) in (None, "")


@pytest.mark.asyncio
async def test_media_chunk_cancels_pending_flush_before_storing_block() -> None:
    session_manager = SessionManager()
    session_manager._cache = FakeCache(FakeRedisClient())
    emitter = StatusUpdatingEmitter(wrapped=AsyncMock(), task_id=101, subtask_id=202)
    call_order = []
    original_add_block = session_manager.add_block

    async def record_flush() -> None:
        call_order.append("flush")

    async def record_cancel() -> None:
        call_order.append("cancel")

    async def record_add_block(subtask_id: int, block: dict) -> None:
        call_order.append("add_block")
        await original_add_block(subtask_id, block)

    event = ExecutionEvent(
        type=EventType.CHUNK,
        task_id=101,
        subtask_id=202,
        content="",
        result={
            "blocks": [
                {
                    "id": "image-1",
                    "type": "image",
                    "status": "streaming",
                    "is_placeholder": True,
                }
            ]
        },
    )

    with (
        patch("app.services.chat.storage.session_manager", session_manager),
        patch.object(emitter, "_flush_stream_storage", new=record_flush),
        patch.object(emitter, "_cancel_pending_storage_flush_task", new=record_cancel),
        patch.object(session_manager, "add_block", new=record_add_block),
    ):
        await emitter.emit(event)

    assert call_order == ["flush", "cancel", "add_block"]


@pytest.mark.asyncio
@pytest.mark.parametrize("media_type", ["image", "video"])
async def test_completed_media_replaces_cached_placeholder(media_type: str) -> None:
    session_manager = SessionManager()
    session_manager._cache = FakeCache(FakeRedisClient())
    emitter = StatusUpdatingEmitter(wrapped=AsyncMock(), task_id=101, subtask_id=202)
    placeholder = {
        "id": "media-1",
        "type": media_type,
        "status": "streaming",
        "is_placeholder": True,
        "timestamp": 1789611825000,
    }
    await session_manager.add_block(202, placeholder)
    completed = {
        **placeholder,
        "status": "done",
        "is_placeholder": False,
        **(
            {"image_urls": ["/generated.png"], "image_count": 1}
            if media_type == "image"
            else {"video_url": "/generated.mp4", "video_progress": 100}
        ),
    }
    done = ExecutionEvent(
        type=EventType.DONE,
        task_id=101,
        subtask_id=202,
        result={"blocks": [completed]},
    )
    with (
        patch("app.services.chat.storage.session_manager", session_manager),
        patch(
            "app.services.chat.trigger.lifecycle._get_existing_subtask_result",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "app.services.execution.emitters.status_updating.persist_completed_result",
            new=AsyncMock(),
        ) as persist,
        patch.object(emitter, "_publish_task_completed_event", new=AsyncMock()),
    ):
        await emitter.emit(done)

    assert done.result["blocks"] == [completed]
    assert persist.call_args.kwargs["result"]["blocks"] == [completed]

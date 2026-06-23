# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Weibo streaming response emitter."""

from __future__ import annotations

import logging
from typing import Optional

from app.core.cache import cache_manager
from app.services.channels.weibo.sender import WeiboSender, generate_weibo_message_id
from app.services.execution.emitters import ResultEmitter
from shared.models import EventType, ExecutionEvent

logger = logging.getLogger(__name__)

MAX_WEIBO_CHUNK_CHARS = 1800
STREAM_COUNTER_TTL_SECONDS = 60 * 60


class WeiboStreamingResponseEmitter(ResultEmitter):
    """Stream assistant output to Weibo with stable messageId and chunkId."""

    def __init__(
        self,
        *,
        channel_id: int,
        to_user_id: str,
        sender: WeiboSender,
        cache=cache_manager,
    ):
        self._channel_id = channel_id
        self._to_user_id = to_user_id
        self._sender = sender
        self._cache = cache
        self._message_id: Optional[str] = None
        self._sent_content = ""
        self._finished = False

    async def emit(self, event: ExecutionEvent) -> None:
        event_type = (
            event.type.value if isinstance(event.type, EventType) else event.type
        )
        if event_type == EventType.START.value:
            await self.emit_start(event.task_id, event.subtask_id, event.message_id)
        elif event_type in {EventType.CHUNK.value, EventType.THINKING.value}:
            await self.emit_chunk(
                event.task_id,
                event.subtask_id,
                event.content or "",
                event.offset,
            )
        elif event_type == EventType.DONE.value:
            await self.emit_done(event.task_id, event.subtask_id, event.result)
        elif event_type == EventType.ERROR.value:
            await self.emit_error(
                event.task_id,
                event.subtask_id,
                event.error or "Unknown error",
            )
        elif event_type in {EventType.CANCEL.value, EventType.CANCELLED.value}:
            await self.emit_cancelled(event.task_id, event.subtask_id)

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        self._ensure_message_id(task_id, subtask_id)

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        if self._finished or not content:
            return

        self._ensure_message_id(task_id, subtask_id)
        await self._send_text_parts(content, done=False)
        self._sent_content += content

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        if self._finished:
            return

        self._ensure_message_id(task_id, subtask_id)
        tail = self._extract_unsent_tail(result)
        if tail:
            await self._send_text_parts(tail, done=True)
            self._sent_content += tail
        else:
            await self._send_one("", done=True)
        self._finished = True

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        if self._finished:
            return

        self._ensure_message_id(task_id, subtask_id)
        await self._send_text_parts(f"任务执行失败: {error}", done=True)
        self._finished = True

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        await self.emit_error(task_id, subtask_id, "任务已取消")

    async def close(self) -> None:
        self._finished = True

    def _ensure_message_id(self, task_id: int, subtask_id: int) -> str:
        if self._message_id is None:
            self._message_id = generate_weibo_message_id()
        return self._message_id

    def _extract_unsent_tail(self, result: Optional[dict]) -> str:
        if not result or not isinstance(result, dict):
            return ""

        final_value = result.get("value") or result.get("output") or ""
        if final_value and not isinstance(final_value, str):
            final_value = str(final_value)
        if not isinstance(final_value, str) or not final_value:
            return ""

        if final_value.startswith(self._sent_content):
            return final_value[len(self._sent_content) :]

        if final_value != self._sent_content:
            logger.warning(
                "[WeiboEmitter] Final result is not monotonic for message_id=%s",
                self._message_id,
            )
            return final_value
        return ""

    async def _send_text_parts(self, text: str, *, done: bool) -> None:
        parts = [
            text[index : index + MAX_WEIBO_CHUNK_CHARS]
            for index in range(0, len(text), MAX_WEIBO_CHUNK_CHARS)
        ] or [""]
        for index, part in enumerate(parts):
            await self._send_one(part, done=done and index == len(parts) - 1)

    async def _send_one(self, text: str, *, done: bool) -> None:
        if not self._message_id:
            raise RuntimeError("Weibo stream message_id is not initialized")

        chunk_id = await self._next_chunk_id()
        sent = await self._sender.send_stream_chunk(
            to_user_id=self._to_user_id,
            text=text,
            message_id=self._message_id,
            chunk_id=chunk_id,
            done=done,
        )
        logger.info(
            "[WeiboEmitter] Sent stream chunk: to_user_id=%s message_id=%s "
            "chunk_id=%s done=%s text_len=%s success=%s",
            self._to_user_id,
            self._message_id,
            chunk_id,
            done,
            len(text),
            sent,
        )
        if not sent:
            raise RuntimeError("Failed to send Weibo stream chunk")

    async def _next_chunk_id(self) -> int:
        if not self._message_id:
            raise RuntimeError("Weibo stream message_id is not initialized")

        key = f"weibo:stream_chunk:{self._message_id}"
        redis_client = await self._cache._get_client()
        try:
            value = await redis_client.incr(key)
            await redis_client.expire(key, STREAM_COUNTER_TTL_SECONDS)
            return int(value) - 1
        finally:
            await redis_client.aclose()

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feishu response emitter."""

import logging
from typing import Optional

from app.services.channels.feishu.sender import FeishuBotSender
from shared.models import ExecutionEvent

logger = logging.getLogger(__name__)


class StreamingResponseEmitter:
    """A lightweight emitter that sends final content to Feishu."""

    def __init__(self, sender: FeishuBotSender, chat_id: str):
        self._sender = sender
        self._chat_id = chat_id
        self._buffer = ""

    async def emit(self, event: ExecutionEvent) -> None:
        if event.type == "response.output_text.delta":
            self._buffer += event.data.get("delta", "") if event.data else ""
        elif event.type == "response.completed":
            await self.emit_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
            )
        elif event.type == "response.failed":
            await self.emit_error(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                error=(
                    event.data.get("error", "unknown error")
                    if event.data
                    else "unknown error"
                ),
            )

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        return None

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        self._buffer += content

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        text = self._buffer.strip() or "任务已完成"
        await self._sender.send_text_message(self._chat_id, text)

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        await self._sender.send_text_message(self._chat_id, f"执行失败: {error}")

    async def emit_cancelled(self, task_id: int, subtask_id: int, **kwargs) -> None:
        await self._sender.send_text_message(self._chat_id, "任务已取消")

    async def close(self) -> None:
        return None

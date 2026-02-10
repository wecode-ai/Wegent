# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for DingTalk Stream.

This module provides ResultEmitter implementations for DingTalk:
- SyncResponseEmitter: Re-exported from generic emitter module
- StreamingResponseEmitter: DingTalk-specific streaming via AI Card
"""

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Dict, Optional

# Re-export SyncResponseEmitter from generic module for backward compatibility
from app.services.channels.emitter import SyncResponseEmitter
from app.services.execution.emitters import ResultEmitter
from shared.models import ExecutionEvent

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)

# Export both for backward compatibility
__all__ = ["SyncResponseEmitter", "StreamingResponseEmitter"]


class StreamingResponseEmitter(ResultEmitter):
    """Streaming response emitter for DingTalk using AI Card.

    This emitter uses DingTalk's AIMarkdownCardInstance to send streaming
    updates to the user, providing a typewriter-like experience.

    Usage:
        emitter = StreamingResponseEmitter(dingtalk_client, incoming_message)
        # ... trigger AI response with this emitter ...
        # The emitter will automatically send streaming updates to DingTalk
    """

    # Minimum interval between streaming updates (in seconds)
    # DingTalk has rate limits, so we throttle updates
    MIN_UPDATE_INTERVAL = 0.8

    def __init__(
        self,
        dingtalk_client: "DingTalkStreamClient",
        incoming_message: "ChatbotMessage",
    ):
        """Initialize StreamingResponseEmitter.

        Args:
            dingtalk_client: DingTalk stream client instance
            incoming_message: The incoming message to reply to
        """
        from dingtalk_stream import AIMarkdownCardInstance

        self._dingtalk_client = dingtalk_client
        self._incoming_message = incoming_message
        # Use official AIMarkdownCardInstance for streaming
        self._card = AIMarkdownCardInstance(dingtalk_client, incoming_message)
        # Simplify the card layout - only show content, remove unused fields
        self._card.set_order(["msgContent"])
        self._full_content = ""
        self._last_update_time = 0.0
        self._pending_content = ""
        self._started = False
        self._finished = False

    async def _ensure_card_started(self) -> bool:
        """Ensure the AI card is created and started.

        Returns:
            True if card is ready, False if creation failed
        """
        if self._started:
            return True

        try:
            # Use the official SDK method to start the card
            logger.info("[StreamingEmitter] Starting AI card...")
            self._card.ai_start()

            if not self._card.card_instance_id:
                logger.error(
                    "[StreamingEmitter] Failed to create AI card - no instance ID returned"
                )
                return False

            self._started = True
            logger.info(
                f"[StreamingEmitter] AI card started successfully, "
                f"instance_id={self._card.card_instance_id}"
            )
            return True

        except Exception as e:
            logger.exception(f"[StreamingEmitter] Failed to start AI card: {e}")
            return False

    async def _send_streaming_update(self, content: str, force: bool = False) -> None:
        """Send a streaming update to the AI card.

        Args:
            content: The content to send (will be accumulated)
            force: If True, send immediately regardless of throttling
        """
        if self._finished or not self._card.card_instance_id:
            return

        current_time = time.time()
        time_since_last = current_time - self._last_update_time

        # Accumulate content
        self._pending_content += content

        # Check if we should send an update
        if not force and time_since_last < self.MIN_UPDATE_INTERVAL:
            return

        # Send the update
        if self._pending_content:
            try:
                # Accumulate to full content
                self._full_content += self._pending_content

                logger.debug(
                    f"[StreamingEmitter] Sending streaming update, "
                    f"content_len={len(self._full_content)}"
                )

                # Use official SDK streaming method
                self._card.ai_streaming(self._full_content, append=False)

                self._pending_content = ""
                self._last_update_time = current_time
            except Exception as e:
                logger.exception(
                    f"[StreamingEmitter] Failed to send streaming update: {e}"
                )

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit a single event.

        Args:
            event: Execution event to emit
        """
        from shared.models import EventType

        if event.type == EventType.START:
            await self.emit_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
            )
        elif event.type == EventType.CHUNK:
            await self.emit_chunk(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content or "",
                offset=event.offset,
            )
        elif event.type == EventType.DONE:
            await self.emit_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                result=event.result,
            )
        elif event.type == EventType.ERROR:
            await self.emit_error(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                error=event.error or "Unknown error",
            )

    async def emit_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        **kwargs,
    ) -> None:
        """Emit start event - create and start the AI card."""
        logger.info(f"[StreamingEmitter] start task={task_id} subtask={subtask_id}")
        await self._ensure_card_started()

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Emit chunk event - send streaming update to DingTalk."""
        if not content:
            return

        # Ensure card is started
        if not await self._ensure_card_started():
            return

        # Use throttling to reduce API calls
        await self._send_streaming_update(content)

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Emit done event - finalize the AI card."""
        if self._finished:
            logger.warning("[StreamingEmitter] emit_done called but already finished")
            return

        logger.info(
            f"[StreamingEmitter] done task={task_id} subtask={subtask_id} "
            f"full_content_len={len(self._full_content)}, pending_len={len(self._pending_content)}"
        )

        try:
            # Ensure card is started
            if not await self._ensure_card_started():
                logger.error("[StreamingEmitter] Cannot finish - card not started")
                return

            # Send any remaining pending content
            if self._pending_content:
                self._full_content += self._pending_content
                self._pending_content = ""

            # IMPORTANT: Send the final complete content via ai_streaming before ai_finish
            # DingTalk AI Card requires the last streaming update to contain the full content
            # before calling ai_finish, otherwise the card may show truncated content
            self._card.ai_streaming(self._full_content, append=False)

            # Small delay to ensure streaming update is processed before finish
            await asyncio.sleep(0.1)

            # Finalize the card using official SDK
            self._card.ai_finish(self._full_content)
            self._finished = True
            logger.info("[StreamingEmitter] AI card finished successfully")

        except Exception as e:
            logger.exception(f"[StreamingEmitter] Failed to finish AI card: {e}")

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Emit error event - mark the AI card as failed."""
        if self._finished:
            return

        logger.warning(
            f"[StreamingEmitter] error task={task_id} subtask={subtask_id} "
            f"error={error}"
        )

        try:
            # Ensure card is started
            if not await self._ensure_card_started():
                return

            # Mark card as failed using official SDK
            self._card.ai_fail()
            self._finished = True

        except Exception as e:
            logger.exception(
                f"[StreamingEmitter] Failed to mark AI card as failed: {e}"
            )

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Emit cancelled event - mark the AI card as cancelled."""
        if self._finished:
            return

        logger.info(f"[StreamingEmitter] cancelled task={task_id} subtask={subtask_id}")

        try:
            # Ensure card is started
            if not await self._ensure_card_started():
                return

            # Add cancellation note to content
            self._full_content += "\n\n⚠️ 任务已取消"

            # Send final content and finish the card
            self._card.ai_streaming(self._full_content, append=False)
            await asyncio.sleep(0.1)
            self._card.ai_finish(self._full_content)
            self._finished = True

        except Exception as e:
            logger.exception(
                f"[StreamingEmitter] Failed to mark AI card as cancelled: {e}"
            )

    async def close(self) -> None:
        """Close the emitter and release resources."""
        pass

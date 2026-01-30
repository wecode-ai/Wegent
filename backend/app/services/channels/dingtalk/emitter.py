# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for DingTalk Stream.

This module provides ChatEventEmitter implementations for DingTalk:
- SyncResponseEmitter: Collects complete response before replying
- StreamingResponseEmitter: Sends streaming updates via DingTalk AI Card
"""

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Dict, Optional

from app.services.chat.trigger.emitter import ChatEventEmitter

if TYPE_CHECKING:
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.stream import DingTalkStreamClient

logger = logging.getLogger(__name__)


class SyncResponseEmitter(ChatEventEmitter):
    """Synchronous response collector emitter.

    Used for external channel integrations (DingTalk, Slack, etc.) that need
    to wait for the complete AI response before replying. This emitter collects
    streaming chunks and signals completion via an asyncio.Event.

    Usage:
        emitter = SyncResponseEmitter()
        # ... trigger AI response with this emitter ...
        response = await emitter.wait_for_response()
    """

    def __init__(self):
        """Initialize SyncResponseEmitter."""
        self._response_chunks: list[str] = []
        self._complete_event = asyncio.Event()
        self._result: Optional[Dict[str, Any]] = None
        self._error: Optional[str] = None

    async def wait_for_response(self) -> str:
        """Wait for the complete response.

        Returns:
            Complete response text

        Raises:
            RuntimeError: If an error occurred during streaming
        """
        await self._complete_event.wait()

        if self._error:
            raise RuntimeError(self._error)

        return "".join(self._response_chunks)

    def get_result(self) -> Optional[Dict[str, Any]]:
        """Get the result dictionary from chat:done event.

        Returns:
            Result dictionary or None
        """
        return self._result

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Emit chat:start event."""
        logger.debug(
            f"[SyncEmitter] chat:start task={task_id} subtask={subtask_id} "
            f"shell_type={shell_type}"
        )

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit chat:chunk event - collect chunk content."""
        if content:
            self._response_chunks.append(content)

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:done event - signal completion."""
        self._result = result
        logger.debug(
            f"[SyncEmitter] chat:done task={task_id} subtask={subtask_id} "
            f"total_chunks={len(self._response_chunks)}"
        )
        self._complete_event.set()

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event - signal error."""
        self._error = error
        logger.warning(
            f"[SyncEmitter] chat:error task={task_id} subtask={subtask_id} error={error}"
        )
        self._complete_event.set()

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event - signal cancellation."""
        self._error = "Response was cancelled"
        logger.debug(
            f"[SyncEmitter] chat:cancelled task={task_id} subtask={subtask_id}"
        )
        self._complete_event.set()

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """Emit chat:bot_complete event (no-op for sync emitter)."""
        logger.debug(
            f"[SyncEmitter] chat:bot_complete user={user_id} task={task_id} "
            f"subtask={subtask_id} (skipped)"
        )


class StreamingResponseEmitter(ChatEventEmitter):
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

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Emit chat:start event - create and start the AI card."""
        logger.info(
            f"[StreamingEmitter] chat:start task={task_id} subtask={subtask_id}"
        )
        await self._ensure_card_started()

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Emit chat:chunk event - send streaming update to DingTalk."""
        if not content:
            return

        # Ensure card is started
        if not await self._ensure_card_started():
            return

        # Use throttling to reduce API calls
        await self._send_streaming_update(content)

    async def emit_chat_done(
        self,
        task_id: int,
        subtask_id: int,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:done event - finalize the AI card."""
        if self._finished:
            logger.warning(
                "[StreamingEmitter] emit_chat_done called but already finished"
            )
            return

        logger.info(
            f"[StreamingEmitter] chat:done task={task_id} subtask={subtask_id} "
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

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event - mark the AI card as failed."""
        if self._finished:
            return

        logger.warning(
            f"[StreamingEmitter] chat:error task={task_id} subtask={subtask_id} "
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

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event - finalize the AI card with partial content."""
        if self._finished:
            return

        logger.info(
            f"[StreamingEmitter] chat:cancelled task={task_id} subtask={subtask_id}"
        )

        try:
            # Ensure card is started
            if not await self._ensure_card_started():
                return

            # Send any remaining content and finish
            if self._pending_content:
                self._full_content += self._pending_content
                self._pending_content = ""

            # Add cancellation note and finish
            self._full_content += "\n\n*(Cancelled)*"

            # Send final streaming update before finish
            self._card.ai_streaming(self._full_content, append=False)
            await asyncio.sleep(0.1)

            self._card.ai_finish(self._full_content)
            self._finished = True

        except Exception as e:
            logger.exception(f"[StreamingEmitter] Failed to cancel AI card: {e}")

    async def emit_chat_bot_complete(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        content: str,
        result: Dict[str, Any],
    ) -> None:
        """Emit chat:bot_complete event (no-op for streaming emitter)."""
        logger.debug(
            f"[StreamingEmitter] chat:bot_complete user={user_id} task={task_id} "
            f"subtask={subtask_id} (skipped)"
        )

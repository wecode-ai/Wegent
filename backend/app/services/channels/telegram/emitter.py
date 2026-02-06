# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for Telegram.

This module provides ChatEventEmitter implementations for Telegram:
- StreamingResponseEmitter: Telegram-specific streaming via message editing
"""

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Dict, Optional

from app.services.chat.trigger.emitter import ChatEventEmitter

if TYPE_CHECKING:
    from telegram import Bot

logger = logging.getLogger(__name__)


class StreamingResponseEmitter(ChatEventEmitter):
    """Streaming response emitter for Telegram using message editing.

    This emitter uses Telegram's edit_message_text API to send streaming
    updates to the user, providing a real-time response experience.

    Rate limit considerations:
    - Telegram has rate limits on message editing
    - We throttle updates to avoid hitting limits (max ~3 updates/second)
    - Content changes are accumulated and sent in batches

    Usage:
        emitter = StreamingResponseEmitter(bot, chat_id)
        # ... trigger AI response with this emitter ...
        # The emitter will automatically send streaming updates to Telegram
    """

    # Minimum interval between streaming updates (in seconds)
    # Telegram recommends not more than 30 edits per minute per chat
    MIN_UPDATE_INTERVAL = 0.5

    # Maximum message length for Telegram
    MAX_MESSAGE_LENGTH = 4096

    def __init__(
        self,
        bot: "Bot",
        chat_id: int,
        message_id: Optional[int] = None,
    ):
        """Initialize StreamingResponseEmitter.

        Args:
            bot: Telegram Bot instance
            chat_id: Telegram chat ID to send messages to
            message_id: Optional message ID for editing existing message
        """
        self._bot = bot
        self._chat_id = chat_id
        self._message_id = message_id
        self._full_content = ""
        self._last_update_time = 0.0
        self._pending_content = ""
        self._started = False
        self._finished = False

    @property
    def message_id(self) -> Optional[int]:
        """Get the current message ID."""
        return self._message_id

    async def _ensure_message_created(self) -> bool:
        """Ensure a message exists for editing.

        Returns:
            True if message is ready, False if creation failed
        """
        if self._message_id:
            return True

        try:
            # Send initial placeholder message
            logger.info(
                f"[TelegramStreamingEmitter] Creating initial message for chat {self._chat_id}"
            )
            message = await self._bot.send_message(
                chat_id=self._chat_id,
                text="⏳ 正在思考...",
            )
            self._message_id = message.message_id
            self._started = True
            logger.info(
                f"[TelegramStreamingEmitter] Created message {self._message_id} "
                f"for chat {self._chat_id}"
            )
            return True

        except Exception as e:
            logger.exception(
                f"[TelegramStreamingEmitter] Failed to create message: {e}"
            )
            return False

    async def _send_streaming_update(self, content: str, force: bool = False) -> None:
        """Send a streaming update by editing the message.

        Args:
            content: The content to send (will be accumulated)
            force: If True, send immediately regardless of throttling
        """
        if self._finished or not self._message_id:
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

                # Truncate if too long
                display_content = self._full_content
                if len(display_content) > self.MAX_MESSAGE_LENGTH - 50:
                    display_content = (
                        display_content[: self.MAX_MESSAGE_LENGTH - 50] + "\n\n..."
                    )

                logger.debug(
                    f"[TelegramStreamingEmitter] Editing message {self._message_id}, "
                    f"content_len={len(display_content)}"
                )

                await self._bot.edit_message_text(
                    chat_id=self._chat_id,
                    message_id=self._message_id,
                    text=display_content,
                )

                self._pending_content = ""
                self._last_update_time = current_time

            except Exception as e:
                # Don't fail on edit errors - might be rate limited
                logger.warning(
                    f"[TelegramStreamingEmitter] Failed to edit message: {e}"
                )

    async def emit_chat_start(
        self,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
        shell_type: str = "Chat",
    ) -> None:
        """Emit chat:start event - create the initial message."""
        logger.info(
            f"[TelegramStreamingEmitter] chat:start task={task_id} subtask={subtask_id}"
        )
        await self._ensure_message_created()

    async def emit_chat_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        result: Optional[Dict[str, Any]] = None,
        block_id: Optional[str] = None,
        block_offset: Optional[int] = None,
    ) -> None:
        """Emit chat:chunk event - send streaming update to Telegram."""
        if not content:
            return

        # Ensure message is created
        if not await self._ensure_message_created():
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
        """Emit chat:done event - finalize the message."""
        if self._finished:
            logger.warning(
                "[TelegramStreamingEmitter] emit_chat_done called but already finished"
            )
            return

        logger.info(
            f"[TelegramStreamingEmitter] chat:done task={task_id} subtask={subtask_id} "
            f"full_content_len={len(self._full_content)}, pending_len={len(self._pending_content)}"
        )

        try:
            # Ensure message is created
            if not await self._ensure_message_created():
                logger.error(
                    "[TelegramStreamingEmitter] Cannot finish - message not created"
                )
                return

            # Send any remaining pending content
            if self._pending_content:
                self._full_content += self._pending_content
                self._pending_content = ""

            # Final update with complete content
            if self._full_content:
                display_content = self._full_content
                if len(display_content) > self.MAX_MESSAGE_LENGTH - 50:
                    display_content = (
                        display_content[: self.MAX_MESSAGE_LENGTH - 50] + "\n\n..."
                    )

                await self._bot.edit_message_text(
                    chat_id=self._chat_id,
                    message_id=self._message_id,
                    text=display_content,
                )

            self._finished = True
            logger.info("[TelegramStreamingEmitter] Message finalized successfully")

        except Exception as e:
            logger.exception(
                f"[TelegramStreamingEmitter] Failed to finalize message: {e}"
            )

    async def emit_chat_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        message_id: Optional[int] = None,
    ) -> None:
        """Emit chat:error event - show error message."""
        if self._finished:
            return

        logger.warning(
            f"[TelegramStreamingEmitter] chat:error task={task_id} subtask={subtask_id} "
            f"error={error}"
        )

        try:
            # Ensure message is created
            if not await self._ensure_message_created():
                return

            # Update message with error
            error_text = f"❌ 错误: {error}"
            if self._full_content:
                error_text = f"{self._full_content}\n\n{error_text}"

            await self._bot.edit_message_text(
                chat_id=self._chat_id,
                message_id=self._message_id,
                text=error_text[: self.MAX_MESSAGE_LENGTH],
            )

            self._finished = True

        except Exception as e:
            logger.exception(
                f"[TelegramStreamingEmitter] Failed to send error message: {e}"
            )

    async def emit_chat_cancelled(
        self,
        task_id: int,
        subtask_id: int,
    ) -> None:
        """Emit chat:cancelled event - finalize with cancellation note."""
        if self._finished:
            return

        logger.info(
            f"[TelegramStreamingEmitter] chat:cancelled task={task_id} subtask={subtask_id}"
        )

        try:
            # Ensure message is created
            if not await self._ensure_message_created():
                return

            # Send any remaining content and add cancellation note
            if self._pending_content:
                self._full_content += self._pending_content
                self._pending_content = ""

            self._full_content += "\n\n*(已取消)*"

            display_content = self._full_content
            if len(display_content) > self.MAX_MESSAGE_LENGTH - 50:
                display_content = (
                    display_content[: self.MAX_MESSAGE_LENGTH - 50] + "\n\n..."
                )

            await self._bot.edit_message_text(
                chat_id=self._chat_id,
                message_id=self._message_id,
                text=display_content,
            )

            self._finished = True

        except Exception as e:
            logger.exception(
                f"[TelegramStreamingEmitter] Failed to cancel message: {e}"
            )

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
            f"[TelegramStreamingEmitter] chat:bot_complete user={user_id} task={task_id} "
            f"subtask={subtask_id} (skipped)"
        )

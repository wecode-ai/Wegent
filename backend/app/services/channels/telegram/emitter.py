# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Response Emitters for Telegram.

This module provides ResultEmitter implementations for Telegram:
- StreamingResponseEmitter: Telegram-specific streaming via message editing
"""

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Dict, Optional

from app.services.execution.emitters import ResultEmitter
from shared.models import EventType, ExecutionEvent

if TYPE_CHECKING:
    from telegram import Bot

logger = logging.getLogger(__name__)


class StreamingResponseEmitter(ResultEmitter):
    """Streaming response emitter for Telegram using message editing.

    This emitter uses Telegram's edit_message_text API to send streaming
    updates to the user, providing a real-time response experience.

    Rate limit considerations:
    - Telegram has rate limits on message editing
    - We throttle updates to avoid hitting limits (max ~3 updates/second)
    - Content changes are accumulated and sent in batches

    Thinking status handling:
    - Thinking status (e.g., "⏳ 处理中...", "🔧 使用工具: xxx") is displayed
      as a temporary prefix that gets replaced, not accumulated
    - Only the actual AI response content is accumulated

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
    TRUNCATION_SUFFIX = "\n\n..."

    # Thinking status prefixes that should be replaced, not accumulated
    THINKING_PREFIXES = (
        "⏳",
        "🔧",
        "✅",
        "❌",
        "💭",
        "⚙️",
        "📝",
    )

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
        self._full_content = ""  # Accumulated actual content (not thinking status)
        self._current_thinking = (
            ""  # Current thinking status (replaced, not accumulated)
        )
        self._reasoning_content = ""
        self._last_update_time = 0.0
        self._pending_content = ""
        self._started = False
        self._finished = False
        self._update_lock = asyncio.Lock()

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

    def _is_thinking_status(self, content: str) -> bool:
        """Check if content is a thinking status that should be replaced.

        Thinking status lines start with specific emoji prefixes and are
        temporary status updates that should replace previous thinking status,
        not accumulate.

        Args:
            content: Content to check

        Returns:
            True if content is a thinking status
        """
        stripped = content.strip()
        return any(stripped.startswith(prefix) for prefix in self.THINKING_PREFIXES)

    def _extract_thinking_and_content(self, text: str) -> tuple[str, str]:
        """Extract thinking status and actual content from text.

        Args:
            text: Text that may contain thinking status and content

        Returns:
            Tuple of (thinking_status, actual_content)
        """
        if not text:
            return "", ""

        if "**回复:**" in text:
            thinking_text, _, content = text.partition("**回复:**")
            thinking_lines = [
                line
                for line in thinking_text.splitlines()
                if self._is_thinking_status(line.strip())
            ]
            if content.startswith("\r\n"):
                content = content[2:]
            elif content.startswith("\n"):
                content = content[1:]
            return "\n".join(thinking_lines).strip(), content

        stripped = text.strip()
        if (
            stripped
            and self._is_thinking_status(stripped)
            and text.endswith(("\n\n", "\r\n\r\n"))
        ):
            return stripped, ""

        return "", text

    def _format_reasoning_summary(self) -> str:
        """Format accumulated model reasoning summary for display."""
        reasoning = self._reasoning_content.strip()
        if not reasoning:
            return ""
        return f"💭 思考摘要\n{reasoning}"

    def _build_display_content(
        self,
        answer_content: str,
        *,
        include_status: bool = True,
    ) -> str:
        """Build Telegram text with separate reasoning and answer blocks."""
        answer = answer_content if answer_content.strip() else ""
        reasoning_summary = self._format_reasoning_summary()
        display_parts = []

        if reasoning_summary:
            display_parts.append(reasoning_summary)
        elif include_status and self._current_thinking and not answer:
            display_parts.append(self._current_thinking)

        if answer:
            if reasoning_summary:
                display_parts.append(f"回复\n{answer}")
            else:
                display_parts.append(answer)

        return "\n\n".join(display_parts)

    def _truncate_message(self, content: str) -> str:
        """Truncate content to Telegram's message length limit."""
        if len(content) <= self.MAX_MESSAGE_LENGTH - len(self.TRUNCATION_SUFFIX):
            return content
        return (
            content[: self.MAX_MESSAGE_LENGTH - len(self.TRUNCATION_SUFFIX)]
            + self.TRUNCATION_SUFFIX
        )

    async def _send_streaming_update(self, content: str, force: bool = False) -> None:
        """Send a streaming update by editing the message.

        Handles thinking status specially - thinking status is replaced, not accumulated.
        Only actual AI response content is accumulated.

        Args:
            content: The content to send
            force: If True, send immediately regardless of throttling
        """
        if self._finished or not self._message_id:
            return

        current_time = time.time()
        time_since_last = current_time - self._last_update_time

        # Extract thinking status and actual content from the incoming chunk
        thinking, actual_content = self._extract_thinking_and_content(content)

        # Update thinking status (replace, not accumulate)
        if thinking:
            self._current_thinking = thinking

        # Accumulate actual content
        if actual_content:
            self._pending_content += actual_content

        # Check if we should send an update
        if not force and time_since_last < self.MIN_UPDATE_INTERVAL:
            return

        # Send the update
        try:
            # Accumulate pending content to full content
            if self._pending_content:
                self._full_content += self._pending_content
                self._pending_content = ""

            display_content = self._build_display_content(self._full_content)

            if not display_content:
                return

            display_content = self._truncate_message(display_content)

            logger.debug(
                f"[TelegramStreamingEmitter] Editing message {self._message_id}, "
                f"content_len={len(display_content)}, thinking={bool(self._current_thinking)}"
            )

            await self._bot.edit_message_text(
                chat_id=self._chat_id,
                message_id=self._message_id,
                text=display_content,
            )

            # Update timestamp after successful edit to maintain accurate throttle
            self._last_update_time = time.time()

        except Exception as e:
            # Don't fail on edit errors - might be rate limited
            logger.warning(f"[TelegramStreamingEmitter] Failed to edit message: {e}")

    async def emit(self, event: ExecutionEvent) -> None:
        """Emit a single event.

        Args:
            event: Execution event to emit
        """
        event_type = (
            event.type.value if isinstance(event.type, EventType) else event.type
        )
        if event_type == EventType.START.value:
            await self.emit_start(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                message_id=event.message_id,
            )
        elif event_type == EventType.CHUNK.value:
            await self.emit_chunk(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content or "",
                offset=event.offset,
            )
        elif event_type == EventType.THINKING.value:
            await self.emit_thinking(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                content=event.content or "",
                offset=event.offset,
            )
        elif event_type == EventType.DONE.value:
            await self.emit_done(
                task_id=event.task_id,
                subtask_id=event.subtask_id,
                result=event.result,
            )
        elif event_type == EventType.ERROR.value:
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
        """Emit start event - create the initial message."""
        logger.info(
            f"[TelegramStreamingEmitter] start task={task_id} subtask={subtask_id}"
        )
        async with self._update_lock:
            await self._ensure_message_created()

    async def emit_chunk(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int,
        **kwargs,
    ) -> None:
        """Emit chunk event - send streaming update to Telegram."""
        if not content:
            return

        async with self._update_lock:
            # Ensure message is created
            if not await self._ensure_message_created():
                return

            # Use throttling to reduce API calls
            await self._send_streaming_update(content)

    async def emit_thinking(
        self,
        task_id: int,
        subtask_id: int,
        content: str,
        offset: int = 0,
        **kwargs,
    ) -> None:
        """Emit reasoning content as a temporary Telegram thinking status."""
        if not content:
            return

        async with self._update_lock:
            # Ensure message is created
            if not await self._ensure_message_created():
                return

            self._reasoning_content += content
            await self._send_streaming_update("")

    async def emit_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Optional[dict] = None,
        **kwargs,
    ) -> None:
        """Emit done event - finalize the message."""
        if self._finished:
            logger.warning(
                "[TelegramStreamingEmitter] emit_done called but already finished"
            )
            return

        async with self._update_lock:
            final_content = self._full_content
            if self._pending_content:
                final_content += self._pending_content
                self._pending_content = ""

            if result and isinstance(result, dict):
                result_value = result.get("value", "") or result.get("output", "") or ""
                if result_value and not isinstance(result_value, str):
                    result_value = str(result_value)
                if result_value:
                    final_content = result_value
                    logger.info(
                        f"[TelegramStreamingEmitter] Using final result content "
                        f"({len(result_value)} chars) instead of accumulated content "
                        f"({len(self._full_content)} chars)"
                    )

            logger.info(
                f"[TelegramStreamingEmitter] done task={task_id} subtask={subtask_id} "
                f"final_content_len={len(final_content)}"
            )

            try:
                # Ensure message is created
                if not await self._ensure_message_created():
                    logger.error(
                        "[TelegramStreamingEmitter] Cannot finish - message not created"
                    )
                    return

                self._full_content = final_content

                # Final update with complete content
                display_content = self._build_display_content(
                    final_content,
                    include_status=False,
                )
                if display_content:
                    display_content = self._truncate_message(display_content)

                    try:
                        await self._bot.edit_message_text(
                            chat_id=self._chat_id,
                            message_id=self._message_id,
                            text=display_content,
                        )
                    except Exception as edit_error:
                        # Ignore "Message is not modified" error - this happens when
                        # the final content is the same as the last streamed content
                        error_str = str(edit_error)
                        if "Message is not modified" in error_str:
                            logger.debug(
                                "[TelegramStreamingEmitter] Message content unchanged, skipping final edit"
                            )
                        else:
                            raise

                self._finished = True
                logger.info("[TelegramStreamingEmitter] Message finalized successfully")

            except Exception as e:
                logger.exception(
                    f"[TelegramStreamingEmitter] Failed to finalize message: {e}"
                )

    async def emit_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
        **kwargs,
    ) -> None:
        """Emit error event - show error message."""
        if self._finished:
            return

        logger.warning(
            f"[TelegramStreamingEmitter] error task={task_id} subtask={subtask_id} "
            f"error={error}"
        )

        async with self._update_lock:
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

    async def emit_cancelled(
        self,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> None:
        """Emit cancelled event - show cancellation message."""
        if self._finished:
            return

        logger.info(
            f"[TelegramStreamingEmitter] cancelled task={task_id} subtask={subtask_id}"
        )

        async with self._update_lock:
            try:
                # Ensure message is created
                if not await self._ensure_message_created():
                    return

                # Add cancellation note to content
                self._full_content += "\n\n⚠️ 任务已取消"

                # Update message with cancellation
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
                    f"[TelegramStreamingEmitter] Failed to send cancellation message: {e}"
                )

    async def close(self) -> None:
        """Close the emitter and release resources."""
        pass

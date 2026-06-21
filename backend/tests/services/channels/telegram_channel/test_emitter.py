# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for Telegram StreamingResponseEmitter."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.channels.telegram.emitter import StreamingResponseEmitter
from shared.models import EventType, ExecutionEvent


class TestStreamingResponseEmitter:
    """Tests for StreamingResponseEmitter."""

    @pytest.fixture
    def mock_bot(self):
        """Create a mock Telegram Bot."""
        bot = MagicMock()
        bot.send_message = AsyncMock()
        bot.edit_message_text = AsyncMock()
        return bot

    @pytest.fixture
    def emitter(self, mock_bot):
        """Create StreamingResponseEmitter instance."""
        return StreamingResponseEmitter(
            bot=mock_bot,
            chat_id=123456,
        )

    def test_init(self, emitter, mock_bot):
        """Test emitter initialization."""
        assert emitter._bot == mock_bot
        assert emitter._chat_id == 123456
        assert emitter._message_id is None
        assert emitter._full_content == ""
        assert emitter._started is False
        assert emitter._finished is False

    def test_init_with_message_id(self, mock_bot):
        """Test emitter initialization with existing message ID."""
        emitter = StreamingResponseEmitter(
            bot=mock_bot,
            chat_id=123456,
            message_id=789,
        )

        assert emitter._message_id == 789

    @pytest.mark.asyncio
    async def test_ensure_message_created_new(self, emitter, mock_bot):
        """Test creating a new message."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message

        result = await emitter._ensure_message_created()

        assert result is True
        assert emitter._message_id == 999
        assert emitter._started is True
        mock_bot.send_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_ensure_message_created_existing(self, mock_bot):
        """Test with existing message ID."""
        emitter = StreamingResponseEmitter(
            bot=mock_bot,
            chat_id=123456,
            message_id=789,
        )

        result = await emitter._ensure_message_created()

        assert result is True
        mock_bot.send_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_ensure_message_created_failure(self, emitter, mock_bot):
        """Test when message creation fails."""
        mock_bot.send_message.side_effect = Exception("API Error")

        result = await emitter._ensure_message_created()

        assert result is False
        assert emitter._message_id is None

    @pytest.mark.asyncio
    async def test_emit_start(self, emitter, mock_bot):
        """Test emit_start creates message."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message

        await emitter.emit_start(task_id=1, subtask_id=2)

        assert emitter._message_id == 999
        mock_bot.send_message.assert_called_once()

    @pytest.mark.asyncio
    async def test_emit_chunk(self, emitter, mock_bot):
        """Test emit_chunk sends update."""
        # First create the message
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message

        await emitter.emit_start(task_id=1, subtask_id=2)

        # Reset mock to check chunk call
        mock_bot.edit_message_text.reset_mock()

        # Force send by setting last_update_time to past
        emitter._last_update_time = 0

        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="Hello, world!",
            offset=0,
        )

        # Content should be accumulated
        assert (
            "Hello, world!" in emitter._full_content
            or "Hello, world!" in emitter._pending_content
        )

    @pytest.mark.asyncio
    async def test_emit_chunk_empty_content(self, emitter, mock_bot):
        """Test emit_chunk with empty content."""
        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="",
            offset=0,
        )

        # Should not send anything
        mock_bot.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_emit_thinking_event_edits_message(self, emitter, mock_bot):
        """Test THINKING events are displayed as temporary thinking status."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()
        emitter._last_update_time = 0

        await emitter.emit(
            ExecutionEvent.create(
                EventType.THINKING,
                task_id=1,
                subtask_id=2,
                content="Checking the workspace",
                offset=0,
            )
        )

        mock_bot.edit_message_text.assert_called_once()
        text = mock_bot.edit_message_text.call_args.kwargs["text"]
        assert "💭 思考摘要" in text
        assert "Checking the workspace" in text
        assert emitter._full_content == ""

    @pytest.mark.asyncio
    async def test_emit_done_keeps_reasoning_summary_separate_from_answer(
        self, emitter, mock_bot
    ):
        """Test final output keeps thinking summary visible above the answer."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()
        emitter._last_update_time = 0

        await emitter.emit(
            ExecutionEvent.create(
                EventType.THINKING,
                task_id=1,
                subtask_id=2,
                content="Checking the workspace",
                offset=0,
            )
        )
        emitter._last_update_time = 0
        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="Final answer",
            offset=12,
        )

        await emitter.emit_done(task_id=1, subtask_id=2, offset=12)

        text = mock_bot.edit_message_text.call_args.kwargs["text"]
        assert "💭 思考摘要" in text
        assert "Checking the workspace" in text
        assert "回复" in text
        assert "Final answer" in text
        assert text.index("Checking the workspace") < text.index("Final answer")

    @pytest.mark.asyncio
    async def test_multiline_thinking_does_not_leak_into_answer(
        self, emitter, mock_bot
    ):
        """Test multiline thinking stays in the reasoning summary block."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()
        emitter._last_update_time = 0

        await emitter.emit(
            ExecutionEvent.create(
                EventType.THINKING,
                task_id=1,
                subtask_id=2,
                content="Read files\nCheck tests",
                offset=0,
            )
        )
        emitter._last_update_time = 0
        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="Final answer",
            offset=12,
        )

        await emitter.emit_done(task_id=1, subtask_id=2, offset=12)

        text = mock_bot.edit_message_text.call_args.kwargs["text"]
        reasoning_block, answer_block = text.split("\n\n回复\n", maxsplit=1)
        assert "Read files\nCheck tests" in reasoning_block
        assert answer_block == "Final answer"

    @pytest.mark.asyncio
    async def test_emit_chunk_preserves_stream_chunk_boundaries(
        self, emitter, mock_bot
    ):
        """Test streamed answer chunks preserve their exact whitespace boundaries."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()

        emitter._last_update_time = 0
        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="你刚主要说了：\n\n",
            offset=8,
        )
        emitter._last_update_time = 0
        await emitter.emit_chunk(
            task_id=1,
            subtask_id=2,
            content="1.  注入当前项目 ",
            offset=19,
        )

        await emitter.emit_done(task_id=1, subtask_id=2)

        assert mock_bot.edit_message_text.call_args.kwargs["text"] == (
            "你刚主要说了：\n\n1.  注入当前项目 "
        )

    @pytest.mark.asyncio
    async def test_emit_done_prefers_result_value_over_stream_buffer(
        self, emitter, mock_bot
    ):
        """Test the final Telegram message uses canonical done result content."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()
        emitter._full_content = "BAC"

        await emitter.emit_done(task_id=1, subtask_id=2, result={"value": "ABC"})

        assert mock_bot.edit_message_text.call_args.kwargs["text"] == "ABC"

    @pytest.mark.asyncio
    async def test_emit_done(self, emitter, mock_bot):
        """Test emit_done finalizes message."""
        # Setup
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)

        emitter._full_content = "Test content"

        await emitter.emit_done(task_id=1, subtask_id=2, offset=12)

        assert emitter._finished is True
        mock_bot.edit_message_text.assert_called()

    @pytest.mark.asyncio
    async def test_emit_done_uses_result_value_without_streamed_content(
        self, emitter, mock_bot
    ):
        """Test emit_done uses result content when no chunks were streamed."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)
        mock_bot.edit_message_text.reset_mock()

        await emitter.emit_done(
            task_id=1,
            subtask_id=2,
            result={"value": "Final answer"},
        )

        assert emitter._finished is True
        mock_bot.edit_message_text.assert_called_once()
        assert mock_bot.edit_message_text.call_args.kwargs["text"] == "Final answer"

    @pytest.mark.asyncio
    async def test_emit_done_already_finished(self, emitter, mock_bot):
        """Test emit_done when already finished."""
        emitter._finished = True

        await emitter.emit_done(task_id=1, subtask_id=2, offset=0)

        # Should not do anything
        mock_bot.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_emit_error(self, emitter, mock_bot):
        """Test emit_error shows error message."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)

        await emitter.emit_error(
            task_id=1,
            subtask_id=2,
            error="Something went wrong",
        )

        assert emitter._finished is True
        # Should have called edit_message_text with error
        call_args = mock_bot.edit_message_text.call_args
        assert (
            "错误" in call_args.kwargs["text"]
            or "Something went wrong" in call_args.kwargs["text"]
        )

    @pytest.mark.asyncio
    async def test_emit_error_already_finished(self, emitter, mock_bot):
        """Test emit_error when already finished."""
        emitter._finished = True

        await emitter.emit_error(
            task_id=1,
            subtask_id=2,
            error="Something went wrong",
        )

        mock_bot.edit_message_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_emit_cancelled(self, emitter, mock_bot):
        """Test emit_cancelled adds cancellation note."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)

        emitter._full_content = "Partial content"

        await emitter.emit_cancelled(task_id=1, subtask_id=2)

        assert emitter._finished is True
        assert "取消" in emitter._full_content

    def test_max_message_length(self, emitter):
        """Test MAX_MESSAGE_LENGTH constant."""
        assert emitter.MAX_MESSAGE_LENGTH == 4096

    def test_min_update_interval(self, emitter):
        """Test MIN_UPDATE_INTERVAL constant."""
        assert emitter.MIN_UPDATE_INTERVAL == 0.5

    @pytest.mark.asyncio
    async def test_content_truncation(self, emitter, mock_bot):
        """Test that long content is truncated."""
        mock_message = MagicMock()
        mock_message.message_id = 999
        mock_bot.send_message.return_value = mock_message
        await emitter.emit_start(task_id=1, subtask_id=2)

        # Set very long content
        emitter._full_content = "x" * 5000

        await emitter.emit_done(task_id=1, subtask_id=2, offset=5000)

        # Should have truncated content with ...
        call_args = mock_bot.edit_message_text.call_args
        text = call_args.kwargs["text"]
        assert len(text) <= emitter.MAX_MESSAGE_LENGTH
        assert "..." in text

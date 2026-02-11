# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for TelegramCallbackService."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.channels.callback import ChannelType
from app.services.channels.telegram.callback import (
    TelegramCallbackInfo,
    TelegramCallbackService,
)


class TestTelegramCallbackInfo:
    """Tests for TelegramCallbackInfo."""

    def test_init(self):
        """Test TelegramCallbackInfo initialization."""
        info = TelegramCallbackInfo(
            channel_id=1,
            conversation_id="123456",
            chat_id=123456,
            message_id=789,
        )

        assert info.channel_type == ChannelType.TELEGRAM
        assert info.channel_id == 1
        assert info.conversation_id == "123456"
        assert info.chat_id == 123456
        assert info.message_id == 789

    def test_to_dict(self):
        """Test converting to dictionary."""
        info = TelegramCallbackInfo(
            channel_id=1,
            conversation_id="123456",
            chat_id=123456,
            message_id=789,
        )

        data = info.to_dict()

        assert data["channel_type"] == "telegram"
        assert data["channel_id"] == 1
        assert data["conversation_id"] == "123456"
        assert data["chat_id"] == 123456
        assert data["message_id"] == 789

    def test_from_dict(self):
        """Test creating from dictionary."""
        data = {
            "channel_type": "telegram",
            "channel_id": 1,
            "conversation_id": "123456",
            "chat_id": 123456,
            "message_id": 789,
        }

        info = TelegramCallbackInfo.from_dict(data)

        assert info.channel_id == 1
        assert info.conversation_id == "123456"
        assert info.chat_id == 123456
        assert info.message_id == 789

    def test_from_dict_defaults(self):
        """Test creating from dictionary with defaults."""
        data = {}

        info = TelegramCallbackInfo.from_dict(data)

        assert info.channel_id == 0
        assert info.conversation_id == ""
        assert info.chat_id == 0
        assert info.message_id is None


class TestTelegramCallbackService:
    """Tests for TelegramCallbackService."""

    @pytest.fixture
    def service(self):
        """Create TelegramCallbackService instance."""
        return TelegramCallbackService()

    def test_init(self, service):
        """Test service initialization."""
        assert service.channel_type == ChannelType.TELEGRAM

    def test_parse_callback_info(self, service):
        """Test parsing callback info from dictionary."""
        data = {
            "channel_type": "telegram",
            "channel_id": 1,
            "conversation_id": "123456",
            "chat_id": 123456,
            "message_id": 789,
        }

        info = service._parse_callback_info(data)

        assert isinstance(info, TelegramCallbackInfo)
        assert info.chat_id == 123456
        assert info.message_id == 789

    def test_extract_thinking_display_tool_use(self, service):
        """Test extracting thinking display for tool_use type."""
        thinking = [
            {
                "details": {
                    "type": "tool_use",
                    "name": "Bash",
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "使用工具" in result
        assert "Bash" in result

    def test_extract_thinking_display_tool_result(self, service):
        """Test extracting thinking display for tool_result type."""
        thinking = [
            {
                "details": {
                    "type": "tool_result",
                    "tool_name": "Read",
                    "is_error": False,
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "完成" in result

    def test_extract_thinking_display_tool_result_error(self, service):
        """Test extracting thinking display for failed tool_result."""
        thinking = [
            {
                "details": {
                    "type": "tool_result",
                    "tool_name": "Bash",
                    "is_error": True,
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "失败" in result

    def test_extract_thinking_display_assistant(self, service):
        """Test extracting thinking display for assistant type."""
        thinking = [
            {
                "details": {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "text", "text": "Let me help you with that."}
                        ]
                    },
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "Let me help" in result or "思考中" in result

    def test_extract_thinking_display_empty(self, service):
        """Test extracting thinking display for empty input."""
        assert service._extract_thinking_display(None) == ""
        assert service._extract_thinking_display([]) == ""
        assert service._extract_thinking_display("") == ""

    def test_extract_thinking_display_system_init(self, service):
        """Test extracting thinking display for system init type."""
        thinking = [
            {
                "details": {
                    "type": "system",
                    "subtype": "init",
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "初始化" in result

    def test_extract_thinking_display_result(self, service):
        """Test extracting thinking display for result type."""
        thinking = [
            {
                "details": {
                    "type": "result",
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "结果" in result or "生成" in result

    def test_extract_thinking_display_unknown(self, service):
        """Test extracting thinking display for unknown type."""
        thinking = [
            {
                "details": {
                    "type": "unknown_type",
                }
            }
        ]

        result = service._extract_thinking_display(thinking)

        assert "处理中" in result

    @pytest.mark.asyncio
    async def test_create_emitter_channel_not_found(self, service):
        """Test creating emitter when channel not found."""
        callback_info = TelegramCallbackInfo(
            channel_id=999,
            conversation_id="123456",
            chat_id=123456,
        )

        with patch("app.services.channels.manager.get_channel_manager") as mock_manager:
            mock_manager.return_value.get_channel.return_value = None

            result = await service._create_emitter(1, 1, callback_info)

            assert result is None

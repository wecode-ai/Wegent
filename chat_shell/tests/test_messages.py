# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MessageConverter - message building and conversion utilities.

This module tests the core message conversion functionality including:
- Message building with/without datetime injection
- Vision message handling
- Username prefixing for group chat
"""

import base64
from datetime import datetime

import pytest

# Import directly from the module to avoid triggering __init__.py dependencies
from chat_shell.messages.converter import MessageConverter


class TestMessageConverterBuildMessages:
    """Tests for MessageConverter.build_messages method."""

    def test_build_messages_basic(self):
        """Test basic message building."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="You are helpful.",
            inject_datetime=False,
        )

        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert messages[0]["content"] == "You are helpful."
        assert messages[1]["role"] == "user"
        assert messages[1]["content"] == "Hello"

    def test_build_messages_with_datetime_injection(self):
        """Test datetime is injected when inject_datetime=True."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="",
            inject_datetime=True,
        )

        user_msg = messages[-1]
        assert user_msg["role"] == "user"
        assert "[Current time:" in user_msg["content"]
        # Verify the datetime format
        assert datetime.now().strftime("%Y-%m-%d") in user_msg["content"]

    def test_build_messages_without_datetime_injection(self):
        """Test datetime is NOT injected when inject_datetime=False.

        This is the expected behavior for API calls without wegent_chat_bot tool.
        """
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="",
            inject_datetime=False,
        )

        user_msg = messages[-1]
        assert user_msg["role"] == "user"
        assert "[Current time:" not in user_msg["content"]
        assert user_msg["content"] == "Hello"

    def test_build_messages_default_injects_datetime(self):
        """Test that default behavior injects datetime (backward compatibility)."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="",
            # inject_datetime defaults to True
        )

        user_msg = messages[-1]
        assert "[Current time:" in user_msg["content"]

    def test_build_messages_with_history(self):
        """Test that history is preserved."""
        history = [
            {"role": "user", "content": "Hi"},
            {"role": "assistant", "content": "Hello!"},
        ]

        messages = MessageConverter.build_messages(
            history=history,
            current_message="How are you?",
            system_prompt="Be helpful",
            inject_datetime=False,
        )

        assert len(messages) == 4  # system + 2 history + current
        assert messages[0]["role"] == "system"
        assert messages[1]["content"] == "Hi"
        assert messages[2]["content"] == "Hello!"
        assert messages[3]["content"] == "How are you?"

    def test_build_messages_with_username(self):
        """Test username prefix for group chat."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello everyone",
            system_prompt="",
            username="Alice",
            inject_datetime=False,
        )

        user_msg = messages[-1]
        assert "User[Alice]:" in user_msg["content"]
        assert "Hello everyone" in user_msg["content"]

    def test_build_messages_without_system_prompt(self):
        """Test building messages without system prompt."""
        messages = MessageConverter.build_messages(
            history=[],
            current_message="Hello",
            system_prompt="",  # Empty
            inject_datetime=False,
        )

        assert len(messages) == 1
        assert messages[0]["role"] == "user"

    def test_build_messages_vision_message(self):
        """Test building vision messages."""
        # Create a tiny valid image (1x1 red PNG)
        tiny_png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
        )
        image_b64 = base64.b64encode(tiny_png).decode()

        vision_data = {
            "type": "vision",
            "text": "What is this?",
            "image_base64": image_b64,
            "mime_type": "image/png",
        }

        messages = MessageConverter.build_messages(
            history=[],
            current_message=vision_data,
            system_prompt="",
            inject_datetime=False,
        )

        user_msg = messages[-1]
        assert user_msg["role"] == "user"
        assert isinstance(user_msg["content"], list)
        # Should have text and image blocks
        text_block = next(
            (b for b in user_msg["content"] if b.get("type") == "text"), None
        )
        image_block = next(
            (b for b in user_msg["content"] if b.get("type") == "image_url"), None
        )
        assert text_block is not None
        assert image_block is not None
        assert "What is this?" in text_block["text"]


class TestMessageConverterExtractText:
    """Tests for MessageConverter.extract_text method."""

    def test_extract_text_from_string(self):
        """Test extracting text from string message."""
        result = MessageConverter.extract_text("Hello world")
        assert result == "Hello world"

    def test_extract_text_from_dict(self):
        """Test extracting text from dict message."""
        message = {"role": "user", "content": "Hello world"}
        result = MessageConverter.extract_text(message)
        assert result == "Hello world"

    def test_extract_text_from_multipart(self):
        """Test extracting text from multipart content."""
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "image_url", "image_url": {"url": "data:..."}},
                {"type": "text", "text": "world"},
            ],
        }
        result = MessageConverter.extract_text(message)
        assert "Hello" in result
        assert "world" in result


class TestMessageConverterIsVisionMessage:
    """Tests for MessageConverter.is_vision_message method."""

    def test_is_vision_message_true(self):
        """Test detecting vision message."""
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": "What is this?"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,..."},
                },
            ],
        }
        assert MessageConverter.is_vision_message(message) is True

    def test_is_vision_message_false_text_only(self):
        """Test non-vision text message."""
        message = {"role": "user", "content": "Hello"}
        assert MessageConverter.is_vision_message(message) is False

    def test_is_vision_message_false_list_without_image(self):
        """Test multipart message without image."""
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "World"},
            ],
        }
        assert MessageConverter.is_vision_message(message) is False

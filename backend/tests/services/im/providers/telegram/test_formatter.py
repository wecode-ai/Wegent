# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for Telegram message formatter.
"""

import pytest

from app.services.im.providers.telegram.formatter import TelegramFormatter


@pytest.fixture
def formatter():
    """Create a formatter instance."""
    return TelegramFormatter()


class TestTelegramFormatter:
    """Tests for TelegramFormatter."""

    def test_escape_special_chars(self, formatter):
        """Test escaping special characters."""
        text = "Hello *world* and _test_!"
        escaped = formatter.escape_special_chars(text)
        assert escaped == r"Hello \*world\* and \_test\_\!"

    def test_escape_special_chars_with_brackets(self, formatter):
        """Test escaping brackets."""
        text = "Check [this](link) and (that)"
        escaped = formatter.escape_special_chars(text)
        assert r"\[" in escaped
        assert r"\]" in escaped
        assert r"\(" in escaped
        assert r"\)" in escaped

    def test_format_markdown_simple(self, formatter):
        """Test formatting simple markdown."""
        content = "Hello world"
        formatted = formatter.format_markdown(content)
        # Should escape special chars
        assert formatted == "Hello world"

    def test_format_markdown_with_special_chars(self, formatter):
        """Test formatting markdown with special characters."""
        content = "Test with * and _ and !"
        formatted = formatter.format_markdown(content)
        assert r"\*" in formatted
        assert r"\_" in formatted
        assert r"\!" in formatted

    def test_format_markdown_preserves_code_blocks(self, formatter):
        """Test that code blocks are preserved."""
        content = "Here is code:\n```python\ndef hello():\n    print('hi')\n```"
        formatted = formatter.format_markdown(content)
        assert "```python" in formatted
        assert "def hello" in formatted

    def test_format_markdown_preserves_inline_code(self, formatter):
        """Test that inline code is preserved."""
        content = "Use the `print()` function"
        formatted = formatter.format_markdown(content)
        assert "`print" in formatted or "\\`" in formatted

    def test_split_message_short(self, formatter):
        """Test that short messages aren't split."""
        content = "Short message"
        chunks = formatter.split_message(content)
        assert len(chunks) == 1
        assert chunks[0] == content

    def test_split_message_long(self, formatter):
        """Test splitting long messages."""
        # Create a message longer than MAX_MESSAGE_LENGTH
        content = "A" * 5000
        chunks = formatter.split_message(content)
        assert len(chunks) > 1
        # Each chunk should be within limit
        for chunk in chunks:
            assert len(chunk) <= formatter.MAX_MESSAGE_LENGTH

    def test_split_message_paragraphs(self, formatter):
        """Test splitting by paragraphs."""
        # Create content with multiple paragraphs
        para1 = "A" * 2000
        para2 = "B" * 2000
        para3 = "C" * 2000
        content = f"{para1}\n\n{para2}\n\n{para3}"

        chunks = formatter.split_message(content)
        assert len(chunks) >= 2

    def test_split_message_long_line(self, formatter):
        """Test splitting a single long line."""
        # Create a single line longer than max
        content = "A" * 5000
        chunks = formatter.split_message(content)
        assert len(chunks) >= 2
        # Verify total content is preserved
        total_content = "".join(chunks)
        assert len(total_content) == len(content)

    def test_empty_content(self, formatter):
        """Test handling empty content."""
        assert formatter.format_markdown("") == ""
        assert formatter.split_message("") == [""]

    def test_max_message_length_constant(self, formatter):
        """Test that MAX_MESSAGE_LENGTH is set correctly."""
        assert formatter.MAX_MESSAGE_LENGTH == 4096

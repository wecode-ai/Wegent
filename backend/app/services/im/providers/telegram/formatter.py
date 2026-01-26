# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Telegram message formatter.

Converts standard Markdown to Telegram's MarkdownV2 format and handles
message splitting for Telegram's length limits.
"""

import re
import uuid
from typing import Dict, List

from app.services.im.base.formatter import IMFormatter


class TelegramFormatter(IMFormatter):
    """
    Telegram message formatter.

    Handles conversion from standard Markdown to Telegram's MarkdownV2 format,
    including special character escaping and message splitting.
    """

    # Telegram single message maximum length
    MAX_MESSAGE_LENGTH = 4096

    # MarkdownV2 special characters that need escaping
    SPECIAL_CHARS = r"_*[]()~`>#+-=|{}.!"

    def format_markdown(self, content: str) -> str:
        """
        Convert standard Markdown to Telegram MarkdownV2.

        Telegram's MarkdownV2 has stricter escaping requirements than
        standard Markdown. This method handles the conversion.

        Args:
            content: Standard Markdown content

        Returns:
            Telegram MarkdownV2 formatted content
        """
        if not content:
            return ""

        # Protect code blocks from escaping using unique UUID placeholders
        code_blocks: Dict[str, str] = {}

        def save_code_block(match: re.Match) -> str:
            placeholder = uuid.uuid4().hex
            code_blocks[placeholder] = match.group(0)
            return placeholder

        # Save multi-line code blocks
        content = re.sub(r"```[\s\S]*?```", save_code_block, content)
        # Save inline code
        content = re.sub(r"`[^`]+`", save_code_block, content)

        # Escape special characters in text
        content = self.escape_special_chars(content)

        # Restore code blocks with proper escaping
        for placeholder, block in code_blocks.items():
            escaped_block = self._escape_code_block(block)
            content = content.replace(placeholder, escaped_block)

        return content

    def escape_special_chars(self, text: str) -> str:
        """
        Escape MarkdownV2 special characters.

        Args:
            text: Text to escape

        Returns:
            Escaped text
        """
        result = text
        for char in self.SPECIAL_CHARS:
            result = result.replace(char, f"\\{char}")
        return result

    def _escape_code_block(self, block: str) -> str:
        """
        Escape content inside code blocks.

        Code blocks in MarkdownV2 only need ` and \\ escaped.

        Args:
            block: Code block string

        Returns:
            Escaped code block
        """
        if block.startswith("```"):
            # Multi-line code block
            match = re.match(r"```(\w*)\n?([\s\S]*?)```", block)
            if match:
                lang = match.group(1) or ""
                code = match.group(2)
                # Escape backslash and backtick in code
                code = code.replace("\\", "\\\\").replace("`", "\\`")
                return f"```{lang}\n{code}```"
        else:
            # Inline code
            code = block[1:-1]
            code = code.replace("\\", "\\\\").replace("`", "\\`")
            return f"`{code}`"
        return block

    def split_message(self, content: str) -> List[str]:
        """
        Split a long message into multiple messages.

        Attempts to split at natural boundaries (paragraphs, then lines)
        to maintain readability.

        Args:
            content: Original content

        Returns:
            List of message chunks
        """
        if len(content) <= self.MAX_MESSAGE_LENGTH:
            return [content]

        chunks: List[str] = []
        current_chunk = ""

        # Split by paragraphs first
        paragraphs = content.split("\n\n")

        for para in paragraphs:
            if len(current_chunk) + len(para) + 2 <= self.MAX_MESSAGE_LENGTH:
                if current_chunk:
                    current_chunk += "\n\n"
                current_chunk += para
            else:
                if current_chunk:
                    chunks.append(current_chunk)

                # If single paragraph is too long, split by lines
                if len(para) > self.MAX_MESSAGE_LENGTH:
                    current_chunk = self._split_long_paragraph(para, chunks)
                else:
                    current_chunk = para

        if current_chunk:
            chunks.append(current_chunk)

        return chunks

    def _split_long_paragraph(self, para: str, chunks: List[str]) -> str:
        """
        Split a long paragraph by lines.

        Args:
            para: Paragraph to split
            chunks: List to append completed chunks to

        Returns:
            Remaining content for the current chunk
        """
        lines = para.split("\n")
        current_chunk = ""

        for line in lines:
            if len(current_chunk) + len(line) + 1 <= self.MAX_MESSAGE_LENGTH:
                if current_chunk:
                    current_chunk += "\n"
                current_chunk += line
            else:
                if current_chunk:
                    chunks.append(current_chunk)

                # If single line is too long, force split
                while len(line) > self.MAX_MESSAGE_LENGTH:
                    chunks.append(line[: self.MAX_MESSAGE_LENGTH])
                    line = line[self.MAX_MESSAGE_LENGTH :]
                current_chunk = line

        return current_chunk

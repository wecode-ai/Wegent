# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract base class for message formatters.

Each IM platform has its own message format requirements (e.g., Telegram uses
MarkdownV2, Slack uses mrkdwn). Formatters handle the conversion from standard
Markdown to platform-specific formats.
"""

from abc import ABC, abstractmethod
from typing import List


class IMFormatter(ABC):
    """
    Abstract base class for message formatters.

    Each IM platform implementation should provide a formatter that handles
    the conversion from standard Markdown to the platform's message format.
    """

    @abstractmethod
    def format_markdown(self, content: str) -> str:
        """
        Convert standard Markdown to platform-specific format.

        Args:
            content: Standard Markdown content

        Returns:
            Platform-specific formatted content
        """
        pass

    @abstractmethod
    def split_message(self, content: str) -> List[str]:
        """
        Split a long message into multiple messages.

        Each platform has message length limits. This method splits
        a long message into multiple messages that fit within the limits.

        Args:
            content: Original content

        Returns:
            List of message chunks
        """
        pass

    @abstractmethod
    def escape_special_chars(self, text: str) -> str:
        """
        Escape platform-specific special characters.

        Args:
            text: Text to escape

        Returns:
            Escaped text
        """
        pass

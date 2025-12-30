# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compression strategies for message history.

This module provides various strategies for compressing chat history
when it exceeds the model's context window limit.

Strategy priority (applied in order):
1. AttachmentTruncationStrategy - Truncate long attachment content
2. HistoryTruncationStrategy - Remove middle messages, keep first/last
"""

import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .config import CompressionConfig
from .token_counter import TokenCounter

logger = logging.getLogger(__name__)


@dataclass
class CompressionResult:
    """Result of a compression operation.

    Attributes:
        messages: Compressed messages
        original_tokens: Token count before compression
        compressed_tokens: Token count after compression
        strategies_applied: List of strategies that were applied
        details: Additional details about the compression
    """

    messages: list[dict[str, Any]]
    original_tokens: int
    compressed_tokens: int
    strategies_applied: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def was_compressed(self) -> bool:
        """Check if any compression was applied."""
        return len(self.strategies_applied) > 0

    @property
    def tokens_saved(self) -> int:
        """Calculate tokens saved by compression."""
        return self.original_tokens - self.compressed_tokens


class CompressionStrategy(ABC):
    """Abstract base class for compression strategies."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the name of this strategy."""
        ...

    @abstractmethod
    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        target_tokens: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Apply compression strategy to messages.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            target_tokens: Target token count to achieve
            config: Compression configuration

        Returns:
            Tuple of (compressed messages, compression details)
        """
        ...


class AttachmentTruncationStrategy(CompressionStrategy):
    """Strategy to truncate long attachment content in messages.

    This strategy identifies messages with embedded document/attachment content
    (typically prefixed with [Attachment N]) and truncates them to reduce tokens.

    This is the first strategy to apply as it preserves conversation flow
    while reducing token count from large documents.
    """

    @property
    def name(self) -> str:
        return "attachment_truncation"

    # Pattern to match attachment content blocks
    ATTACHMENT_PATTERN = re.compile(
        r"\[Attachment \d+(?:\s*-\s*[^\]]+)?\](.*?)(?=\[Attachment \d+|$)",
        re.DOTALL,
    )

    # Pattern for document content markers
    DOCUMENT_MARKERS = [
        "[Attachment",
        "--- Sheet:",
        "--- Slide",
        "[PDF Content]",
        "[Document Content]",
    ]

    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        target_tokens: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Truncate attachment content in messages.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            target_tokens: Target token count
            config: Compression configuration

        Returns:
            Tuple of (messages with truncated attachments, details)
        """
        compressed = []
        truncated_count = 0
        total_chars_removed = 0

        for msg in messages:
            content = msg.get("content", "")

            # Skip non-string content (multimodal messages handled separately)
            if not isinstance(content, str):
                compressed.append(msg)
                continue

            # Check if this message contains attachment content
            if not self._has_attachment_content(content):
                compressed.append(msg)
                continue

            # Truncate attachment content
            new_content, chars_removed = self._truncate_attachments(
                content,
                config.attachment_truncate_length,
                config.min_attachment_length,
            )

            if chars_removed > 0:
                truncated_count += 1
                total_chars_removed += chars_removed
                compressed.append({**msg, "content": new_content})
            else:
                compressed.append(msg)

        details = {
            "attachments_truncated": truncated_count,
            "chars_removed": total_chars_removed,
        }

        return compressed, details

    def _has_attachment_content(self, content: str) -> bool:
        """Check if content contains attachment markers."""
        return any(marker in content for marker in self.DOCUMENT_MARKERS)

    def _truncate_attachments(
        self, content: str, max_length: int, min_length: int
    ) -> tuple[str, int]:
        """Truncate attachment content within a message.

        Args:
            content: Message content
            max_length: Maximum length for each attachment
            min_length: Minimum length before truncation

        Returns:
            Tuple of (truncated content, characters removed)
        """
        total_removed = 0

        # Find and truncate attachment blocks
        def truncate_match(match: re.Match) -> str:
            nonlocal total_removed
            full_match = match.group(0)
            attachment_content = match.group(1) if match.lastindex else ""

            # Get the header (e.g., "[Attachment 1 - document.pdf]")
            header_end = full_match.find("]") + 1
            header = full_match[:header_end]

            if len(attachment_content) <= min_length:
                return full_match

            if len(attachment_content) > max_length:
                # Keep first portion and add truncation notice
                truncated = attachment_content[:max_length]
                removed = len(attachment_content) - max_length
                total_removed += removed

                truncation_notice = (
                    f"\n\n[... Content truncated. Original length: "
                    f"{len(attachment_content)} chars, showing first {max_length} chars ...]"
                )
                return header + truncated + truncation_notice

            return full_match

        # Process attachment blocks
        new_content = self.ATTACHMENT_PATTERN.sub(truncate_match, content)

        # Also handle general long content blocks without attachment markers
        # This handles cases like pasted code or long text
        if total_removed == 0 and len(content) > max_length * 2:
            # If content is very long but not marked as attachment,
            # try to find and truncate obvious document sections
            sections = self._find_long_sections(content, max_length)
            for start, end in reversed(sections):
                section = content[start:end]
                if len(section) > max_length:
                    truncated = section[:max_length]
                    notice = (
                        f"\n[... Section truncated. "
                        f"Original: {len(section)} chars ...]\n"
                    )
                    content = content[:start] + truncated + notice + content[end:]
                    total_removed += len(section) - max_length
            new_content = content

        return new_content, total_removed

    def _find_long_sections(
        self, content: str, threshold: int
    ) -> list[tuple[int, int]]:
        """Find long sections that could be truncated.

        Looks for patterns like code blocks, spreadsheet data, etc.
        """
        sections = []

        # Find code blocks (```...```)
        code_pattern = re.compile(r"```.*?```", re.DOTALL)
        for match in code_pattern.finditer(content):
            if len(match.group()) > threshold:
                sections.append((match.start(), match.end()))

        # Find spreadsheet-like content (| delimited rows)
        lines = content.split("\n")
        current_section_start = None
        table_lines = 0

        for i, line in enumerate(lines):
            if "|" in line and line.count("|") >= 2:
                if current_section_start is None:
                    current_section_start = sum(
                        len(l) + 1 for l in lines[:i]
                    )
                table_lines += 1
            else:
                if table_lines > 10:  # At least 10 rows
                    section_end = sum(len(l) + 1 for l in lines[:i])
                    section_len = section_end - current_section_start
                    if section_len > threshold:
                        sections.append((current_section_start, section_end))
                current_section_start = None
                table_lines = 0

        return sections


class HistoryTruncationStrategy(CompressionStrategy):
    """Strategy to truncate conversation history.

    This strategy removes messages from the middle of the conversation,
    keeping the first N messages (for context) and last M messages
    (for recent context).

    A notice is inserted where messages were removed to inform the model
    that some context is missing.
    """

    @property
    def name(self) -> str:
        return "history_truncation"

    TRUNCATION_NOTICE = (
        "[SYSTEM NOTICE: Earlier messages in this conversation have been "
        "summarized to fit within context limits. The conversation continues "
        "from the most recent messages below.]"
    )

    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        target_tokens: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Truncate conversation history to fit within token limit.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            target_tokens: Target token count
            config: Compression configuration

        Returns:
            Tuple of (truncated messages, details)
        """
        # Separate system message from conversation
        system_messages = []
        conversation_messages = []

        for msg in messages:
            if msg.get("role") == "system":
                system_messages.append(msg)
            else:
                conversation_messages.append(msg)

        # If conversation is small enough, no truncation needed
        if len(conversation_messages) <= (
            config.first_messages_to_keep + config.last_messages_to_keep
        ):
            return messages, {"messages_removed": 0}

        # Calculate tokens for system messages (these are always kept)
        system_tokens = sum(
            token_counter.count_message(msg) for msg in system_messages
        )

        # Calculate available tokens for conversation
        available_tokens = target_tokens - system_tokens

        # Get first and last messages
        first_messages = conversation_messages[: config.first_messages_to_keep]
        last_messages = conversation_messages[-config.last_messages_to_keep :]

        # Calculate tokens used by first and last messages
        first_tokens = sum(
            token_counter.count_message(msg) for msg in first_messages
        )
        last_tokens = sum(token_counter.count_message(msg) for msg in last_messages)

        # Check if we need to remove messages
        if first_tokens + last_tokens <= available_tokens:
            # Try to keep more middle messages if possible
            middle_start = config.first_messages_to_keep
            middle_end = len(conversation_messages) - config.last_messages_to_keep
            middle_messages = conversation_messages[middle_start:middle_end]

            # Greedily add middle messages from the end (more recent)
            kept_middle = []
            middle_tokens = 0

            for msg in reversed(middle_messages):
                msg_tokens = token_counter.count_message(msg)
                if first_tokens + last_tokens + middle_tokens + msg_tokens <= available_tokens:
                    kept_middle.insert(0, msg)
                    middle_tokens += msg_tokens
                else:
                    break

            if len(kept_middle) == len(middle_messages):
                # All messages fit, no truncation needed
                return messages, {"messages_removed": 0}

            # Build result with truncation notice
            truncation_notice_msg = {
                "role": "system",
                "content": self.TRUNCATION_NOTICE,
            }

            result = (
                system_messages
                + first_messages
                + [truncation_notice_msg]
                + kept_middle
                + last_messages
            )

            messages_removed = len(middle_messages) - len(kept_middle)
            details = {
                "messages_removed": messages_removed,
                "middle_messages_kept": len(kept_middle),
            }

            return result, details

        # First + last messages alone exceed limit
        # Need to be more aggressive - reduce last messages count
        reduced_last_count = config.last_messages_to_keep
        while reduced_last_count > 2:  # Keep at least 2 recent messages
            last_messages = conversation_messages[-reduced_last_count:]
            last_tokens = sum(
                token_counter.count_message(msg) for msg in last_messages
            )
            if first_tokens + last_tokens <= available_tokens:
                break
            reduced_last_count -= 1

        truncation_notice_msg = {
            "role": "system",
            "content": self.TRUNCATION_NOTICE,
        }

        result = (
            system_messages
            + first_messages
            + [truncation_notice_msg]
            + last_messages
        )

        messages_removed = (
            len(conversation_messages)
            - config.first_messages_to_keep
            - reduced_last_count
        )

        details = {
            "messages_removed": messages_removed,
            "last_messages_kept": reduced_last_count,
        }

        return result, details

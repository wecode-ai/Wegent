# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Compression strategies for message history.

This module provides various strategies for compressing chat history
when it exceeds the model's context window limit.

Strategy priority (applied in order, from least to most disruptive):
1. AttachmentTruncationStrategy - Truncate long attachment content (least important)
2. HistoryTruncationStrategy - Remove middle messages, keep first/last
3. ToolResultTruncationStrategy - Truncate long tool call results (most important, last resort)

New Compression Algorithm:
1. Calculate tokens to compress: current_tokens - target_tokens
2. Estimate each strategy's compressible tokens
3. Allocate tokens to compress to each strategy based on weight (proportional to potential)
4. Each strategy compresses EXACTLY the allocated amount (no over-compression)
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
class StrategyPotential:
    """Represents the compression potential of a strategy.

    Attributes:
        total_compressible_tokens: Total tokens that can potentially be compressed
        min_retention_ratio: Minimum retention ratio the strategy can go to
    """

    total_compressible_tokens: int = 0
    min_retention_ratio: float = 0.05  # Default minimum 5%

    @property
    def has_potential(self) -> bool:
        """Check if strategy still has compression potential."""
        return self.total_compressible_tokens > 0


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
    """Abstract base class for compression strategies.

    Each strategy estimates its compression potential and compresses
    EXACTLY the specified number of tokens when requested.
    """

    # Default weight for this strategy (higher = more preferred)
    DEFAULT_WEIGHT = 1.0

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the name of this strategy."""
        ...

    @property
    def weight(self) -> float:
        """Return the weight of this strategy for allocation."""
        return self.DEFAULT_WEIGHT

    @abstractmethod
    def estimate_potential(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        config: CompressionConfig,
    ) -> StrategyPotential:
        """Estimate the compression potential of this strategy.

        Args:
            messages: Messages to analyze
            token_counter: Token counter instance
            config: Compression configuration

        Returns:
            StrategyPotential with compression potential details
        """
        ...

    @abstractmethod
    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        tokens_to_reduce: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Apply compression strategy to reduce EXACTLY the specified number of tokens.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            tokens_to_reduce: Number of tokens to reduce (EXACTLY this amount)
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

    # Higher weight - prefer truncating attachments first
    DEFAULT_WEIGHT = 3.0

    # Minimum retention ratio (keep at least 2% of content)
    MIN_RETENTION_RATIO = 0.02

    @property
    def name(self) -> str:
        return "attachment_truncation"

    # Pattern to match attachment content blocks (supports both [Attachment N] and [File Content - xxx])
    ATTACHMENT_PATTERN = re.compile(
        r"\[(?:Attachment \d+|File Content)(?:\s*-\s*[^\]]+)?\](.*?)(?=\[(?:Attachment \d+|File Content)|$)",
        re.DOTALL,
    )

    # Pattern for document content markers
    DOCUMENT_MARKERS = [
        "[Attachment",
        "[File Content",  # New format for file attachments
        "--- Sheet:",
        "--- Slide",
        "[PDF Content]",
        "[Document Content]",
    ]

    def estimate_potential(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        config: CompressionConfig,
    ) -> StrategyPotential:
        """Estimate compression potential from attachments.

        Args:
            messages: Messages to analyze
            token_counter: Token counter instance
            config: Compression configuration

        Returns:
            StrategyPotential with attachment compression potential
        """
        # Debug: Log message content snippets to understand why attachments aren't found
        for idx, msg in enumerate(messages):
            content = msg.get("content", "")
            if isinstance(content, str):
                has_markers = self._has_attachment_content(content)
                content_preview = (
                    content[:200].replace("\n", " ")
                    if len(content) > 200
                    else content.replace("\n", " ")
                )
                logger.info(
                    "[AttachmentTruncation] Message %d (role=%s): len=%d, has_markers=%s, preview='%s...'",
                    idx,
                    msg.get("role", "unknown"),
                    len(content),
                    has_markers,
                    content_preview,
                )

        attachment_info = self._find_attachments(messages)
        total_chars = sum(info["length"] for info in attachment_info)

        logger.info(
            "[AttachmentTruncation] Found %d attachments with total %d chars in %d messages",
            len(attachment_info),
            total_chars,
            len(messages),
        )

        if total_chars == 0:
            return StrategyPotential()

        # Estimate chars per token
        chars_per_token = token_counter.CHARS_PER_TOKEN.get(
            token_counter.provider, token_counter.CHARS_PER_TOKEN["default"]
        )

        # Estimate total tokens in attachments
        total_attachment_tokens = int(total_chars / chars_per_token)

        # Compressible tokens = total - minimum to keep
        compressible_tokens = int(
            total_attachment_tokens * (1.0 - self.MIN_RETENTION_RATIO)
        )

        return StrategyPotential(
            total_compressible_tokens=compressible_tokens,
            min_retention_ratio=self.MIN_RETENTION_RATIO,
        )

    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        tokens_to_reduce: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Truncate attachment content to reduce EXACTLY the specified tokens.

        This method uses binary search to find the precise retention ratio
        that reduces exactly the requested number of tokens.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            tokens_to_reduce: Number of tokens to reduce (EXACTLY this amount)
            config: Compression configuration

        Returns:
            Tuple of (messages with truncated attachments, details)
        """
        min_length = config.min_attachment_length

        if tokens_to_reduce <= 0:
            return messages, {"attachments_truncated": 0, "chars_removed": 0}

        # Find all attachment content
        attachment_info = self._find_attachments(messages)
        total_attachment_chars = sum(info["length"] for info in attachment_info)

        if total_attachment_chars == 0:
            return messages, {"attachments_truncated": 0, "chars_removed": 0}

        # Get original token count
        original_tokens = token_counter.count_messages(messages)
        target_tokens = original_tokens - tokens_to_reduce

        logger.info(
            "[AttachmentTruncation] Compressing: tokens_to_reduce=%d, "
            "original_tokens=%d, target_tokens=%d, total_attachment_chars=%d",
            tokens_to_reduce,
            original_tokens,
            target_tokens,
            total_attachment_chars,
        )

        # Use binary search to find the right retention ratio
        # Goal: find the HIGHEST ratio that still meets the target (minimize over-compression)
        low_ratio = self.MIN_RETENTION_RATIO
        high_ratio = 1.0
        best_ratio = high_ratio
        best_compressed = messages
        best_tokens = original_tokens
        max_iterations = 15  # More iterations for better precision

        for iteration in range(max_iterations):
            mid_ratio = (low_ratio + high_ratio) / 2

            # Apply truncation with this ratio
            compressed, chars_removed = self._apply_truncation(
                messages, mid_ratio, min_length
            )
            current_tokens = token_counter.count_messages(compressed)

            logger.debug(
                "[AttachmentTruncation] Binary search iteration %d: "
                "ratio=%.4f, tokens=%d, target=%d",
                iteration,
                mid_ratio,
                current_tokens,
                target_tokens,
            )

            # Check if we're close enough to target (within 5% ABOVE target is acceptable)
            # We want to be AT or JUST BELOW target, not way below
            if (
                current_tokens <= target_tokens
                and current_tokens >= target_tokens * 0.95
            ):
                # Perfect: at target or just slightly below (within 5%)
                best_ratio = mid_ratio
                best_compressed = compressed
                best_tokens = current_tokens
                break

            if current_tokens > target_tokens:
                # Still over target, need more compression (lower ratio)
                high_ratio = mid_ratio
                # But also track this as a candidate if it's the closest we've been
            else:
                # Under target, can use less compression (higher ratio)
                # This is a valid result, track it
                if current_tokens > best_tokens or best_tokens > target_tokens:
                    best_ratio = mid_ratio
                    best_compressed = compressed
                    best_tokens = current_tokens
                low_ratio = mid_ratio

        # If we still haven't found a good result, do one more check
        # Use the best ratio we found that's under target
        if best_tokens > target_tokens:
            # Still over target after binary search, use minimum retention as last resort
            best_compressed, _ = self._apply_truncation(
                messages, self.MIN_RETENTION_RATIO, min_length
            )
            best_ratio = self.MIN_RETENTION_RATIO
            best_tokens = token_counter.count_messages(best_compressed)

        # Count truncated messages and chars removed
        truncated_count = 0
        total_chars_removed = 0
        for orig_msg, comp_msg in zip(messages, best_compressed):
            orig_content = orig_msg.get("content", "")
            comp_content = comp_msg.get("content", "")
            if isinstance(orig_content, str) and isinstance(comp_content, str):
                if len(comp_content) < len(orig_content):
                    truncated_count += 1
                    total_chars_removed += len(orig_content) - len(comp_content)

        final_tokens = token_counter.count_messages(best_compressed)
        actual_tokens_reduced = original_tokens - final_tokens

        logger.info(
            "[AttachmentTruncation] Complete: requested=%d, actual=%d tokens reduced, "
            "retention_ratio=%.4f, chars_removed=%d, truncated_count=%d",
            tokens_to_reduce,
            actual_tokens_reduced,
            best_ratio,
            total_chars_removed,
            truncated_count,
        )

        details = {
            "attachments_truncated": truncated_count,
            "chars_removed": total_chars_removed,
            "retention_ratio": best_ratio,
            "tokens_requested": tokens_to_reduce,
            "tokens_reduced": actual_tokens_reduced,
        }

        return best_compressed, details

    def _apply_truncation(
        self,
        messages: list[dict[str, Any]],
        retention_ratio: float,
        min_length: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Apply truncation with a specific retention ratio.

        Args:
            messages: Messages to truncate
            retention_ratio: Ratio of content to keep
            min_length: Minimum length to keep per attachment

        Returns:
            Tuple of (truncated messages, total chars removed)
        """
        compressed = []
        total_chars_removed = 0

        for msg in messages:
            content = msg.get("content", "")

            if not isinstance(content, str):
                compressed.append(msg)
                continue

            if not self._has_attachment_content(content):
                compressed.append(msg)
                continue

            new_content, chars_removed = self._truncate_attachments_proportionally(
                content,
                retention_ratio,
                min_length,
            )

            if chars_removed > 0:
                total_chars_removed += chars_removed
                compressed.append({**msg, "content": new_content})
            else:
                compressed.append(msg)

        return compressed, total_chars_removed

    def _find_attachments(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Find all attachment content in messages.

        Returns:
            List of dicts with message index and attachment length info
        """
        attachments = []
        for idx, msg in enumerate(messages):
            content = msg.get("content", "")
            if not isinstance(content, str):
                continue
            if not self._has_attachment_content(content):
                continue

            # Find attachment blocks and sum their lengths
            total_length = 0
            for match in self.ATTACHMENT_PATTERN.finditer(content):
                attachment_content = match.group(1) if match.lastindex else ""
                total_length += len(attachment_content)

            if total_length > 0:
                attachments.append(
                    {
                        "message_idx": idx,
                        "length": total_length,
                    }
                )

        return attachments

    def _truncate_attachments_proportionally(
        self, content: str, retention_ratio: float, min_length: int
    ) -> tuple[str, int]:
        """Truncate attachment content proportionally.

        Args:
            content: Message content
            retention_ratio: Ratio of content to keep (0.0-1.0)
            min_length: Minimum length to keep per attachment

        Returns:
            Tuple of (truncated content, characters removed)
        """
        total_removed = 0

        def truncate_match(match: re.Match) -> str:
            nonlocal total_removed
            full_match = match.group(0)
            attachment_content = match.group(1) if match.lastindex else ""

            # Get the header (e.g., "[Attachment 1 - document.pdf]")
            header_end = full_match.find("]") + 1
            header = full_match[:header_end]

            original_length = len(attachment_content)

            # Calculate target length based on retention ratio
            target_length = max(min_length, int(original_length * retention_ratio))

            if original_length <= target_length:
                return full_match

            # Keep beginning and end, truncate middle
            # Split target_length: 60% for beginning, 40% for ending
            begin_length = int(target_length * 0.6)
            end_length = target_length - begin_length

            begin_part = attachment_content[:begin_length]
            end_part = attachment_content[-end_length:] if end_length > 0 else ""

            removed = original_length - target_length
            total_removed += removed

            truncation_notice = (
                f"\n\n[... Middle content truncated. "
                f"Original: {original_length} chars, "
                f"kept {target_length} chars ({retention_ratio:.1%}), "
                f"removed {removed} chars from middle ...]\n\n"
            )
            return header + begin_part + truncation_notice + end_part

        # Process attachment blocks
        new_content = self.ATTACHMENT_PATTERN.sub(truncate_match, content)

        return new_content, total_removed

    def _calculate_recency_factor(self, index: int, total: int) -> float:
        """Calculate recency factor for a message based on its position.

        Older messages (lower index) get smaller factors (more truncation).
        Recent messages (higher index) get larger factors (less truncation).

        The factor ranges from 0.25 (oldest) to 1.0 (newest).

        Args:
            index: Message index (0-based)
            total: Total number of messages

        Returns:
            Recency factor between 0.25 and 1.0
        """
        if total <= 1:
            return 1.0

        # Linear interpolation from 0.25 to 1.0
        # index 0 -> 0.25, index (total-1) -> 1.0
        min_factor = 0.25
        max_factor = 1.0
        return min_factor + (max_factor - min_factor) * (index / (total - 1))

    def _has_attachment_content(self, content: str) -> bool:
        """Check if content contains attachment markers."""
        return any(marker in content for marker in self.DOCUMENT_MARKERS)


class HistoryTruncationStrategy(CompressionStrategy):
    """Strategy to truncate conversation history.

    This strategy removes messages from the middle of the conversation,
    keeping the first N messages (for context) and last M messages
    (for recent context).

    A notice is inserted where messages were removed to inform the model
    that some context is missing.
    """

    # Medium weight - use after attachments
    DEFAULT_WEIGHT = 2.0

    # Minimum messages to keep at each end
    MIN_FIRST_MESSAGES = 1
    MIN_LAST_MESSAGES = 2

    @property
    def name(self) -> str:
        return "history_truncation"

    TRUNCATION_NOTICE = (
        "[SYSTEM NOTICE: Earlier messages in this conversation have been "
        "summarized to fit within context limits. The conversation continues "
        "from the most recent messages below.]"
    )

    def estimate_potential(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        config: CompressionConfig,
    ) -> StrategyPotential:
        """Estimate compression potential from history truncation.

        Args:
            messages: Messages to analyze
            token_counter: Token counter instance
            config: Compression configuration

        Returns:
            StrategyPotential with history truncation potential
        """
        # Separate system messages from conversation
        system_messages = []
        conversation_messages = []

        for msg in messages:
            if msg.get("role") == "system":
                system_messages.append(msg)
            else:
                conversation_messages.append(msg)

        # Calculate tokens for middle messages (removable)
        first_count = config.first_messages_to_keep
        last_count = config.last_messages_to_keep

        if len(conversation_messages) <= first_count + last_count:
            return StrategyPotential()

        middle_start = first_count
        middle_end = len(conversation_messages) - last_count
        middle_messages = conversation_messages[middle_start:middle_end]

        middle_tokens = sum(token_counter.count_message(msg) for msg in middle_messages)

        return StrategyPotential(
            total_compressible_tokens=middle_tokens,
            min_retention_ratio=0.0,  # Can remove all middle messages
        )

    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        tokens_to_reduce: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Truncate conversation history to reduce EXACTLY the specified tokens.

        This strategy removes messages from the middle until the requested
        token reduction is achieved. It stops as soon as the target is reached.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            tokens_to_reduce: Number of tokens to reduce (EXACTLY this amount)
            config: Compression configuration

        Returns:
            Tuple of (truncated messages, details)
        """
        if tokens_to_reduce <= 0:
            return messages, {"messages_removed": 0}

        # Separate system message from conversation
        system_messages = []
        conversation_messages = []

        for msg in messages:
            if msg.get("role") == "system":
                system_messages.append(msg)
            else:
                conversation_messages.append(msg)

        first_to_keep = config.first_messages_to_keep
        last_to_keep = config.last_messages_to_keep

        # If conversation is small enough, no truncation possible
        if len(conversation_messages) <= (first_to_keep + last_to_keep):
            return messages, {"messages_removed": 0}

        # Get first and last messages
        first_messages = conversation_messages[:first_to_keep]
        last_messages = conversation_messages[-last_to_keep:]

        # Get middle messages (candidates for removal)
        middle_start = first_to_keep
        middle_end = len(conversation_messages) - last_to_keep
        middle_messages = conversation_messages[middle_start:middle_end]

        # Calculate tokens for each middle message
        middle_message_tokens = [
            (msg, token_counter.count_message(msg)) for msg in middle_messages
        ]

        # Remove messages from the beginning of middle (oldest first)
        # Stop as soon as we reach the target (don't over-compress)
        tokens_removed = 0
        messages_to_remove = 0

        for msg, msg_tokens in middle_message_tokens:
            if tokens_removed >= tokens_to_reduce:
                break
            tokens_removed += msg_tokens
            messages_to_remove += 1

        # Keep remaining middle messages
        kept_middle = middle_messages[messages_to_remove:]

        logger.info(
            "[HistoryTruncation] Compressing: tokens_to_reduce=%d, "
            "messages_removed=%d, tokens_removed=%d, middle_kept=%d",
            tokens_to_reduce,
            messages_to_remove,
            tokens_removed,
            len(kept_middle),
        )

        # Build result with truncation notice if any messages were removed
        if messages_to_remove > 0:
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
        else:
            result = messages

        details = {
            "messages_removed": messages_to_remove,
            "middle_messages_kept": len(kept_middle),
            "tokens_requested": tokens_to_reduce,
            "tokens_reduced": tokens_removed,
        }

        return result, details


class ToolResultTruncationStrategy(CompressionStrategy):
    """Strategy to truncate long tool call results in messages.

    This strategy identifies tool result messages and truncates their content
    when they are too long. Tool results often contain verbose output from
    file reads, command executions, or API responses.

    This is the LAST strategy to apply as tool results are important for
    maintaining conversation context. Only truncate when other strategies
    have failed to bring tokens under the limit.
    """

    # Lower weight - use as last resort
    DEFAULT_WEIGHT = 1.0

    # Minimum retention ratio
    MIN_RETENTION_RATIO = 0.02

    @property
    def name(self) -> str:
        return "tool_result_truncation"

    # Patterns to identify tool result content
    TOOL_RESULT_MARKERS = [
        "Tool Result:",
        "[Tool Output]",
        "```output",
        "Result:",
        "<tool_result>",
    ]

    def estimate_potential(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        config: CompressionConfig,
    ) -> StrategyPotential:
        """Estimate compression potential from tool results.

        Args:
            messages: Messages to analyze
            token_counter: Token counter instance
            config: Compression configuration

        Returns:
            StrategyPotential with tool result compression potential
        """
        total_tokens = 0

        for msg in messages:
            content = msg.get("content", "")
            role = msg.get("role", "")

            if not isinstance(content, str):
                continue

            is_tool_result = role == "tool" or self._has_tool_result_content(content)

            if is_tool_result:
                total_tokens += token_counter.count_message(msg)

        if total_tokens == 0:
            return StrategyPotential()

        # Compressible tokens = total - minimum to keep
        compressible_tokens = int(total_tokens * (1.0 - self.MIN_RETENTION_RATIO))

        return StrategyPotential(
            total_compressible_tokens=compressible_tokens,
            min_retention_ratio=self.MIN_RETENTION_RATIO,
        )

    def compress(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        tokens_to_reduce: int,
        config: CompressionConfig,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Truncate tool result content to reduce EXACTLY the specified tokens.

        This method uses binary search to find the precise retention ratio
        that reduces exactly the requested number of tokens.

        Args:
            messages: Messages to compress
            token_counter: Token counter instance
            tokens_to_reduce: Number of tokens to reduce (EXACTLY this amount)
            config: Compression configuration

        Returns:
            Tuple of (messages with truncated tool results, details)
        """
        if tokens_to_reduce <= 0:
            return messages, {"tool_results_truncated": 0, "chars_removed": 0}

        # Find all tool results
        tool_result_info = self._find_tool_results(messages, token_counter)
        if not tool_result_info:
            return messages, {"tool_results_truncated": 0, "chars_removed": 0}

        # Get original token count
        original_tokens = token_counter.count_messages(messages)
        target_tokens = original_tokens - tokens_to_reduce

        logger.info(
            "[ToolResultTruncation] Compressing: tokens_to_reduce=%d, "
            "original_tokens=%d, target_tokens=%d",
            tokens_to_reduce,
            original_tokens,
            target_tokens,
        )

        # Use binary search to find the right retention ratio
        # Use binary search to find the right retention ratio
        # Goal: find the HIGHEST ratio that still meets the target (minimize over-compression)
        low_ratio = self.MIN_RETENTION_RATIO
        high_ratio = 1.0
        best_ratio = high_ratio
        best_compressed = messages
        best_tokens = original_tokens
        max_iterations = 15  # More iterations for better precision

        for iteration in range(max_iterations):
            mid_ratio = (low_ratio + high_ratio) / 2

            # Apply truncation with this ratio
            compressed, chars_removed, truncated_count = self._truncate_tool_results(
                messages,
                token_counter,
                mid_ratio,
            )
            current_tokens = token_counter.count_messages(compressed)

            logger.debug(
                "[ToolResultTruncation] Binary search iteration %d: "
                "ratio=%.4f, tokens=%d, target=%d",
                iteration,
                mid_ratio,
                current_tokens,
                target_tokens,
            )

            # Check if we're close enough to target (within 5% ABOVE target is acceptable)
            # We want to be AT or JUST BELOW target, not way below
            if (
                current_tokens <= target_tokens
                and current_tokens >= target_tokens * 0.95
            ):
                # Perfect: at target or just slightly below (within 5%)
                best_ratio = mid_ratio
                best_compressed = compressed
                best_tokens = current_tokens
                break

            if current_tokens > target_tokens:
                # Still over target, need more compression (lower ratio)
                high_ratio = mid_ratio
            else:
                # Under target, can use less compression (higher ratio)
                # This is a valid result, track it
                if current_tokens > best_tokens or best_tokens > target_tokens:
                    best_ratio = mid_ratio
                    best_compressed = compressed
                    best_tokens = current_tokens
                low_ratio = mid_ratio

        # If we still haven't found a good result under target
        if best_tokens > target_tokens:
            # Still over target after binary search, use minimum retention as last resort
            best_compressed, _, _ = self._truncate_tool_results(
                messages,
                token_counter,
                self.MIN_RETENTION_RATIO,
            )
            best_ratio = self.MIN_RETENTION_RATIO
            best_tokens = token_counter.count_messages(best_compressed)
        # Count truncated messages and chars removed
        truncated_count = 0
        total_chars_removed = 0
        for orig_msg, comp_msg in zip(messages, best_compressed):
            orig_content = orig_msg.get("content", "")
            comp_content = comp_msg.get("content", "")
            if isinstance(orig_content, str) and isinstance(comp_content, str):
                if len(comp_content) < len(orig_content):
                    truncated_count += 1
                    total_chars_removed += len(orig_content) - len(comp_content)

        final_tokens = token_counter.count_messages(best_compressed)
        actual_tokens_reduced = original_tokens - final_tokens

        logger.info(
            "[ToolResultTruncation] Complete: requested=%d, actual=%d tokens reduced, "
            "retention_ratio=%.4f, chars_removed=%d, truncated_count=%d",
            tokens_to_reduce,
            actual_tokens_reduced,
            best_ratio,
            total_chars_removed,
            truncated_count,
        )

        details = {
            "tool_results_truncated": truncated_count,
            "chars_removed": total_chars_removed,
            "retention_ratio": best_ratio,
            "tokens_requested": tokens_to_reduce,
            "tokens_reduced": actual_tokens_reduced,
        }

        return best_compressed, details

    def _find_tool_results(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
    ) -> list[dict[str, Any]]:
        """Find all tool result content in messages.

        Returns:
            List of dicts with message index and token count info
        """
        tool_results = []
        for idx, msg in enumerate(messages):
            content = msg.get("content", "")
            role = msg.get("role", "")

            if not isinstance(content, str):
                continue

            is_tool_result = role == "tool" or self._has_tool_result_content(content)

            if is_tool_result:
                tokens = token_counter.count_message(msg)
                tool_results.append(
                    {
                        "message_idx": idx,
                        "tokens": tokens,
                        "chars": len(content),
                    }
                )

        return tool_results

    def _truncate_tool_results(
        self,
        messages: list[dict[str, Any]],
        token_counter: TokenCounter,
        retention_ratio: float,
    ) -> tuple[list[dict[str, Any]], int, int]:
        """Truncate tool result content with the specified retention ratio.

        Args:
            messages: Messages to process
            token_counter: Token counter instance
            retention_ratio: Retention ratio to apply

        Returns:
            Tuple of (processed messages, total chars removed, count of truncated messages)
        """
        compressed = []
        truncated_count = 0
        total_chars_removed = 0

        for idx, msg in enumerate(messages):
            content = msg.get("content", "")
            role = msg.get("role", "")

            # Skip non-string content
            if not isinstance(content, str):
                compressed.append(msg)
                continue

            # Check if this is a tool result message
            is_tool_result = role == "tool" or self._has_tool_result_content(content)

            if not is_tool_result:
                compressed.append(msg)
                continue

            # Calculate target length based on retention ratio
            original_length = len(content)
            target_length = max(100, int(original_length * retention_ratio))

            if original_length <= target_length:
                compressed.append(msg)
                continue

            # Truncate content
            new_content, chars_removed = self._truncate_content(
                content,
                target_length,
            )

            if chars_removed > 0:
                truncated_count += 1
                total_chars_removed += chars_removed
                compressed.append({**msg, "content": new_content})
            else:
                compressed.append(msg)

        return compressed, total_chars_removed, truncated_count

    def _has_tool_result_content(self, content: str) -> bool:
        """Check if content contains tool result markers."""
        return any(marker in content for marker in self.TOOL_RESULT_MARKERS)

    def _truncate_content(self, content: str, target_length: int) -> tuple[str, int]:
        """Truncate content keeping beginning and end, removing middle.

        Args:
            content: Content to truncate
            target_length: Target length to keep

        Returns:
            Tuple of (truncated content, characters removed)
        """
        if len(content) <= target_length:
            return content, 0

        # Keep beginning and end, truncate middle
        # Split target_length: 60% for beginning, 40% for ending
        begin_length = int(target_length * 0.6)
        end_length = target_length - begin_length

        begin_part = content[:begin_length]
        end_part = content[-end_length:] if end_length > 0 else ""

        removed = len(content) - target_length

        truncation_notice = (
            f"\n\n[... Tool output truncated. "
            f"Original: {len(content)} chars, "
            f"removed {removed} chars from middle, "
            f"keeping first {begin_length} and last {end_length} chars ...]\n\n"
        )

        return begin_part + truncation_notice + end_part, removed

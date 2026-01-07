# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Main message compressor that orchestrates compression strategies.

This module provides the MessageCompressor class that applies various
compression strategies to reduce message history size when it exceeds
the model's context window limit.

Compression Algorithm:
1. Trigger: When current_tokens > trigger_limit (90% of available context)
2. Target: Compress to target_limit (70% of available context)
3. Phase 1 - Sequential Strategy Application:
   - Apply each strategy in order (from least to most disruptive)
   - After each strategy, check if target is reached
   - If target reached, return immediately
4. Phase 2 - Potential-based Weighted Iteration (if Phase 1 didn't reach target):
   - Collect remaining potential from each strategy
   - Allocate tokens to reduce based on weighted potential
   - Apply strategies with allocated budgets
   - Repeat for up to 2 additional iterations
"""

import logging
from dataclasses import dataclass
from typing import Any

from .config import (
    CompressionConfig,
    get_model_context_config,
)
from .strategies import (
    AttachmentTruncationStrategy,
    CompressionResult,
    CompressionStrategy,
    HistoryTruncationStrategy,
    StrategyPotential,
    ToolResultTruncationStrategy,
)
from .token_counter import TokenCounter

logger = logging.getLogger(__name__)

# Maximum number of weighted iterations in Phase 2
MAX_WEIGHTED_ITERATIONS = 2


@dataclass
class StrategyAllocation:
    """Allocation of tokens to compress for a strategy.

    Attributes:
        strategy: The compression strategy
        potential: The strategy's compression potential
        allocated_tokens: Number of tokens allocated to compress
        weight: The strategy's weight for allocation
        tokens_reduced_so_far: Tokens already reduced by this strategy
    """

    strategy: CompressionStrategy
    potential: StrategyPotential
    allocated_tokens: int = 0
    weight: float = 1.0
    tokens_reduced_so_far: int = 0


class MessageCompressor:
    """Compressor for chat message history.

    This class applies multiple compression strategies to reduce
    the token count of message history to fit within model context limits.

    Algorithm:
    Phase 1 - Sequential Strategy Application:
    1. Check if current_tokens > trigger_limit (90% of context)
    2. If triggered, apply each strategy sequentially
    3. After each strategy, check if target_limit is reached
    4. If target reached, return immediately

    Phase 2 - Potential-based Weighted Iteration (if Phase 1 didn't reach target):
    1. Collect remaining potential from each strategy
    2. Allocate tokens to reduce based on weighted potential
    3. Apply strategies with allocated budgets
    4. Repeat for up to MAX_WEIGHTED_ITERATIONS (2) additional rounds

    Phase 3 - Forced Compression (if still not at target):
    1. Apply aggressive compression to guarantee target is reached
    2. This ensures the model never receives messages exceeding context limit

    Strategies are applied in order of preference (from least to most disruptive):
    1. History truncation (removes middle messages, keeps first/last)
    2. Attachment truncation (truncate long attachment content)
    3. Tool result truncation (most disruptive - last resort)

    Usage:
        compressor = MessageCompressor(model_id="claude-3-5-sonnet-20241022")
        result = compressor.compress_if_needed(messages)
        if result.was_compressed:
            print(f"Saved {result.tokens_saved} tokens")
    """

    def __init__(
        self,
        model_id: str,
        config: CompressionConfig | None = None,
        strategies: list[CompressionStrategy] | None = None,
        model_config: dict[str, Any] | None = None,
    ):
        """Initialize message compressor.

        Args:
            model_id: Model identifier for context limit lookup
            config: Optional compression configuration (uses settings if not provided)
            strategies: Optional list of strategies (uses defaults if not provided)
            model_config: Optional model configuration from Model CRD spec
                         (contains context_window, max_output_tokens from model_resolver)
        """
        self.model_id = model_id
        self.config = config or CompressionConfig.from_settings()
        self.model_context = get_model_context_config(model_id, model_config)
        self.token_counter = TokenCounter(model_id)

        # Default strategies in order of application (from least to most disruptive)
        self.strategies = strategies or [
            HistoryTruncationStrategy(),
            AttachmentTruncationStrategy(),
            ToolResultTruncationStrategy(),
        ]

        logger.debug(
            "[MessageCompressor] Initialized for model=%s, "
            "context_window=%d, trigger_limit=%d (%.0f%%), target_limit=%d (%.0f%%)",
            model_id,
            self.model_context.context_window,
            self.model_context.trigger_limit,
            self.model_context.trigger_threshold * 100,
            self.model_context.target_limit,
            self.model_context.target_threshold * 100,
        )

    @property
    def trigger_limit(self) -> int:
        """Get trigger token limit for this model."""
        return self.model_context.trigger_limit

    @property
    def target_limit(self) -> int:
        """Get target token limit for this model."""
        return self.model_context.target_limit

    @property
    def effective_limit(self) -> int:
        """Get effective token limit (alias for trigger_limit for backward compatibility)."""
        return self.model_context.effective_limit

    def count_tokens(self, messages: list[dict[str, Any]]) -> int:
        """Count tokens in messages.

        Args:
            messages: List of message dictionaries

        Returns:
            Token count
        """
        return self.token_counter.count_messages(messages)

    def is_over_limit(self, messages: list[dict[str, Any]]) -> bool:
        """Check if messages exceed the trigger limit.

        Args:
            messages: List of message dictionaries

        Returns:
            True if messages exceed the trigger limit
        """
        return self.token_counter.is_over_limit(messages, self.trigger_limit)

    def _estimate_potentials(
        self, messages: list[dict[str, Any]]
    ) -> list[StrategyAllocation]:
        """Estimate compression potential for each strategy.

        Args:
            messages: Messages to analyze

        Returns:
            List of StrategyAllocation with potential info
        """
        allocations = []
        for strategy in self.strategies:
            potential = strategy.estimate_potential(
                messages, self.token_counter, self.config
            )
            allocations.append(
                StrategyAllocation(
                    strategy=strategy,
                    potential=potential,
                    weight=strategy.weight,
                )
            )
        return allocations

    def _allocate_tokens(
        self,
        allocations: list[StrategyAllocation],
        tokens_to_reduce: int,
    ) -> list[StrategyAllocation]:
        """Allocate tokens to compress to each strategy based on weighted potential.

        The allocation algorithm:
        1. Calculate total weighted potential
        2. Allocate tokens proportionally based on weight * potential
        3. Cap each allocation at the strategy's maximum potential

        Args:
            allocations: List of strategy allocations with potential info
            tokens_to_reduce: Total tokens to reduce

        Returns:
            Updated allocations with allocated_tokens set
        """
        # Calculate total weighted potential
        total_weighted_potential = sum(
            alloc.potential.total_compressible_tokens * alloc.weight
            for alloc in allocations
            if alloc.potential.has_potential
        )

        if total_weighted_potential == 0:
            logger.warning("[MessageCompressor] No compression potential available")
            return allocations

        # Allocate tokens proportionally
        remaining_to_allocate = tokens_to_reduce

        for alloc in allocations:
            if not alloc.potential.has_potential:
                alloc.allocated_tokens = 0
                continue

            # Calculate proportional allocation based on weighted potential
            weighted_potential = (
                alloc.potential.total_compressible_tokens * alloc.weight
            )
            proportion = weighted_potential / total_weighted_potential

            # Allocate tokens, capped at strategy's maximum potential
            allocated = min(
                int(tokens_to_reduce * proportion),
                alloc.potential.total_compressible_tokens,
            )
            alloc.allocated_tokens = allocated
            remaining_to_allocate -= allocated

        # If there's remaining tokens to allocate (due to rounding or caps),
        # distribute to strategies that still have capacity
        if remaining_to_allocate > 0:
            for alloc in allocations:
                if not alloc.potential.has_potential:
                    continue

                remaining_capacity = (
                    alloc.potential.total_compressible_tokens - alloc.allocated_tokens
                )
                if remaining_capacity > 0:
                    additional = min(remaining_to_allocate, remaining_capacity)
                    alloc.allocated_tokens += additional
                    remaining_to_allocate -= additional

                if remaining_to_allocate <= 0:
                    break

        # Log allocation details
        for alloc in allocations:
            if alloc.allocated_tokens > 0:
                logger.info(
                    "[MessageCompressor] Allocation: %s - potential=%d, weight=%.1f, allocated=%d tokens",
                    alloc.strategy.name,
                    alloc.potential.total_compressible_tokens,
                    alloc.weight,
                    alloc.allocated_tokens,
                )

        return allocations

    def compress_if_needed(self, messages: list[dict[str, Any]]) -> CompressionResult:
        """Compress messages if they exceed the trigger limit.

        This method checks if messages exceed the model's trigger limit
        and applies compression strategies to reach the target limit.

        The algorithm guarantees that the final token count will be at or below
        the target limit to prevent model context overflow errors.

        Args:
            messages: List of message dictionaries

        Returns:
            CompressionResult with compressed messages and details
        """
        if not self.config.enabled:
            # Skip token counting when compression is disabled for performance
            return CompressionResult(
                messages=messages,
                original_tokens=0,
                compressed_tokens=0,
            )

        original_tokens = self.count_tokens(messages)

        logger.debug(
            "[MessageCompressor] Checking compression: "
            "original_tokens=%d, trigger_limit=%d, target_limit=%d, over_limit=%s",
            original_tokens,
            self.trigger_limit,
            self.target_limit,
            original_tokens > self.trigger_limit,
        )

        # If under trigger limit, no compression needed
        if original_tokens <= self.trigger_limit:
            return CompressionResult(
                messages=messages,
                original_tokens=original_tokens,
                compressed_tokens=original_tokens,
            )

        logger.info(
            "[MessageCompressor] Compression triggered: "
            "need to reduce from %d to target %d",
            original_tokens,
            self.target_limit,
        )

        current_messages = messages
        strategies_applied: list[str] = []
        all_details: dict[str, Any] = {}

        # ========== Phase 1: Sequential Strategy Application ==========
        # Apply each strategy in order, check if target reached after each
        logger.info("[MessageCompressor] Phase 1: Sequential strategy application")

        for strategy in self.strategies:
            current_tokens = self.token_counter.count_messages(current_messages)

            # Check if we've reached target
            if current_tokens <= self.target_limit:
                logger.info(
                    "[MessageCompressor] Phase 1: Target reached after %s, "
                    "current=%d <= target=%d",
                    strategies_applied[-1] if strategies_applied else "no strategy",
                    current_tokens,
                    self.target_limit,
                )
                break

            # Calculate tokens to reduce for this strategy
            tokens_to_reduce = current_tokens - self.target_limit

            # Estimate potential for this strategy
            potential = strategy.estimate_potential(
                current_messages, self.token_counter, self.config
            )

            if not potential.has_potential:
                logger.debug(
                    "[MessageCompressor] Phase 1: Strategy %s has no potential, skipping",
                    strategy.name,
                )
                continue

            logger.info(
                "[MessageCompressor] Phase 1: Applying %s, "
                "tokens_to_reduce=%d, potential=%d",
                strategy.name,
                tokens_to_reduce,
                potential.total_compressible_tokens,
            )

            # Apply strategy with full tokens_to_reduce (strategy will cap at its potential)
            compressed, details = strategy.compress(
                current_messages,
                self.token_counter,
                tokens_to_reduce,
                self.config,
            )

            new_tokens = self.token_counter.count_messages(compressed)
            tokens_saved = current_tokens - new_tokens

            if tokens_saved > 0:
                current_messages = compressed
                strategies_applied.append(strategy.name)
                all_details[f"phase1_{strategy.name}"] = details

                logger.info(
                    "[MessageCompressor] Phase 1: %s saved %d tokens: %d -> %d",
                    strategy.name,
                    tokens_saved,
                    current_tokens,
                    new_tokens,
                )

        # ========== Phase 2: Potential-based Weighted Iteration ==========
        # If still over target, iterate with weighted allocation based on remaining potential
        current_tokens = self.token_counter.count_messages(current_messages)

        for iteration in range(MAX_WEIGHTED_ITERATIONS):
            if current_tokens <= self.target_limit:
                break

            logger.info(
                "[MessageCompressor] Phase 2: Iteration %d, "
                "current=%d, target=%d, need to reduce=%d",
                iteration + 1,
                current_tokens,
                self.target_limit,
                current_tokens - self.target_limit,
            )

            # Re-estimate potentials on current messages
            allocations = self._estimate_potentials(current_messages)

            # Calculate total remaining potential
            total_potential = sum(
                alloc.potential.total_compressible_tokens
                for alloc in allocations
                if alloc.potential.has_potential
            )

            if total_potential == 0:
                logger.warning(
                    "[MessageCompressor] Phase 2: No remaining potential in iteration %d",
                    iteration + 1,
                )
                break

            tokens_to_reduce = current_tokens - self.target_limit

            # Allocate tokens based on weighted potential
            allocations = self._allocate_tokens(allocations, tokens_to_reduce)

            # Apply each strategy with its allocated budget
            for alloc in allocations:
                if alloc.allocated_tokens <= 0:
                    continue

                tokens_before = self.token_counter.count_messages(current_messages)

                compressed, details = alloc.strategy.compress(
                    current_messages,
                    self.token_counter,
                    alloc.allocated_tokens,
                    self.config,
                )

                new_tokens = self.token_counter.count_messages(compressed)
                tokens_saved = tokens_before - new_tokens

                if tokens_saved > 0:
                    current_messages = compressed
                    strategy_key = f"phase2_iter{iteration + 1}_{alloc.strategy.name}"
                    if alloc.strategy.name not in strategies_applied:
                        strategies_applied.append(alloc.strategy.name)
                    all_details[strategy_key] = details

                    logger.info(
                        "[MessageCompressor] Phase 2 iter %d: %s saved %d tokens: %d -> %d",
                        iteration + 1,
                        alloc.strategy.name,
                        tokens_saved,
                        tokens_before,
                        new_tokens,
                    )

            current_tokens = self.token_counter.count_messages(current_messages)

        # ========== Phase 3: Forced Compression (Guarantee Target) ==========
        # If still over target after all iterations, force compression to guarantee target
        current_tokens = self.token_counter.count_messages(current_messages)

        if current_tokens > self.target_limit:
            logger.warning(
                "[MessageCompressor] Phase 3: Forcing compression to guarantee target, "
                "current=%d, target=%d",
                current_tokens,
                self.target_limit,
            )

            current_messages, force_details = self._force_compression_to_target(
                current_messages, self.target_limit
            )
            all_details["phase3_forced"] = force_details

            if "forced_truncation" not in strategies_applied:
                strategies_applied.append("forced_truncation")

        compressed_tokens = self.token_counter.count_messages(current_messages)

        # Log final result
        logger.info(
            "[MessageCompressor] Compression complete: "
            "%d -> %d tokens (saved %d, target was %d), strategies: %s",
            original_tokens,
            compressed_tokens,
            original_tokens - compressed_tokens,
            self.target_limit,
            ", ".join(strategies_applied) if strategies_applied else "none",
        )

        if compressed_tokens <= self.target_limit:
            logger.info(
                "[MessageCompressor] Target achieved: %d <= %d",
                compressed_tokens,
                self.target_limit,
            )
        else:
            # This should never happen with forced compression
            logger.error(
                "[MessageCompressor] CRITICAL: Failed to reach target: %d > %d",
                compressed_tokens,
                self.target_limit,
            )

        return CompressionResult(
            messages=current_messages,
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            strategies_applied=strategies_applied,
            details=all_details,
        )

    def _force_compression_to_target(
        self,
        messages: list[dict[str, Any]],
        target_tokens: int,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Force compression to guarantee target token count is reached.

        This is the last resort when normal strategies fail to reach target.
        It aggressively truncates messages to ensure the model won't error.

        Strategy:
        1. Keep system messages and first/last user messages
        2. Aggressively truncate all content until target is reached
        3. Remove middle messages if necessary

        Args:
            messages: Messages to compress
            target_tokens: Target token count to reach

        Returns:
            Tuple of (compressed messages, details)
        """
        current_tokens = self.token_counter.count_messages(messages)
        details: dict[str, Any] = {
            "initial_tokens": current_tokens,
            "target_tokens": target_tokens,
            "actions": [],
        }

        if current_tokens <= target_tokens:
            return messages, details

        # Separate system messages from conversation
        system_messages = []
        conversation_messages = []

        for msg in messages:
            if msg.get("role") == "system":
                system_messages.append(msg)
            else:
                conversation_messages.append(msg)

        # Step 1: Aggressively truncate all non-system message content
        truncated_messages = []
        for msg in conversation_messages:
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > 500:
                # Keep first 300 and last 100 chars
                truncated_content = (
                    content[:300]
                    + "\n\n[... content truncated to fit context limit ...]\n\n"
                    + content[-100:]
                )
                truncated_messages.append({**msg, "content": truncated_content})
            else:
                truncated_messages.append(msg)

        result = system_messages + truncated_messages
        current_tokens = self.token_counter.count_messages(result)
        details["actions"].append(f"truncated_content: {current_tokens} tokens")

        if current_tokens <= target_tokens:
            details["final_tokens"] = current_tokens
            return result, details

        # Step 2: Remove middle messages progressively
        # Keep first 2 and last 3 conversation messages minimum
        min_first = 2
        min_last = 3

        while current_tokens > target_tokens and len(truncated_messages) > (
            min_first + min_last
        ):
            # Remove from middle
            middle_idx = len(truncated_messages) // 2
            removed_msg = truncated_messages.pop(middle_idx)
            details["actions"].append(
                f"removed_middle_message: role={removed_msg.get('role')}"
            )

            result = system_messages + truncated_messages
            current_tokens = self.token_counter.count_messages(result)

        details["actions"].append(f"after_middle_removal: {current_tokens} tokens")

        if current_tokens <= target_tokens:
            details["final_tokens"] = current_tokens
            return result, details

        # Step 3: More aggressive content truncation
        final_messages = []
        for msg in truncated_messages:
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > 200:
                # Keep only first 150 and last 50 chars
                truncated_content = (
                    content[:150] + "\n[...truncated...]\n" + content[-50:]
                )
                final_messages.append({**msg, "content": truncated_content})
            else:
                final_messages.append(msg)

        result = system_messages + final_messages
        current_tokens = self.token_counter.count_messages(result)
        details["actions"].append(f"aggressive_truncation: {current_tokens} tokens")

        # Step 4: If still over, truncate system messages too
        if current_tokens > target_tokens:
            truncated_system = []
            for msg in system_messages:
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) > 1000:
                    truncated_content = (
                        content[:800]
                        + "\n\n[... system prompt truncated ...]\n\n"
                        + content[-100:]
                    )
                    truncated_system.append({**msg, "content": truncated_content})
                else:
                    truncated_system.append(msg)

            result = truncated_system + final_messages
            current_tokens = self.token_counter.count_messages(result)
            details["actions"].append(f"system_truncation: {current_tokens} tokens")

        # Step 5: Last resort - keep only essential messages
        if current_tokens > target_tokens and len(final_messages) > 2:
            # Keep only first and last conversation message
            essential_messages = [final_messages[0], final_messages[-1]]
            result = system_messages + essential_messages
            current_tokens = self.token_counter.count_messages(result)
            details["actions"].append(f"essential_only: {current_tokens} tokens")

        details["final_tokens"] = current_tokens
        details["messages_kept"] = len(result)

        return result, details

    def compress(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convenience method to compress messages and return only the result.

        Args:
            messages: List of message dictionaries

        Returns:
            Compressed messages
        """
        result = self.compress_if_needed(messages)
        return result.messages

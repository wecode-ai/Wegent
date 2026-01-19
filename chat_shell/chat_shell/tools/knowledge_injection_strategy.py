# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Intelligent context injection strategy for KnowledgeBaseTool.

This module implements a smart injection strategy that automatically chooses
between direct injection and RAG retrieval based on context window capacity.
"""

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from ..compression.token_counter import TokenCounter
from .knowledge_content_cleaner import KnowledgeContentCleaner, get_content_cleaner

logger = logging.getLogger(__name__)


class InjectionMode:
    """Constants for injection modes."""

    RAG_ONLY = "rag_only"  # Always use RAG retrieval (never direct injection)
    DIRECT_INJECTION = "direct_injection"  # Inject all chunks directly
    HYBRID = "hybrid"  # Choose based on context window capacity


class InjectionStrategy:
    """Intelligent injection strategy for knowledge base content.

    This class implements the logic to decide whether to inject knowledge
    base content directly or use RAG retrieval based on available context space.
    """

    # Default context window size when not provided from Model CRD
    DEFAULT_CONTEXT_WINDOW = 128000

    def __init__(
        self,
        model_id: str,
        context_window: int | None = None,
        injection_mode: str = InjectionMode.RAG_ONLY,
        min_chunk_score: float = 0.5,
        max_direct_chunks: int = 500,
        context_buffer_ratio: float = 0.1,
    ):
        """Initialize injection strategy.

        Args:
            model_id: Model identifier for token counting
            context_window: Context window size from Model CRD.
                If not provided, uses DEFAULT_CONTEXT_WINDOW (128000).
            injection_mode: Injection mode (rag_only, direct_injection, hybrid)
            min_chunk_score: Minimum score threshold for chunks
            max_direct_chunks: Maximum chunks to inject directly
            context_buffer_ratio: Ratio of context to keep as buffer (0.0-1.0)
        """
        self.model_id = model_id
        self.injection_mode = injection_mode
        self.min_chunk_score = min_chunk_score
        self.max_direct_chunks = max_direct_chunks
        self.context_buffer_ratio = context_buffer_ratio

        self.token_counter = TokenCounter(model_id)
        self.content_cleaner = get_content_cleaner()

        # Use context_window from Model CRD, or fall back to default
        self.context_window = (
            context_window if context_window else self.DEFAULT_CONTEXT_WINDOW
        )

        logger.info(
            "[InjectionStrategy] Initialized: model=%s, mode=%s, context_window=%d (from_crd=%s)",
            model_id,
            injection_mode,
            self.context_window,
            context_window is not None,
        )

    def calculate_available_space(
        self,
        messages: List[Dict[str, Any]],
        reserved_output_tokens: int = 4096,
    ) -> int:
        """Calculate available space in context window.

        Args:
            messages: Current conversation messages
            reserved_output_tokens: Tokens reserved for model output

        Returns:
            Available tokens for knowledge injection
        """
        # Count tokens used by current messages
        used_tokens = self.token_counter.count_messages(messages)

        # Calculate available space with buffer
        total_available = self.context_window - used_tokens - reserved_output_tokens
        buffer_space = int(total_available * self.context_buffer_ratio)

        available_space = total_available - buffer_space

        logger.debug(
            "[InjectionStrategy] Available space: context=%d, used=%d, "
            "reserved=%d, buffer=%d, available=%d",
            self.context_window,
            used_tokens,
            reserved_output_tokens,
            buffer_space,
            available_space,
        )

        return max(0, available_space)

    def estimate_chunk_tokens(
        self,
        chunks: List[Dict[str, Any]],
        clean_chunks: bool = True,
    ) -> int:
        """Estimate tokens required for chunks.

        Args:
            chunks: List of knowledge base chunks
            clean_chunks: Whether to clean chunks before estimation

        Returns:
            Estimated token count
        """
        if not chunks:
            return 0

        total_chars = 0

        for chunk in chunks:
            content = chunk.get("content", "")
            if clean_chunks:
                content = self.content_cleaner.clean_content(content)
            total_chars += len(content)

        # Estimate tokens (add overhead for formatting)
        estimated_tokens = int(
            total_chars
            / self.token_counter.CHARS_PER_TOKEN.get(self.token_counter.provider, 4.0)
        )

        # Add overhead for chunk formatting (source info, etc.)
        formatting_overhead = len(chunks) * 50  # ~50 tokens per chunk for metadata

        return estimated_tokens + formatting_overhead

    def prepare_chunks_for_injection(
        self,
        chunks: List[Dict[str, Any]],
        max_chunks: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Prepare chunks for direct injection.

        Args:
            chunks: Raw chunks from knowledge base
            max_chunks: Maximum number of chunks to include

        Returns:
            Prepared chunks ready for injection
        """
        if not chunks:
            return []

        # Handle score-based filtering carefully to support chunks without scores
        # Direct injection uses None score to indicate non-RAG retrieval, so we must
        # not fail on comparison and should not drop those chunks solely due to score.
        has_numeric_scores = any(
            isinstance(chunk.get("score"), (int, float)) for chunk in chunks
        )

        if has_numeric_scores:
            # Filter by minimum score for chunks that have numeric scores
            filtered_chunks = [
                chunk
                for chunk in chunks
                if (chunk.get("score") if chunk.get("score") is not None else 0.0)
                >= self.min_chunk_score
            ]

            # Sort by score (descending), treating None as 0.0
            filtered_chunks.sort(
                key=lambda x: (x.get("score") if x.get("score") is not None else 0.0),
                reverse=True,
            )
        else:
            # No numeric scores available (e.g., direct injection chunks only),
            # skip score filtering and keep original order.
            filtered_chunks = list(chunks)

        # Limit number of chunks
        if max_chunks:
            filtered_chunks = filtered_chunks[:max_chunks]

        # Clean chunks
        cleaned_chunks = self.content_cleaner.clean_knowledge_chunks(filtered_chunks)

        logger.info(
            "[InjectionStrategy] Prepared chunks: %d -> %d (score >= %.2f, max=%d)",
            len(chunks),
            len(cleaned_chunks),
            self.min_chunk_score,
            max_chunks or len(chunks),
        )

        return cleaned_chunks

    def format_chunks_for_injection(
        self,
        chunks: List[Dict[str, Any]],
        include_sources: bool = True,
    ) -> str:
        """Format chunks for direct injection into context.

        Args:
            chunks: Prepared chunks
            include_sources: Whether to include source information

        Returns:
            Formatted string ready for injection
        """
        if not chunks:
            return ""

        formatted_parts = []

        for i, chunk in enumerate(chunks):
            content = chunk.get("content", "")
            source = chunk.get("source", "Unknown")
            score = chunk.get("score")
            kb_id = chunk.get("knowledge_base_id", 0)

            # Format chunk with metadata
            chunk_header = f"[Knowledge Chunk {i+1}]"
            if include_sources:
                # Score may be None for direct injection chunks (non-RAG retrieval)
                if score is None:
                    score_str = "N/A"
                else:
                    try:
                        score_str = f"{float(score):.2f}"
                    except (TypeError, ValueError):
                        score_str = "N/A"

                chunk_header += f" (Source: {source}, Score: {score_str})"

            formatted_chunk = f"{chunk_header}\n{content}\n"
            formatted_parts.append(formatted_chunk)

        # Combine all chunks with separator
        separator = "\n" + "=" * 50 + "\n"
        result = separator.join(formatted_parts)

        # Add overall header
        header = (
            f"[Knowledge Base Context - {len(chunks)} chunks injected directly]\n"
            f"Note: This content has been injected directly from the knowledge base "
            f"instead of using RAG retrieval due to context window constraints.\n"
            f"{separator}\n"
        )

        return header + result

    def decide_injection_mode(
        self,
        messages: List[Dict[str, Any]],
        chunks: List[Dict[str, Any]],
        reserved_output_tokens: int = 4096,
    ) -> Tuple[str, Dict[str, Any]]:
        """Decide whether to use direct injection or RAG.

        Args:
            messages: Current conversation messages
            chunks: Available knowledge base chunks
            reserved_output_tokens: Tokens reserved for model output

        Returns:
            Tuple of (injection_mode, decision_details)
        """
        # If mode is forced, use that mode
        if self.injection_mode == InjectionMode.RAG_ONLY:
            return InjectionMode.RAG_ONLY, {"reason": "forced_rag_mode"}
        elif self.injection_mode == InjectionMode.DIRECT_INJECTION:
            return InjectionMode.DIRECT_INJECTION, {"reason": "forced_direct_mode"}

        # Hybrid mode: decide based on context space
        available_space = self.calculate_available_space(
            messages, reserved_output_tokens
        )

        # Estimate tokens needed for direct injection
        estimated_tokens = self.estimate_chunk_tokens(chunks)

        # Check if we can fit all chunks
        can_fit_all = estimated_tokens <= available_space
        # Additional checks for direct injection
        chunks_not_too_many = len(chunks) <= self.max_direct_chunks
        reasonable_token_count = (
            estimated_tokens <= self.context_window * 0.3
        )  # Max 30% of context

        decision_details = {
            "available_space": available_space,
            "estimated_tokens": estimated_tokens,
            "chunk_count": len(chunks),
            "can_fit_all": can_fit_all,
            "chunks_not_too_many": chunks_not_too_many,
            "reasonable_token_count": reasonable_token_count,
        }

        # Decision logic
        if can_fit_all and chunks_not_too_many and reasonable_token_count:
            # All conditions met for direct injection
            injection_mode = InjectionMode.DIRECT_INJECTION
            decision_details["reason"] = "all_conditions_met"
        else:
            # Fall back to RAG
            injection_mode = InjectionMode.RAG_ONLY
            decision_details["reason"] = "conditions_not_met"
            if not can_fit_all:
                decision_details["blocking_condition"] = "insufficient_space"
            elif not chunks_not_too_many:
                decision_details["blocking_condition"] = "too_many_chunks"
            elif not reasonable_token_count:
                decision_details["blocking_condition"] = "token_count_too_high"

        logger.info(
            "[InjectionStrategy] Decision: mode=%s, reason=%s, "
            "available=%d, estimated=%d, chunks=%d",
            injection_mode,
            decision_details["reason"],
            available_space,
            estimated_tokens,
            len(chunks),
        )

        return injection_mode, decision_details

    def apply_all_or_nothing_strategy(
        self,
        kb_chunks: Dict[int, List[Dict[str, Any]]],
        messages: List[Dict[str, Any]],
        reserved_output_tokens: int = 4096,
    ) -> Tuple[bool, List[Dict[str, Any]]]:
        """Apply All-or-Nothing strategy for multiple knowledge bases.

        This strategy ensures that either ALL knowledge bases are injected directly,
        or NONE are (fall back to RAG for all).

        Args:
            kb_chunks: Dictionary mapping KB IDs to their chunks
            messages: Current conversation messages
            reserved_output_tokens: Tokens reserved for model output

        Returns:
            Tuple of (can_inject_all, combined_chunks)
        """
        if not kb_chunks:
            return True, []

        # Combine all chunks from all KBs
        all_chunks = []
        for kb_id, chunks in kb_chunks.items():
            for chunk in chunks:
                chunk_with_kb = chunk.copy()
                chunk_with_kb["knowledge_base_id"] = kb_id
                all_chunks.append(chunk_with_kb)

        # Check if we can inject all chunks
        available_space = self.calculate_available_space(
            messages, reserved_output_tokens
        )
        estimated_tokens = self.estimate_chunk_tokens(all_chunks)

        can_inject_all = (
            estimated_tokens <= available_space
            and len(all_chunks) <= self.max_direct_chunks
            and estimated_tokens <= self.context_window * 0.3
        )

        logger.info(
            "[InjectionStrategy] All-or-Nothing: can_inject=%s, "
            "total_chunks=%d, estimated_tokens=%d, available=%d",
            can_inject_all,
            len(all_chunks),
            estimated_tokens,
            available_space,
        )

        return can_inject_all, all_chunks

    async def execute_injection_strategy(
        self,
        messages: List[Dict[str, Any]],
        kb_chunks: Dict[int, List[Dict[str, Any]]],
        query: str,
        reserved_output_tokens: int = 4096,
    ) -> Dict[str, Any]:
        """Execute the complete injection strategy.

        Args:
            messages: Current conversation messages
            kb_chunks: Dictionary mapping KB IDs to their chunks
            query: Search query (for RAG fallback)
            reserved_output_tokens: Tokens reserved for model output

        Returns:
            Dictionary with injection results
        """
        result = {
            "mode": None,
            "injected_content": None,
            "chunks_used": [],
            "decision_details": {},
            "fallback_to_rag": False,
        }

        # Apply All-or-Nothing strategy for multiple KBs
        can_inject_all, all_chunks = self.apply_all_or_nothing_strategy(
            kb_chunks, messages, reserved_output_tokens
        )

        if can_inject_all and self.injection_mode != InjectionMode.RAG_ONLY:
            # Prepare chunks for injection
            prepared_chunks = self.prepare_chunks_for_injection(
                all_chunks, max_chunks=self.max_direct_chunks
            )

            # Format for injection
            injected_content = self.format_chunks_for_injection(prepared_chunks)

            result.update(
                {
                    "mode": InjectionMode.DIRECT_INJECTION,
                    "injected_content": injected_content,
                    "chunks_used": prepared_chunks,
                    "decision_details": {
                        "strategy": "all_or_nothing",
                        "chunks_injected": len(prepared_chunks),
                        "total_chars": len(injected_content),
                    },
                }
            )

            logger.info(
                "[InjectionStrategy] Direct injection successful: %d chunks, %d chars",
                len(prepared_chunks),
                len(injected_content),
            )
        else:
            # Fall back to RAG
            result.update(
                {
                    "mode": InjectionMode.RAG_ONLY,
                    "fallback_to_rag": True,
                    "decision_details": {
                        "strategy": "rag_fallback",
                        "reason": (
                            "all_or_nothing_failed"
                            if not can_inject_all
                            else "rag_mode_forced"
                        ),
                    },
                }
            )

            logger.info(
                "[InjectionStrategy] Falling back to RAG: query=%s, kb_count=%d",
                query,
                len(kb_chunks),
            )

        return result

    def get_injection_statistics(self) -> Dict[str, Any]:
        """Get statistics about the injection strategy.

        Returns:
            Dictionary with configuration statistics
        """
        return {
            "model_id": self.model_id,
            "injection_mode": self.injection_mode,
            "min_chunk_score": self.min_chunk_score,
            "max_direct_chunks": self.max_direct_chunks,
            "context_buffer_ratio": self.context_buffer_ratio,
            "context_window": self.context_window,
            "provider": self.token_counter.provider,
        }

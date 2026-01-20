# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Enhanced Token Splitter for semantic chunks.

This module implements token-based splitting with support for overflow strategies,
respecting atomic chunks and applying appropriate splitting strategies.
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

import tiktoken

from ..models.api_models import SemanticChunk

logger = logging.getLogger(__name__)

# Embedding model hard limit (with buffer)
EMBEDDING_HARD_LIMIT = 8000  # tokens, typical embedding model limit is 8192

# Default token limits
DEFAULT_MIN_TOKENS = 100
DEFAULT_MAX_TOKENS = 600
DEFAULT_OVERLAP_TOKENS = 80


class SemanticTokenSplitter:
    """
    Token splitter for SemanticChunks with overflow strategy support.

    Enhancements:
    1. Respects atomic flag
    2. Supports multiple overflow strategies (row_split, function_split, item_split, truncate)
    3. Hard fallback to prevent embedding crashes
    """

    def __init__(
        self,
        min_tokens: int = DEFAULT_MIN_TOKENS,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
        tokenizer: Optional[Any] = None,
    ):
        """
        Initialize the semantic token splitter.

        Args:
            min_tokens: Minimum tokens per chunk
            max_tokens: Maximum tokens per chunk
            overlap_tokens: Overlap tokens for splits
            tokenizer: Optional tiktoken tokenizer instance
        """
        self.min_tokens = min_tokens
        self.max_tokens = max_tokens
        self.overlap_tokens = overlap_tokens

        if tokenizer:
            self.tokenizer = tokenizer
        else:
            try:
                self.tokenizer = tiktoken.get_encoding("cl100k_base")
            except Exception:
                self.tokenizer = tiktoken.get_encoding("gpt2")

    def split_if_needed(
        self,
        chunks: List[SemanticChunk],
    ) -> Tuple[List[SemanticChunk], Dict[str, int]]:
        """
        Split semantic chunks if they exceed token limits.

        Args:
            chunks: List of semantic chunks to process

        Returns:
            Tuple of (final_chunks, stats_dict)
        """
        final_chunks: List[SemanticChunk] = []
        stats = {
            "total_input": len(chunks),
            "split_count": 0,
            "atomic_kept": 0,
            "overflow_handled": 0,
            "truncated": 0,
        }

        for chunk in chunks:
            token_count = self._count_tokens(chunk.content)

            # Case 1: Within limits, keep as is
            if token_count <= self.max_tokens:
                final_chunks.append(chunk)
                continue

            # Case 2: Atomic chunk exceeds limit
            if chunk.is_atomic:
                overflow_strategy = chunk.overflow_strategy

                # 2a. Hard fallback: exceeds embedding limit, must handle
                if token_count > EMBEDDING_HARD_LIMIT:
                    logger.error(
                        f"[Phase8] CRITICAL: Atomic chunk exceeds embedding limit "
                        f"({token_count} > {EMBEDDING_HARD_LIMIT}), "
                        f"forcing split: type={chunk.chunk_type}"
                    )
                    split_parts = self._split_by_strategy(
                        chunk, overflow_strategy or "truncate"
                    )
                    stats["split_count"] += 1
                    stats["overflow_handled"] += 1
                    final_chunks.extend(split_parts)
                    continue

                # 2b. Exceeds max_tokens but within embedding limit
                if token_count > self.max_tokens:
                    if overflow_strategy and overflow_strategy != "none":
                        logger.info(
                            f"[Phase8] Atomic chunk over max_tokens ({token_count} > {self.max_tokens}), "
                            f"applying {overflow_strategy}: type={chunk.chunk_type}"
                        )
                        split_parts = self._split_by_strategy(chunk, overflow_strategy)
                        if len(split_parts) > 1:
                            stats["split_count"] += 1
                            stats["overflow_handled"] += 1
                        final_chunks.extend(split_parts)
                    else:
                        # No strategy, keep intact but warn
                        logger.warning(
                            f"[Phase8] Atomic chunk exceeds max_tokens ({token_count} > {self.max_tokens}), "
                            f"keeping intact (no overflow_strategy): type={chunk.chunk_type}"
                        )
                        stats["atomic_kept"] += 1
                        final_chunks.append(chunk)
                    continue

            # Case 3: Non-atomic chunk exceeds limit, normal split
            split_parts = self._split_by_semantic_boundary(chunk)
            stats["split_count"] += 1
            final_chunks.extend(split_parts)
            logger.debug(
                f"[Phase8] Split non-atomic chunk: {token_count} tokens -> {len(split_parts)} parts"
            )

        logger.info(
            f"[Phase8] Token splitting: {stats['total_input']} -> {len(final_chunks)} chunks, "
            f"split={stats['split_count']}, atomic_kept={stats['atomic_kept']}, "
            f"overflow_handled={stats['overflow_handled']}"
        )

        return final_chunks, stats

    def _split_by_strategy(
        self,
        chunk: SemanticChunk,
        strategy: str,
    ) -> List[SemanticChunk]:
        """Split chunk using specified strategy."""
        if strategy == "row_split":
            return self._split_table_by_rows(chunk)
        elif strategy == "function_split":
            return self._split_code_by_functions(chunk)
        elif strategy == "item_split":
            return self._split_list_by_items(chunk)
        elif strategy == "truncate":
            return self._truncate_chunk(chunk)
        else:
            # Fallback to semantic boundary
            return self._split_by_semantic_boundary(chunk)

    def _split_table_by_rows(self, chunk: SemanticChunk) -> List[SemanticChunk]:
        """
        Split table by rows, preserving headers.

        Strategy: Each sub-chunk contains header + partial rows.
        """
        content = chunk.content
        lines = content.split("\n")

        # Identify header (first two lines: title row + separator)
        header_lines = []
        data_lines = []
        separator_pattern = re.compile(r"^\|[\s\-:|]+\|$")

        for i, line in enumerate(lines):
            if i < 2 or separator_pattern.match(line.strip()):
                header_lines.append(line)
            else:
                data_lines.append(line)

        if not data_lines:
            return [chunk]  # No data rows, keep as is

        header = "\n".join(header_lines)
        header_tokens = self._count_tokens(header)
        available_tokens = self.max_tokens - header_tokens - 50  # Buffer

        if available_tokens <= 0:
            logger.warning(
                f"[Phase8] Table header too long ({header_tokens} tokens), cannot split by rows"
            )
            return [chunk]

        # Group rows
        parts: List[List[str]] = []
        current_rows: List[str] = []
        current_tokens = 0

        for row in data_lines:
            row_tokens = self._count_tokens(row)
            if current_tokens + row_tokens > available_tokens and current_rows:
                parts.append(current_rows)
                current_rows = []
                current_tokens = 0
            current_rows.append(row)
            current_tokens += row_tokens

        if current_rows:
            parts.append(current_rows)

        # Create sub-chunks
        result = []
        for i, rows in enumerate(parts):
            part_content = header + "\n" + "\n".join(rows)
            part_chunk = SemanticChunk(
                chunk_type=chunk.chunk_type,
                title_path=chunk.title_path.copy(),
                content=part_content,
                notes=chunk.notes + f" [row_split {i+1}/{len(parts)}]",
                source_blocks=chunk.source_blocks.copy(),
                metadata={
                    **chunk.metadata,
                    "is_split": True,
                    "split_index": i,
                    "split_total": len(parts),
                    "split_strategy": "row_split",
                    "atomic": True,  # Sub-chunks remain atomic
                },
            )
            result.append(part_chunk)

        return result

    def _split_code_by_functions(self, chunk: SemanticChunk) -> List[SemanticChunk]:
        """
        Split code by function boundaries.

        Strategy: Identify function definitions and split there.
        """
        content = chunk.content
        lines = content.split("\n")

        # Function boundary patterns (multi-language support)
        function_patterns = [
            r"^(def |async def |function |const \w+ = |class )",  # Python/JS/TS
            r"^(public |private |protected |func |fn )",  # Java/Go/Rust
        ]

        function_starts = [0]

        for i, line in enumerate(lines):
            stripped = line.strip()
            for pattern in function_patterns:
                if re.match(pattern, stripped):
                    if i > 0:  # Not first line
                        function_starts.append(i)
                    break

        # No function boundaries found, fallback
        if len(function_starts) <= 1:
            logger.debug(
                f"[Phase8] No function boundaries found, falling back to semantic split"
            )
            return self._split_by_semantic_boundary(chunk)

        # Split by functions
        function_starts.append(len(lines))
        parts: List[str] = []

        for i in range(len(function_starts) - 1):
            start = function_starts[i]
            end = function_starts[i + 1]
            part_lines = lines[start:end]
            part_content = "\n".join(part_lines)
            part_tokens = self._count_tokens(part_content)

            # If single function is still too long, split further
            if part_tokens > self.max_tokens:
                temp_chunk = SemanticChunk(
                    chunk_type=chunk.chunk_type,
                    title_path=chunk.title_path,
                    content=part_content,
                    notes=chunk.notes,
                    source_blocks=chunk.source_blocks,
                    metadata={**chunk.metadata, "atomic": False},
                )
                sub_parts = self._split_by_semantic_boundary(temp_chunk)
                parts.extend([p.content for p in sub_parts])
            else:
                parts.append(part_content)

        # Create sub-chunks
        result = []
        for i, part_content in enumerate(parts):
            part_chunk = SemanticChunk(
                chunk_type=chunk.chunk_type,
                title_path=chunk.title_path.copy(),
                content=part_content,
                notes=chunk.notes + f" [function_split {i+1}/{len(parts)}]",
                source_blocks=chunk.source_blocks.copy(),
                metadata={
                    **chunk.metadata,
                    "is_split": True,
                    "split_index": i,
                    "split_total": len(parts),
                    "split_strategy": "function_split",
                },
            )
            result.append(part_chunk)

        return result

    def _split_list_by_items(self, chunk: SemanticChunk) -> List[SemanticChunk]:
        """Split list by items."""
        content = chunk.content
        lines = content.split("\n")

        # Identify list items
        item_pattern = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+")
        items: List[str] = []
        current_item: List[str] = []

        for line in lines:
            if item_pattern.match(line):
                if current_item:
                    items.append("\n".join(current_item))
                current_item = [line]
            else:
                current_item.append(line)

        if current_item:
            items.append("\n".join(current_item))

        if len(items) <= 1:
            return self._split_by_semantic_boundary(chunk)

        # Group small items, split large items
        parts: List[str] = []
        current_part: List[str] = []
        current_tokens = 0

        for item in items:
            item_tokens = self._count_tokens(item)
            if current_tokens + item_tokens > self.max_tokens and current_part:
                parts.append("\n".join(current_part))
                current_part = []
                current_tokens = 0
            current_part.append(item)
            current_tokens += item_tokens

        if current_part:
            parts.append("\n".join(current_part))

        # Create sub-chunks
        result = []
        for i, part_content in enumerate(parts):
            part_chunk = SemanticChunk(
                chunk_type=chunk.chunk_type,
                title_path=chunk.title_path.copy(),
                content=part_content,
                notes=chunk.notes + f" [item_split {i+1}/{len(parts)}]",
                source_blocks=chunk.source_blocks.copy(),
                metadata={
                    **chunk.metadata,
                    "is_split": True,
                    "split_index": i,
                    "split_total": len(parts),
                    "split_strategy": "item_split",
                },
            )
            result.append(part_chunk)

        return result

    def _truncate_chunk(self, chunk: SemanticChunk) -> List[SemanticChunk]:
        """
        Truncate chunk (last resort).

        Keeps first N tokens and adds truncation marker.
        """
        tokens = self.tokenizer.encode(chunk.content)
        truncated_tokens = tokens[: self.max_tokens - 20]  # Leave room for marker
        truncated_content = self.tokenizer.decode(truncated_tokens)
        truncated_content += "\n\n[... content truncated ...]"

        logger.warning(
            f"[Phase8] Chunk truncated: {len(tokens)} -> {len(truncated_tokens)} tokens, "
            f"type={chunk.chunk_type}"
        )

        truncated_chunk = SemanticChunk(
            chunk_type=chunk.chunk_type,
            title_path=chunk.title_path.copy(),
            content=truncated_content,
            notes=chunk.notes + " [TRUNCATED]",
            source_blocks=chunk.source_blocks.copy(),
            metadata={
                **chunk.metadata,
                "truncated": True,
                "original_tokens": len(tokens),
            },
        )
        return [truncated_chunk]

    def _split_by_semantic_boundary(
        self, chunk: SemanticChunk
    ) -> List[SemanticChunk]:
        """Split by semantic boundaries (paragraphs, sentences)."""
        content = chunk.content

        # Try splitting by paragraphs first
        paragraphs = re.split(r"\n\n+", content)

        if len(paragraphs) > 1:
            return self._merge_and_split_parts(chunk, paragraphs)

        # Then by sentences
        sentences = re.split(r"(?<=[.!?。！？])\s+", content)

        if len(sentences) > 1:
            return self._merge_and_split_parts(chunk, sentences)

        # Finally by lines
        lines = content.split("\n")
        return self._merge_and_split_parts(chunk, lines)

    def _merge_and_split_parts(
        self,
        chunk: SemanticChunk,
        parts: List[str],
    ) -> List[SemanticChunk]:
        """Merge small parts, ensure each sub-chunk is within limits."""
        result_parts: List[str] = []
        current_parts: List[str] = []
        current_tokens = 0

        for part in parts:
            part_tokens = self._count_tokens(part)

            if current_tokens + part_tokens > self.max_tokens and current_parts:
                result_parts.append("\n\n".join(current_parts))
                current_parts = []
                current_tokens = 0

            current_parts.append(part)
            current_tokens += part_tokens

        if current_parts:
            result_parts.append("\n\n".join(current_parts))

        # Create SemanticChunk list
        chunks = []
        for i, part_content in enumerate(result_parts):
            part_chunk = SemanticChunk(
                chunk_type=chunk.chunk_type,
                title_path=chunk.title_path.copy(),
                content=part_content,
                notes=chunk.notes + f" [split {i+1}/{len(result_parts)}]",
                source_blocks=chunk.source_blocks.copy(),
                metadata={
                    **chunk.metadata,
                    "is_split": True,
                    "split_index": i,
                    "split_total": len(result_parts),
                    "split_strategy": "semantic",
                },
            )
            chunks.append(part_chunk)

        return chunks

    def _count_tokens(self, text: str) -> int:
        """Count tokens in text."""
        return len(self.tokenizer.encode(text))

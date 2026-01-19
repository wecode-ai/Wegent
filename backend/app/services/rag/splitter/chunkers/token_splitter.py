# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Token-based splitter for document processing.

This module implements Phase 5 of the document splitting pipeline:
ensuring chunks meet token size requirements while preserving
semantic coherence.
"""

import logging
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

import tiktoken

logger = logging.getLogger(__name__)

# Default token limits
DEFAULT_MIN_TOKENS = 100
DEFAULT_MAX_TOKENS = 600
DEFAULT_OVERLAP_TOKENS = 80


class TokenSplitter:
    """
    Splits and merges chunks based on token count.

    Operations:
    - Merge small chunks with siblings
    - Split large chunks intelligently
    - Apply overlap for continuity
    - Preserve semantic closure
    """

    def __init__(
        self,
        min_tokens: int = DEFAULT_MIN_TOKENS,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
        tokenizer: Optional[Any] = None,
    ):
        """
        Initialize the token splitter.

        Args:
            min_tokens: Minimum tokens per chunk (merge smaller ones)
            max_tokens: Maximum tokens per chunk (split larger ones)
            overlap_tokens: Overlap tokens for forced splits
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

    def count_tokens(self, text: str) -> int:
        """Count tokens in text."""
        return len(self.tokenizer.encode(text))

    def split(self, chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Process chunks to meet token requirements.

        Args:
            chunks: List of chunk dictionaries from structural chunker

        Returns:
            List of processed chunks meeting token requirements
        """
        if not chunks:
            return []

        # First pass: calculate token counts
        for chunk in chunks:
            chunk["token_count"] = self.count_tokens(chunk["content"])

        # Merge small chunks
        merged_chunks = self._merge_small_chunks(chunks)

        # Split large chunks
        final_chunks = self._split_large_chunks(merged_chunks)

        logger.info(
            f"Token splitter: {len(chunks)} -> {len(final_chunks)} chunks "
            f"(merged/split to meet {self.min_tokens}-{self.max_tokens} tokens)"
        )

        return final_chunks

    def _merge_small_chunks(
        self,
        chunks: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Merge chunks smaller than min_tokens with siblings."""
        if not chunks:
            return []

        merged: List[Dict[str, Any]] = []
        pending: Optional[Dict[str, Any]] = None

        for chunk in chunks:
            token_count = chunk.get("token_count", self.count_tokens(chunk["content"]))

            # If chunk is large enough, finalize any pending and add it
            if token_count >= self.min_tokens:
                if pending:
                    merged.append(pending)
                    pending = None
                merged.append(chunk)
                continue

            # Small chunk - try to merge
            if pending is None:
                pending = chunk.copy()
                continue

            # Check if we can merge with pending
            combined_tokens = pending.get("token_count", 0) + token_count

            if combined_tokens <= self.max_tokens:
                # Merge chunks
                pending = self._merge_two_chunks(pending, chunk)
            else:
                # Can't merge - finalize pending and start new
                merged.append(pending)
                pending = chunk.copy()

        # Add remaining pending chunk
        if pending:
            merged.append(pending)

        return merged

    def _merge_two_chunks(
        self,
        chunk1: Dict[str, Any],
        chunk2: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Merge two chunks into one."""
        combined_content = chunk1["content"] + "\n\n" + chunk2["content"]
        combined_tokens = self.count_tokens(combined_content)

        # Determine merged chunk type (prefer structural types)
        chunk_type = chunk1.get("chunk_type") or chunk2.get("chunk_type")

        # Use title path from first chunk
        title_path = chunk1.get("title_path") or chunk2.get("title_path")

        return {
            "content": combined_content,
            "token_count": combined_tokens,
            "chunk_type": chunk_type,
            "title_path": title_path,
            "line_start": chunk1.get("line_start"),
            "line_end": chunk2.get("line_end"),
            "page_number": chunk1.get("page_number"),
            "is_merged": True,
            "metadata": {
                **chunk1.get("metadata", {}),
                "merged_from": 2,
            },
        }

    def _split_large_chunks(
        self,
        chunks: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Split chunks larger than max_tokens."""
        result: List[Dict[str, Any]] = []

        for chunk in chunks:
            token_count = chunk.get("token_count", self.count_tokens(chunk["content"]))

            if token_count <= self.max_tokens:
                result.append(chunk)
            else:
                # Need to split
                split_chunks = self._split_chunk(chunk)
                result.extend(split_chunks)

        return result

    def _split_chunk(self, chunk: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Split a single chunk that exceeds max_tokens."""
        content = chunk["content"]
        chunk_type = chunk.get("chunk_type")

        # Choose splitting strategy based on chunk type
        if chunk_type == "code":
            split_parts = self._split_code(content)
        elif chunk_type == "table":
            split_parts = self._split_table(content)
        elif chunk_type == "list":
            split_parts = self._split_list(content)
        elif chunk_type == "qa":
            split_parts = self._split_qa(content)
        else:
            split_parts = self._split_by_sentences(content)

        # Convert parts to chunk dictionaries
        result_chunks = []
        for i, (part_content, is_forced) in enumerate(split_parts):
            part_tokens = self.count_tokens(part_content)

            result_chunk = {
                "content": part_content,
                "token_count": part_tokens,
                "chunk_type": chunk_type,
                "title_path": chunk.get("title_path"),
                "line_start": chunk.get("line_start"),
                "line_end": chunk.get("line_end"),
                "page_number": chunk.get("page_number"),
                "is_split": True,
                "split_index": i,
                "forced_split": is_forced,
                "metadata": {
                    **chunk.get("metadata", {}),
                    "split_from_total": len(split_parts),
                },
            }
            result_chunks.append(result_chunk)

        return result_chunks

    def _split_by_sentences(self, text: str) -> List[Tuple[str, bool]]:
        """Split text by sentence boundaries with overlap."""
        # Split by sentence-ending punctuation
        sentence_pattern = r"([.!?。！？]+[\s]*)"
        parts = re.split(sentence_pattern, text)

        sentences = []
        current = ""

        for i, part in enumerate(parts):
            if i % 2 == 0:  # Content part
                current += part
            else:  # Punctuation part
                current += part
                if current.strip():
                    sentences.append(current.strip())
                current = ""

        # Add remaining content
        if current.strip():
            sentences.append(current.strip())

        if not sentences:
            return [(text, True)]

        # Group sentences into chunks
        return self._group_with_overlap(sentences)

    def _group_with_overlap(
        self,
        items: List[str],
        separator: str = " ",
    ) -> List[Tuple[str, bool]]:
        """Group items into chunks with overlap between them."""
        chunks: List[Tuple[str, bool]] = []
        current_items: List[str] = []
        current_tokens = 0

        for item in items:
            item_tokens = self.count_tokens(item)

            # Check if adding this item would exceed max
            test_content = separator.join(current_items + [item])
            test_tokens = self.count_tokens(test_content)

            if test_tokens > self.max_tokens and current_items:
                # Finalize current chunk
                chunk_content = separator.join(current_items)
                is_forced = len(chunks) > 0  # First chunk is not forced
                chunks.append((chunk_content, is_forced))

                # Get overlap from end of current chunk
                overlap_items = self._get_overlap_items(current_items, separator)
                current_items = overlap_items + [item]
                current_tokens = self.count_tokens(separator.join(current_items))
            else:
                current_items.append(item)
                current_tokens = test_tokens

        # Add final chunk
        if current_items:
            chunk_content = separator.join(current_items)
            is_forced = len(chunks) > 0
            chunks.append((chunk_content, is_forced))

        return chunks

    def _get_overlap_items(
        self,
        items: List[str],
        separator: str = " ",
    ) -> List[str]:
        """Get items from the end that fit within overlap_tokens."""
        overlap_items: List[str] = []
        overlap_tokens = 0

        for item in reversed(items):
            item_tokens = self.count_tokens(item)
            if overlap_tokens + item_tokens > self.overlap_tokens:
                break
            overlap_items.insert(0, item)
            overlap_tokens += item_tokens

        return overlap_items

    def _split_code(self, content: str) -> List[Tuple[str, bool]]:
        """Split code content preserving structure."""
        lines = content.split("\n")

        # Try to split at function/class boundaries
        logical_blocks: List[str] = []
        current_block: List[str] = []

        for line in lines:
            # Check for logical boundaries
            is_boundary = re.match(
                r"^\s*(def |class |function |public |private |async )", line
            ) or re.match(
                r"^```", line
            )  # Code block markers

            if is_boundary and current_block:
                logical_blocks.append("\n".join(current_block))
                current_block = []

            current_block.append(line)

        if current_block:
            logical_blocks.append("\n".join(current_block))

        if not logical_blocks:
            return [(content, True)]

        return self._group_with_overlap(logical_blocks, "\n\n")

    def _split_table(self, content: str) -> List[Tuple[str, bool]]:
        """Split table content preserving headers."""
        lines = content.split("\n")

        # Find header and separator
        header_lines: List[str] = []
        data_lines: List[str] = []

        for i, line in enumerate(lines):
            if i < 2:  # Assume first two lines are header + separator
                header_lines.append(line)
            else:
                data_lines.append(line)

        if not data_lines:
            return [(content, False)]

        # Split data rows, prepending headers to each chunk
        header_content = "\n".join(header_lines)
        header_tokens = self.count_tokens(header_content)
        available_tokens = self.max_tokens - header_tokens - 10  # Buffer

        chunks: List[Tuple[str, bool]] = []
        current_rows: List[str] = []
        current_tokens = 0

        for row in data_lines:
            row_tokens = self.count_tokens(row)

            if current_tokens + row_tokens > available_tokens and current_rows:
                # Finalize chunk with headers
                chunk_content = header_content + "\n" + "\n".join(current_rows)
                chunks.append((chunk_content, len(chunks) > 0))
                current_rows = [row]
                current_tokens = row_tokens
            else:
                current_rows.append(row)
                current_tokens += row_tokens

        if current_rows:
            chunk_content = header_content + "\n" + "\n".join(current_rows)
            chunks.append((chunk_content, len(chunks) > 0))

        return chunks

    def _split_list(self, content: str) -> List[Tuple[str, bool]]:
        """Split list content preserving complete items."""
        # Split by list markers
        item_pattern = r"(?m)^(\s*[-*+]|\s*\d+[.)]\s)"
        parts = re.split(item_pattern, content)

        # Reconstruct items
        items: List[str] = []
        current = ""

        for i, part in enumerate(parts):
            if i % 2 == 0:  # Content between markers
                current += part
            else:  # Marker
                if current.strip():
                    items.append(current.strip())
                current = part

        if current.strip():
            items.append(current.strip())

        if not items:
            return [(content, True)]

        return self._group_with_overlap(items, "\n")

    def _split_qa(self, content: str) -> List[Tuple[str, bool]]:
        """Split Q&A content keeping Q and A together."""
        # Try to split by Q: markers
        qa_pattern = r"(?m)^[QqQq问][:：]"
        parts = re.split(qa_pattern, content)

        if len(parts) <= 1:
            return self._split_by_sentences(content)

        # Reconstruct Q&A pairs
        qa_pairs: List[str] = []
        for i, part in enumerate(parts):
            if i == 0:
                if part.strip():
                    qa_pairs.append(part.strip())
            else:
                qa_pairs.append("Q:" + part.strip())

        if not qa_pairs:
            return [(content, True)]

        return self._group_with_overlap(qa_pairs, "\n\n")

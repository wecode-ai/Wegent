# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
LLM Chunking Gate for document processing.

This module implements the decision logic for determining whether to use
LLM-based semantic chunking or rule-based chunking for a document.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from ..models.api_models import APIDocumentInfo
from ..models.ir import BlockType, StructureBlock

logger = logging.getLogger(__name__)


@dataclass
class DocumentStats:
    """Document statistics for Gate decision."""

    total_blocks: int
    block_type_counts: Dict[str, int] = field(default_factory=dict)
    avg_paragraph_length: float = 0.0
    paragraph_length_std: float = 0.0
    short_paragraph_ratio: float = 0.0  # Ratio of paragraphs < 50 chars
    consecutive_short_count: int = 0  # Max consecutive short paragraphs


class LLMChunkingGate:
    """
    LLM Chunking Gate (Enhanced Version).

    Determines whether to use LLM-based semantic chunking or rule-based chunking
    based on document structure complexity and statistical features.

    Enhancements:
    1. Statistics-based semantic complexity detection
    2. Detection of "superficially simple but actually complex" documents
    3. Weak semantic block detection for API documents
    """

    # Thresholds for statistical analysis
    HIGH_STD_THRESHOLD = 100  # Paragraph length standard deviation threshold
    SHORT_PARAGRAPH_RATIO_THRESHOLD = 0.4  # Short paragraph ratio threshold
    CONSECUTIVE_SHORT_THRESHOLD = 5  # Consecutive short paragraphs threshold

    # Patterns for weak semantic blocks
    WEAK_SEMANTIC_PATTERNS = [
        r"^如下",
        r"^以下",
        r"^见下",
        r"^示例[:：]?$",
        r"^例如[:：]?$",
        r"^返回示例",
        r"^请求示例",
        r"^response example",
        r"^request example",
        r"^see below",
        r"^as follows",
    ]

    def __init__(self):
        """Initialize the LLM Chunking Gate."""
        self._weak_patterns = [
            re.compile(p, re.IGNORECASE) for p in self.WEAK_SEMANTIC_PATTERNS
        ]

    def should_use_llm(
        self,
        blocks: List[StructureBlock],
        api_info: APIDocumentInfo,
    ) -> Tuple[bool, str]:
        """
        Determine whether to use LLM-based chunking.

        Args:
            blocks: List of structure blocks from document IR
            api_info: API document structure information

        Returns:
            Tuple of (should_use_llm, reason)
        """
        stats = self._compute_stats(blocks)
        self._log_stats(stats)

        # Rule 1: API document with structure detected
        if api_info.is_api_doc:
            has_weak_semantic = self._has_weak_semantic_blocks(blocks)
            if has_weak_semantic:
                reason = "API doc with weak semantic blocks needs LLM for merging"
                logger.info(f"[Phase6] LLM Gate decision: use_llm=True, reason='{reason}'")
                return True, reason
            reason = "API doc structure detected, rule-based chunking sufficient"
            logger.info(f"[Phase6] LLM Gate decision: use_llm=False, reason='{reason}'")
            return False, reason

        # Rule 2: Check for "superficially simple but actually complex" documents
        block_types = {b.type for b in blocks}
        simple_types = {BlockType.HEADING, BlockType.PARAGRAPH}

        if block_types.issubset(simple_types):
            # Pure heading + paragraph, but need to check semantic complexity

            # 2a. High paragraph length variance -> uneven semantics
            if stats.paragraph_length_std > self.HIGH_STD_THRESHOLD:
                reason = f"High paragraph length variance (std={stats.paragraph_length_std:.1f}), LLM recommended"
                logger.info(f"[Phase6] LLM Gate decision: use_llm=True, reason='{reason}'")
                return True, reason

            # 2b. Many short paragraphs -> may be leads or lists
            if stats.short_paragraph_ratio > self.SHORT_PARAGRAPH_RATIO_THRESHOLD:
                reason = f"High short paragraph ratio ({stats.short_paragraph_ratio:.1%}), may contain implicit lists"
                logger.info(f"[Phase6] LLM Gate decision: use_llm=True, reason='{reason}'")
                return True, reason

            # 2c. Consecutive short paragraphs -> likely unrecognized list
            if stats.consecutive_short_count >= self.CONSECUTIVE_SHORT_THRESHOLD:
                reason = f"Found {stats.consecutive_short_count} consecutive short paragraphs, LLM recommended"
                logger.info(f"[Phase6] LLM Gate decision: use_llm=True, reason='{reason}'")
                return True, reason

            # Truly simple document
            reason = "Simple document structure with uniform paragraphs, rule-based chunking sufficient"
            logger.info(f"[Phase6] LLM Gate decision: use_llm=False, reason='{reason}'")
            return False, reason

        # Rule 3: Complex structure but clear boundaries
        if self._has_clear_boundaries(blocks):
            reason = "Clear structure boundaries, rule-based chunking sufficient"
            logger.info(f"[Phase6] LLM Gate decision: use_llm=False, reason='{reason}'")
            return False, reason

        # Rule 4: Default to LLM for complex documents
        reason = "Complex document structure, LLM chunking recommended"
        logger.info(f"[Phase6] LLM Gate decision: use_llm=True, reason='{reason}'")
        return True, reason

    def _compute_stats(self, blocks: List[StructureBlock]) -> DocumentStats:
        """Compute document statistics."""
        paragraph_lengths = []
        consecutive_short = 0
        max_consecutive_short = 0

        for block in blocks:
            if block.type == BlockType.PARAGRAPH:
                length = len(block.content.strip())
                paragraph_lengths.append(length)

                if length < 50:
                    consecutive_short += 1
                    max_consecutive_short = max(max_consecutive_short, consecutive_short)
                else:
                    consecutive_short = 0

        block_type_counts: Dict[str, int] = {}
        for block in blocks:
            t = block.type.value if hasattr(block.type, "value") else str(block.type)
            block_type_counts[t] = block_type_counts.get(t, 0) + 1

        if paragraph_lengths:
            avg_length = sum(paragraph_lengths) / len(paragraph_lengths)
            variance = sum((l - avg_length) ** 2 for l in paragraph_lengths) / len(
                paragraph_lengths
            )
            std_length = variance**0.5
            short_ratio = sum(1 for l in paragraph_lengths if l < 50) / len(
                paragraph_lengths
            )
        else:
            avg_length = 0.0
            std_length = 0.0
            short_ratio = 0.0

        return DocumentStats(
            total_blocks=len(blocks),
            block_type_counts=block_type_counts,
            avg_paragraph_length=avg_length,
            paragraph_length_std=std_length,
            short_paragraph_ratio=short_ratio,
            consecutive_short_count=max_consecutive_short,
        )

    def _log_stats(self, stats: DocumentStats) -> None:
        """Log document statistics."""
        logger.debug(
            f"[Phase6] Document stats: blocks={stats.total_blocks}, "
            f"avg_para_len={stats.avg_paragraph_length:.1f}, "
            f"para_len_std={stats.paragraph_length_std:.1f}, "
            f"short_ratio={stats.short_paragraph_ratio:.1%}, "
            f"max_consecutive_short={stats.consecutive_short_count}"
        )

    def _has_weak_semantic_blocks(self, blocks: List[StructureBlock]) -> bool:
        """Check for weak semantic blocks (leads, transitions)."""
        for block in blocks:
            if block.type == BlockType.PARAGRAPH:
                content = block.content.strip()
                if len(content) < 30:
                    for pattern in self._weak_patterns:
                        if pattern.match(content):
                            logger.debug(
                                f"[Phase6] Found weak semantic block: '{content[:50]}'"
                            )
                            return True
        return False

    def _has_clear_boundaries(self, blocks: List[StructureBlock]) -> bool:
        """Check if structure boundaries are clear (no ambiguous transitions)."""
        for i, block in enumerate(blocks):
            if block.type in {BlockType.CODE, BlockType.TABLE}:
                # Check if previous block is a short paragraph (possible lead text)
                if i > 0 and blocks[i - 1].type == BlockType.PARAGRAPH:
                    prev_content = blocks[i - 1].content.strip()
                    if len(prev_content) < 30:
                        # Short paragraph before code/table/example -> ambiguous boundary
                        return False
        return True

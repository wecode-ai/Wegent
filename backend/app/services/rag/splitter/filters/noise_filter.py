# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Noise filter for document processing.

This module implements Phase 3 of the document splitting pipeline:
filtering out noise like table of contents, headers/footers,
page numbers, and other non-content elements.
"""

import logging
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Set

from ..models.ir import BlockType, DocumentIR, StructureBlock
from ..recognizers.patterns import NOISE_PATTERNS

logger = logging.getLogger(__name__)


class NoiseFilter:
    """
    Filters noise from document IR.

    Removes or marks:
    - Table of contents entries
    - Page numbers and markers
    - Repeated headers/footers
    - Empty or whitespace-only blocks
    - Horizontal rules and separators

    Strategy: Conservative - prefer to keep content when uncertain.
    """

    def __init__(
        self,
        min_content_length: int = 3,
        max_toc_ratio: float = 0.3,
        repetition_threshold: int = 3,
    ):
        """
        Initialize the noise filter.

        Args:
            min_content_length: Minimum characters for a block to be kept
            max_toc_ratio: Maximum ratio of blocks that can be TOC
            repetition_threshold: Number of times a line must appear to be header/footer
        """
        self.min_content_length = min_content_length
        self.max_toc_ratio = max_toc_ratio
        self.repetition_threshold = repetition_threshold

    def filter(self, doc_ir: DocumentIR) -> DocumentIR:
        """
        Filter noise from document IR.

        Args:
            doc_ir: Document intermediate representation

        Returns:
            Filtered DocumentIR with noise removed
        """
        if not doc_ir.blocks:
            return doc_ir

        # Detect repeated content (headers/footers)
        repeated_content = self._detect_repeated_content(doc_ir.blocks)

        # Detect TOC section
        toc_indices = self._detect_toc_section(doc_ir.blocks)

        # Filter blocks
        filtered_blocks: List[StructureBlock] = []
        removed_count = 0

        for i, block in enumerate(doc_ir.blocks):
            # Skip if in TOC section
            if i in toc_indices:
                logger.debug(f"Filtering TOC entry at line {block.line_start}")
                removed_count += 1
                continue

            # Skip repeated headers/footers
            content_key = self._normalize_for_comparison(block.content)
            if content_key in repeated_content:
                logger.debug(f"Filtering repeated content at line {block.line_start}")
                removed_count += 1
                continue

            # Check if block is noise
            if self._is_noise_block(block):
                logger.debug(f"Filtering noise block at line {block.line_start}")
                removed_count += 1
                continue

            filtered_blocks.append(block)

        if removed_count > 0:
            logger.info(
                f"Noise filter removed {removed_count} blocks from {len(doc_ir.blocks)} total"
            )

        return DocumentIR(
            blocks=filtered_blocks,
            source_file=doc_ir.source_file,
            file_type=doc_ir.file_type,
            file_size=doc_ir.file_size,
            total_lines=doc_ir.total_lines,
            total_pages=doc_ir.total_pages,
            skipped_elements=doc_ir.skipped_elements,
            metadata=doc_ir.metadata,
        )

    def _detect_repeated_content(self, blocks: List[StructureBlock]) -> Set[str]:
        """Detect repeated content that might be headers/footers."""
        # Count occurrences of normalized content
        content_counts: Counter = Counter()

        for block in blocks:
            # Only consider short blocks for repetition detection
            content = block.content.strip()
            if len(content) < 100:
                normalized = self._normalize_for_comparison(content)
                if normalized:
                    content_counts[normalized] += 1

        # Return content that appears too many times
        repeated = {
            content
            for content, count in content_counts.items()
            if count >= self.repetition_threshold
        }

        if repeated:
            logger.debug(f"Detected {len(repeated)} repeated content patterns")

        return repeated

    def _normalize_for_comparison(self, content: str) -> str:
        """Normalize content for comparison (remove whitespace, lowercase)."""
        # Remove whitespace and convert to lowercase
        normalized = re.sub(r"\s+", " ", content.strip().lower())
        # Remove page numbers that might vary
        normalized = re.sub(r"\d+", "#", normalized)
        return normalized

    def _detect_toc_section(self, blocks: List[StructureBlock]) -> Set[int]:
        """Detect table of contents section indices."""
        toc_indices: Set[int] = set()
        in_toc = False
        toc_start = -1

        for i, block in enumerate(blocks):
            content = block.content.strip()

            # Check for TOC header
            if NOISE_PATTERNS["toc_marker"].match(content):
                in_toc = True
                toc_start = i
                toc_indices.add(i)
                continue

            # Check for TOC entry pattern
            if NOISE_PATTERNS["toc_entry"].match(content):
                if in_toc or self._looks_like_toc_context(blocks, i):
                    toc_indices.add(i)
                    continue

            # End of TOC - encounter non-TOC content after TOC entries
            if in_toc and not NOISE_PATTERNS["toc_entry"].match(content):
                # Check if this is still part of TOC (e.g., chapter title without page number)
                if self._is_toc_continuation(blocks, i, toc_indices):
                    toc_indices.add(i)
                else:
                    in_toc = False

        # Validate TOC ratio - if too much is flagged as TOC, probably wrong
        if len(toc_indices) > len(blocks) * self.max_toc_ratio:
            logger.warning(
                f"TOC detection flagged too many blocks ({len(toc_indices)}), resetting"
            )
            return set()

        return toc_indices

    def _looks_like_toc_context(self, blocks: List[StructureBlock], idx: int) -> bool:
        """Check if surrounding blocks look like TOC."""
        # Look at nearby blocks
        start = max(0, idx - 3)
        end = min(len(blocks), idx + 3)

        toc_like_count = 0
        for i in range(start, end):
            if i == idx:
                continue
            content = blocks[i].content.strip()
            if NOISE_PATTERNS["toc_entry"].match(content):
                toc_like_count += 1

        return toc_like_count >= 2

    def _is_toc_continuation(
        self,
        blocks: List[StructureBlock],
        idx: int,
        current_toc: Set[int],
    ) -> bool:
        """Check if block is continuation of TOC section."""
        # If previous block was TOC, and this is short, might be continuation
        if idx > 0 and (idx - 1) in current_toc:
            content = blocks[idx].content.strip()
            # Short lines in TOC context are likely TOC items
            if len(content) < 60:
                return True
        return False

    def _is_noise_block(self, block: StructureBlock) -> bool:
        """Check if a block is noise based on patterns."""
        content = block.content.strip()

        # Empty or too short
        if len(content) < self.min_content_length:
            return True

        # Whitespace only
        if NOISE_PATTERNS["whitespace_only"].match(content):
            return True

        # Page numbers
        if NOISE_PATTERNS["page_number"].match(content):
            return True
        if NOISE_PATTERNS["page_number_of"].match(content):
            return True
        if NOISE_PATTERNS["page_marker"].match(content):
            return True

        # Horizontal rules (unless it's heading underline)
        if NOISE_PATTERNS["horizontal_rule"].match(content):
            # Keep if it might be a Setext heading underline
            if block.type != BlockType.HEADING:
                return True

        # Copyright/confidential notices (keep heading ones)
        if block.type != BlockType.HEADING:
            if NOISE_PATTERNS["copyright"].search(content) and len(content) < 100:
                return True
            if NOISE_PATTERNS["confidential"].search(content) and len(content) < 50:
                return True

        return False

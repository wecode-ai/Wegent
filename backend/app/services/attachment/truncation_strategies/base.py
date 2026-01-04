# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base classes and types for smart truncation strategies.
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class TruncationType(str, Enum):
    """Type of truncation applied."""

    NONE = "none"  # No truncation needed
    SIMPLE = "simple"  # Simple text cut (fallback)
    SMART = "smart"  # Smart structural truncation


@dataclass
class SmartTruncationConfig:
    """Configuration for smart truncation."""

    # Maximum total length after truncation
    max_length: int = 500000

    # Excel/CSV settings (used as minimum values)
    excel_header_rows: int = 1  # Number of header rows to keep
    excel_sample_rows: int = 10  # Minimum sample rows after header
    excel_tail_rows: int = 5  # Minimum tail rows to keep
    excel_max_columns: int = 50  # Maximum columns to display

    # PDF settings (used as minimum values)
    pdf_first_pages: int = 3  # Minimum first pages to keep
    pdf_last_pages: int = 2  # Minimum last pages to keep

    # Word settings (used as minimum values)
    word_first_paragraphs: int = 10  # Minimum first paragraphs to keep
    word_last_paragraphs: int = 5  # Minimum last paragraphs to keep

    # PowerPoint settings (used as minimum values)
    ppt_first_slides: int = 3  # Minimum first slides to keep
    ppt_last_slides: int = 2  # Minimum last slides to keep

    # Text/Markdown settings (used as minimum values)
    text_head_lines: int = 100  # Minimum head lines to keep
    text_tail_lines: int = 50  # Minimum tail lines to keep


@dataclass
class SmartTruncationInfo:
    """Information about smart truncation applied."""

    truncation_type: TruncationType = TruncationType.NONE
    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None

    # Structure-specific info
    original_structure: Dict[str, Any] = field(default_factory=dict)
    # e.g., {"total_rows": 1000, "total_sheets": 3, "total_pages": 50}

    kept_structure: Dict[str, Any] = field(default_factory=dict)
    # e.g., {"header_rows": 1, "sample_rows": 10, "tail_rows": 5, "omitted_rows": 984}

    summary_message: str = ""  # Human-readable summary of truncation


class BaseTruncationStrategy(ABC):
    """Base class for truncation strategies."""

    # Distribution ratios for head/middle/tail (should sum to 1.0)
    # These can be overridden by subclasses
    HEAD_RATIO = 0.25  # 25% for head content
    MIDDLE_RATIO = 0.50  # 50% for uniformly sampled middle content
    TAIL_RATIO = 0.25  # 25% for tail content

    def __init__(self, config: SmartTruncationConfig):
        self.config = config

    @abstractmethod
    def truncate(
        self, content: Any, max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Apply smart truncation to content.

        Args:
            content: The parsed content (format-specific)
            max_length: Maximum allowed length

        Returns:
            Tuple of (truncated_text, truncation_info)
        """
        pass

    def _estimate_length(self, text: str) -> int:
        """Estimate the length of text."""
        return len(text)

    def _uniform_sample_indices(
        self, total: int, sample_count: int, include_endpoints: bool = True
    ) -> List[int]:
        """
        Generate uniformly distributed sample indices.

        Args:
            total: Total number of items to sample from
            sample_count: Number of samples to take
            include_endpoints: If True, always include first (0) and last (total-1) indices

        Returns:
            Sorted list of indices to sample
        """
        if sample_count >= total:
            return list(range(total))

        if sample_count <= 0:
            return []

        if sample_count == 1:
            return [0]

        if sample_count == 2:
            return [0, total - 1] if include_endpoints else [0, total // 2]

        indices = set()

        if include_endpoints:
            # Always include first and last
            indices.add(0)
            indices.add(total - 1)
            remaining = sample_count - 2

            if remaining > 0:
                # Distribute remaining samples uniformly in between
                step = (total - 2) / (remaining + 1)
                for i in range(1, remaining + 1):
                    idx = int(i * step)
                    if idx > 0 and idx < total - 1:
                        indices.add(idx)
        else:
            # Pure uniform sampling
            step = total / sample_count
            for i in range(sample_count):
                idx = int(i * step)
                indices.add(min(idx, total - 1))

        # If we still need more samples (due to rounding), add more
        while len(indices) < sample_count:
            sorted_indices = sorted(indices)
            max_gap = 0
            gap_start = 0
            for i in range(len(sorted_indices) - 1):
                gap = sorted_indices[i + 1] - sorted_indices[i]
                if gap > max_gap:
                    max_gap = gap
                    gap_start = sorted_indices[i]
            if max_gap > 1:
                indices.add(gap_start + max_gap // 2)
            else:
                break

        return sorted(indices)[:sample_count]

    def _calculate_distribution(
        self, total_items: int, items_to_keep: int
    ) -> Tuple[int, int, int]:
        """
        Calculate how many items to keep in head, middle, and tail sections.

        Args:
            total_items: Total number of items available
            items_to_keep: Total number of items we can keep

        Returns:
            Tuple of (head_count, middle_count, tail_count)
        """
        if items_to_keep >= total_items:
            return total_items, 0, 0

        head_count = max(1, int(items_to_keep * self.HEAD_RATIO))
        tail_count = max(1, int(items_to_keep * self.TAIL_RATIO))
        middle_count = max(0, items_to_keep - head_count - tail_count)

        # Ensure we don't exceed total items
        if head_count + tail_count >= total_items:
            # Not enough items for middle section
            head_count = items_to_keep // 2
            tail_count = items_to_keep - head_count
            middle_count = 0

        return head_count, middle_count, tail_count

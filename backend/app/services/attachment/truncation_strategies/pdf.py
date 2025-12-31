# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
PDF truncation strategy using head + uniform sampling + tail approach.
"""

from typing import List, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationInfo,
    TruncationType,
)


class PDFTruncationStrategy(BaseTruncationStrategy):
    """
    Smart truncation for PDF files using head + uniform sampling + tail strategy.

    This strategy preserves:
    1. Head pages - introduction, abstract, table of contents
    2. Uniformly sampled middle pages - coverage across the entire document
    3. Tail pages - conclusion, references, summary
    """

    def truncate(
        self, pages_text: List[str], max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate PDF with head + uniform sampling + tail strategy.

        Args:
            pages_text: List of text content per page
            max_length: Maximum allowed length

        Returns:
            Tuple of (truncated_text, truncation_info)
        """
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)

        total_pages = len(pages_text)

        # Format all pages with headers
        full_parts = []
        for i, page_text in enumerate(pages_text, 1):
            full_parts.append(f"--- Page {i} ---\n{page_text}")
        original_text = "\n\n".join(full_parts)
        original_length = len(original_text)

        info.original_structure = {
            "total_pages": total_pages,
            "total_length": original_length,
        }

        # If content fits, no truncation needed
        if original_length <= max_length:
            info.truncation_type = TruncationType.NONE
            info.is_truncated = False
            info.truncated_length = original_length
            return original_text, info

        # Calculate how many pages we can keep based on max_length
        avg_page_len = original_length / max(1, total_pages)
        overhead = 200  # Space for section markers and omission messages
        available_length = max_length - overhead
        max_pages_to_keep = max(3, int(available_length / avg_page_len))

        # Ensure we don't exceed total pages
        if max_pages_to_keep >= total_pages:
            truncated = original_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE
            info.is_truncated = True
            info.original_length = original_length
            info.truncated_length = len(truncated)
            info.summary_message = f"Content truncated to {max_length} characters"
            return truncated, info

        # Distribute pages: head (25%), middle (50%), tail (25%)
        head_count, middle_count, tail_count = self._calculate_distribution(
            total_pages, max_pages_to_keep
        )

        # Calculate middle section boundaries
        middle_start = head_count
        middle_end = total_pages - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            # Not enough pages for middle section, just do head + tail
            head_count = max_pages_to_keep // 2
            tail_count = max_pages_to_keep - head_count
            middle_count = 0
            middle_available = 0

        # Extract sections
        head_section = list(enumerate(pages_text[:head_count], 1))
        tail_section = list(
            enumerate(
                pages_text[-tail_count:] if tail_count > 0 else [],
                total_pages - tail_count + 1,
            )
        )

        # Sample middle section uniformly
        if middle_count > 0 and middle_available > 0:
            if middle_count >= middle_available:
                middle_indices = list(range(middle_available))
            else:
                middle_indices = self._uniform_sample_indices(
                    middle_available, middle_count, include_endpoints=True
                )
            middle_section = [
                (middle_start + idx + 1, pages_text[middle_start + idx])
                for idx in middle_indices
            ]
        else:
            middle_section = []

        # Format output
        parts = []

        # Head pages
        if head_section:
            parts.append(f"# Head Section (pages 1-{head_count})")
            for page_num, page_text in head_section:
                parts.append(f"--- Page {page_num} ---\n{page_text}")

        # Middle sampled pages
        if middle_section:
            parts.append(
                f"\n# Middle Section ({len(middle_section)} pages sampled from pages {middle_start + 1}-{middle_end})"
            )
            prev_page = head_count
            for page_num, page_text in middle_section:
                gap = page_num - prev_page - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} pages skipped] ...")
                parts.append(f"--- Page {page_num} ---\n{page_text}")
                prev_page = page_num

            # Gap before tail
            if tail_section:
                gap_to_tail = (total_pages - tail_count + 1) - prev_page - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} pages skipped] ...")
        elif head_section and tail_section:
            # No middle section, show gap between head and tail
            gap = total_pages - tail_count - head_count
            if gap > 0:
                parts.append(f"\n... [{gap} pages omitted] ...")

        # Tail pages
        if tail_section:
            parts.append(
                f"\n# Tail Section (pages {total_pages - tail_count + 1}-{total_pages})"
            )
            for page_num, page_text in tail_section:
                parts.append(f"--- Page {page_num} ---\n{page_text}")

        result_text = "\n\n".join(parts)

        # Final length check
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = original_length
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "head_pages": head_count,
            "middle_pages_sampled": len(middle_section),
            "tail_pages": tail_count,
            "total_kept": head_count + len(middle_section) + len(tail_section),
            "omitted_pages": total_pages
            - (head_count + len(middle_section) + len(tail_section)),
            "sampling_method": "head_uniform_tail",
        }
        info.summary_message = (
            f"[Smart Truncation Applied - Head + Uniform Sampling + Tail]\n"
            f"Total: {total_pages} pages\n"
            f"Kept: {head_count} head + {len(middle_section)} middle (sampled) + {len(tail_section)} tail pages\n"
            f"Omitted: {total_pages - (head_count + len(middle_section) + len(tail_section))} pages"
        )

        return result_text, info

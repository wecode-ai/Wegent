# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
PowerPoint truncation strategy using head + uniform sampling + tail approach.
"""

from typing import List, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationInfo,
    TruncationType,
)


class PowerPointTruncationStrategy(BaseTruncationStrategy):
    """
    Smart truncation for PowerPoint files using head + uniform sampling + tail strategy.

    This strategy preserves:
    1. Head slides - title, agenda, introduction
    2. Uniformly sampled middle slides - coverage across the entire presentation
    3. Tail slides - conclusion, summary, Q&A
    """

    def truncate(
        self, slides_text: List[str], max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate PowerPoint with head + uniform sampling + tail strategy.

        Args:
            slides_text: List of text content per slide
            max_length: Maximum allowed length

        Returns:
            Tuple of (truncated_text, truncation_info)
        """
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)

        total_slides = len(slides_text)
        original_text = "\n\n".join(slides_text)
        original_length = len(original_text)

        info.original_structure = {
            "total_slides": total_slides,
            "total_length": original_length,
        }

        # If content fits, no truncation needed
        if original_length <= max_length:
            info.truncation_type = TruncationType.NONE
            info.is_truncated = False
            info.truncated_length = original_length
            return original_text, info

        # Calculate how many slides we can keep based on max_length
        avg_slide_len = original_length / max(1, total_slides)
        overhead = 200  # Space for section markers and omission messages
        available_length = max_length - overhead
        max_slides_to_keep = max(3, int(available_length / avg_slide_len))

        # Ensure we don't exceed total slides
        if max_slides_to_keep >= total_slides:
            truncated = original_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE
            info.is_truncated = True
            info.original_length = original_length
            info.truncated_length = len(truncated)
            info.summary_message = f"Content truncated to {max_length} characters"
            return truncated, info

        # Distribute slides: head (25%), middle (50%), tail (25%)
        head_count, middle_count, tail_count = self._calculate_distribution(
            total_slides, max_slides_to_keep
        )

        # Calculate middle section boundaries
        middle_start = head_count
        middle_end = total_slides - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            # Not enough slides for middle section, just do head + tail
            head_count = max_slides_to_keep // 2
            tail_count = max_slides_to_keep - head_count
            middle_count = 0
            middle_available = 0

        # Extract sections (slides already have their own headers like "--- Slide N ---")
        head_section = list(enumerate(slides_text[:head_count], 1))
        tail_section = list(
            enumerate(
                slides_text[-tail_count:] if tail_count > 0 else [],
                total_slides - tail_count + 1,
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
                (middle_start + idx + 1, slides_text[middle_start + idx])
                for idx in middle_indices
            ]
        else:
            middle_section = []

        # Format output
        parts = []

        # Head slides
        if head_section:
            parts.append(f"# Head Section (slides 1-{head_count})")
            for slide_num, slide_text in head_section:
                parts.append(slide_text)

        # Middle sampled slides
        if middle_section:
            parts.append(
                f"\n# Middle Section ({len(middle_section)} slides sampled from slides {middle_start + 1}-{middle_end})"
            )
            prev_slide = head_count
            for slide_num, slide_text in middle_section:
                gap = slide_num - prev_slide - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} slides skipped] ...")
                parts.append(slide_text)
                prev_slide = slide_num

            # Gap before tail
            if tail_section:
                gap_to_tail = (total_slides - tail_count + 1) - prev_slide - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} slides skipped] ...")
        elif head_section and tail_section:
            # No middle section, show gap between head and tail
            gap = total_slides - tail_count - head_count
            if gap > 0:
                parts.append(f"\n... [{gap} slides omitted] ...")

        # Tail slides
        if tail_section:
            parts.append(
                f"\n# Tail Section (slides {total_slides - tail_count + 1}-{total_slides})"
            )
            for slide_num, slide_text in tail_section:
                parts.append(slide_text)

        result_text = "\n\n".join(parts)

        # Final length check
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = original_length
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "head_slides": head_count,
            "middle_slides_sampled": len(middle_section),
            "tail_slides": tail_count,
            "total_kept": head_count + len(middle_section) + len(tail_section),
            "omitted_slides": total_slides
            - (head_count + len(middle_section) + len(tail_section)),
            "sampling_method": "head_uniform_tail",
        }
        info.summary_message = (
            f"[Smart Truncation Applied - Head + Uniform Sampling + Tail]\n"
            f"Total: {total_slides} slides\n"
            f"Kept: {head_count} head + {len(middle_section)} middle (sampled) + {len(tail_section)} tail slides\n"
            f"Omitted: {total_slides - (head_count + len(middle_section) + len(tail_section))} slides"
        )

        return result_text, info

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Word document truncation strategy using head + uniform sampling + tail approach.
"""

from typing import List, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationInfo,
    TruncationType,
)


class WordTruncationStrategy(BaseTruncationStrategy):
    """
    Smart truncation for Word documents using head + uniform sampling + tail strategy.

    This strategy preserves:
    1. Head paragraphs - introduction, abstract, document purpose
    2. Uniformly sampled middle paragraphs - coverage across the entire document
    3. Tail paragraphs - conclusion, summary, recommendations
    """

    def truncate(
        self, paragraphs: List[str], max_length: int
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate Word document with head + uniform sampling + tail strategy.

        Args:
            paragraphs: List of paragraph texts
            max_length: Maximum allowed length

        Returns:
            Tuple of (truncated_text, truncation_info)
        """
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)

        total_paragraphs = len(paragraphs)
        original_text = "\n\n".join(paragraphs)
        original_length = len(original_text)

        info.original_structure = {
            "total_paragraphs": total_paragraphs,
            "total_length": original_length,
        }

        # If content fits, no truncation needed
        if original_length <= max_length:
            info.truncation_type = TruncationType.NONE
            info.is_truncated = False
            info.truncated_length = original_length
            return original_text, info

        # Calculate how many paragraphs we can keep based on max_length
        avg_para_len = original_length / max(1, total_paragraphs)
        overhead = 200  # Space for section markers and omission messages
        available_length = max_length - overhead
        max_paras_to_keep = max(3, int(available_length / avg_para_len))

        # Ensure we don't exceed total paragraphs
        if max_paras_to_keep >= total_paragraphs:
            truncated = original_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE
            info.is_truncated = True
            info.original_length = original_length
            info.truncated_length = len(truncated)
            info.summary_message = f"Content truncated to {max_length} characters"
            return truncated, info

        # Distribute paragraphs: head (25%), middle (50%), tail (25%)
        head_count, middle_count, tail_count = self._calculate_distribution(
            total_paragraphs, max_paras_to_keep
        )

        # Calculate middle section boundaries
        middle_start = head_count
        middle_end = total_paragraphs - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            # Not enough paragraphs for middle section, just do head + tail
            head_count = max_paras_to_keep // 2
            tail_count = max_paras_to_keep - head_count
            middle_count = 0
            middle_available = 0

        # Extract sections
        head_section = list(enumerate(paragraphs[:head_count], 1))
        tail_section = list(
            enumerate(
                paragraphs[-tail_count:] if tail_count > 0 else [],
                total_paragraphs - tail_count + 1,
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
                (middle_start + idx + 1, paragraphs[middle_start + idx])
                for idx in middle_indices
            ]
        else:
            middle_section = []

        # Format output
        parts = []

        # Head paragraphs
        if head_section:
            parts.append(f"# Head Section (paragraphs 1-{head_count})")
            for para_num, para_text in head_section:
                parts.append(f"[Paragraph {para_num}]\n{para_text}")

        # Middle sampled paragraphs
        if middle_section:
            parts.append(
                f"\n# Middle Section ({len(middle_section)} paragraphs sampled from paragraphs {middle_start + 1}-{middle_end})"
            )
            prev_para = head_count
            for para_num, para_text in middle_section:
                gap = para_num - prev_para - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} paragraphs skipped] ...")
                parts.append(f"[Paragraph {para_num}]\n{para_text}")
                prev_para = para_num

            # Gap before tail
            if tail_section:
                gap_to_tail = (total_paragraphs - tail_count + 1) - prev_para - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} paragraphs skipped] ...")
        elif head_section and tail_section:
            # No middle section, show gap between head and tail
            gap = total_paragraphs - tail_count - head_count
            if gap > 0:
                parts.append(f"\n... [{gap} paragraphs omitted] ...")

        # Tail paragraphs
        if tail_section:
            parts.append(
                f"\n# Tail Section (paragraphs {total_paragraphs - tail_count + 1}-{total_paragraphs})"
            )
            for para_num, para_text in tail_section:
                parts.append(f"[Paragraph {para_num}]\n{para_text}")

        result_text = "\n\n".join(parts)

        # Final length check
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = original_length
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "head_paragraphs": head_count,
            "middle_paragraphs_sampled": len(middle_section),
            "tail_paragraphs": tail_count,
            "total_kept": head_count + len(middle_section) + len(tail_section),
            "omitted_paragraphs": total_paragraphs
            - (head_count + len(middle_section) + len(tail_section)),
            "sampling_method": "head_uniform_tail",
        }
        info.summary_message = (
            f"[Smart Truncation Applied - Head + Uniform Sampling + Tail]\n"
            f"Total: {total_paragraphs} paragraphs\n"
            f"Kept: {head_count} head + {len(middle_section)} middle (sampled) + {len(tail_section)} tail paragraphs\n"
            f"Omitted: {total_paragraphs - (head_count + len(middle_section) + len(tail_section))} paragraphs"
        )

        return result_text, info

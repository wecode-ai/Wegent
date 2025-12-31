# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Text and Markdown truncation strategy using head + uniform sampling + tail approach.
"""

import re
from typing import List, Tuple

from .base import (
    BaseTruncationStrategy,
    SmartTruncationInfo,
    TruncationType,
)


class TextTruncationStrategy(BaseTruncationStrategy):
    """
    Smart truncation for plain text and markdown files.

    For Markdown files, this strategy:
    1. Preserves document structure (headings)
    2. Keeps head content (introduction, overview)
    3. Uniformly samples middle sections
    4. Keeps tail content (conclusion, summary)

    For plain text, uses line-based head + uniform sampling + tail strategy.
    """

    # Markdown heading patterns (# to ######)
    MARKDOWN_HEADING_PATTERN = r"^#{1,6}\s+"

    def truncate(self, text: str, max_length: int) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate text/markdown with structure-aware strategy.

        For markdown: Preserves headings and uses section-based truncation.
        For plain text: Uses line-based head + uniform sampling + tail.

        Args:
            text: The text content
            max_length: Maximum allowed length

        Returns:
            Tuple of (truncated_text, truncation_info)
        """
        info = SmartTruncationInfo(truncation_type=TruncationType.SMART)

        original_length = len(text)
        lines = text.split("\n")
        total_lines = len(lines)

        # Detect if this is markdown by checking for headings
        heading_pattern = re.compile(self.MARKDOWN_HEADING_PATTERN)
        heading_indices = [
            i for i, line in enumerate(lines) if heading_pattern.match(line)
        ]
        is_markdown = (
            len(heading_indices) >= 2
        )  # At least 2 headings to consider it structured

        info.original_structure = {
            "total_lines": total_lines,
            "total_length": original_length,
            "is_markdown": is_markdown,
            "heading_count": len(heading_indices),
        }

        # If content fits, no truncation needed
        if original_length <= max_length:
            info.truncation_type = TruncationType.NONE
            info.is_truncated = False
            info.truncated_length = original_length
            return text, info

        # Use markdown-aware truncation if structured, otherwise line-based
        if is_markdown and len(heading_indices) >= 3:
            return self._truncate_markdown(
                text, lines, heading_indices, max_length, info
            )
        else:
            return self._truncate_plain_text(text, lines, max_length, info)

    def _truncate_markdown(
        self,
        text: str,
        lines: List[str],
        heading_indices: List[int],
        max_length: int,
        info: SmartTruncationInfo,
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate markdown with section-aware strategy.

        Preserves all headings and samples content from each section.
        """
        total_lines = len(lines)

        # Parse sections (each section starts with a heading)
        sections = []
        for i, heading_idx in enumerate(heading_indices):
            next_heading_idx = (
                heading_indices[i + 1] if i + 1 < len(heading_indices) else total_lines
            )
            section_lines = lines[heading_idx:next_heading_idx]
            sections.append(
                {
                    "heading_idx": heading_idx,
                    "heading": lines[heading_idx],
                    "content_lines": section_lines[1:],  # Lines after heading
                    "start_line": heading_idx,
                    "end_line": next_heading_idx,
                }
            )

        # Also capture any content before the first heading
        if heading_indices[0] > 0:
            preamble = lines[: heading_indices[0]]
        else:
            preamble = []

        total_sections = len(sections)

        # Calculate how many sections we can keep
        # Reserve space for all headings (they're always kept)
        headings_text = "\n".join(s["heading"] for s in sections)
        preamble_text = "\n".join(preamble) if preamble else ""
        overhead = len(headings_text) + len(preamble_text) + 300  # Extra for markers

        available_length = max_length - overhead
        if available_length <= 0:
            # Not enough space, fall back to simple truncation
            return self._truncate_plain_text(text, lines, max_length, info)

        # Calculate average content length per section
        total_content_len = sum(len("\n".join(s["content_lines"])) for s in sections)
        avg_section_content_len = total_content_len / max(1, total_sections)

        # Determine how many sections' content we can fully include
        max_sections_content = max(
            3, int(available_length / max(1, avg_section_content_len))
        )

        # Distribute sections: head (25%), middle (50%), tail (25%)
        head_count, middle_count, tail_count = self._calculate_distribution(
            total_sections, max_sections_content
        )

        # Calculate middle section boundaries
        middle_start = head_count
        middle_end = total_sections - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            head_count = max_sections_content // 2
            tail_count = max_sections_content - head_count
            middle_count = 0
            middle_available = 0

        # Sample middle sections uniformly
        if middle_count > 0 and middle_available > 0:
            if middle_count >= middle_available:
                middle_indices = list(range(middle_available))
            else:
                middle_indices = self._uniform_sample_indices(
                    middle_available, middle_count, include_endpoints=True
                )
            middle_section_indices = [middle_start + idx for idx in middle_indices]
        else:
            middle_section_indices = []

        # Build output
        parts = []

        # Preamble (content before first heading)
        if preamble:
            parts.append("# Document Preamble")
            parts.extend(preamble)

        # Head sections (full content)
        if head_count > 0:
            parts.append(f"\n# Head Sections (sections 1-{head_count})")
            for i in range(head_count):
                section = sections[i]
                parts.append(section["heading"])
                parts.extend(section["content_lines"])

        # Middle sampled sections
        if middle_section_indices:
            parts.append(
                f"\n# Middle Sections ({len(middle_section_indices)} sections sampled from sections {middle_start + 1}-{middle_end})"
            )
            prev_idx = head_count - 1
            for section_idx in middle_section_indices:
                gap = section_idx - prev_idx - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} sections skipped] ...")
                section = sections[section_idx]
                parts.append(section["heading"])
                # For middle sections, keep limited content
                content = section["content_lines"]
                if len(content) > 10:
                    parts.extend(content[:5])
                    parts.append(
                        f"  ... [{len(content) - 8} lines skipped in this section] ..."
                    )
                    parts.extend(content[-3:])
                else:
                    parts.extend(content)
                prev_idx = section_idx

            # Gap before tail
            if tail_count > 0:
                gap_to_tail = (total_sections - tail_count) - prev_idx - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} sections skipped] ...")
        elif head_count > 0 and tail_count > 0:
            gap = total_sections - tail_count - head_count
            if gap > 0:
                parts.append(f"\n... [{gap} sections omitted] ...")

        # Tail sections (full content)
        if tail_count > 0:
            parts.append(
                f"\n# Tail Sections (sections {total_sections - tail_count + 1}-{total_sections})"
            )
            for i in range(total_sections - tail_count, total_sections):
                section = sections[i]
                parts.append(section["heading"])
                parts.extend(section["content_lines"])

        result_text = "\n".join(parts)

        # Final length check
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = len(text)
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "total_sections": total_sections,
            "head_sections": head_count,
            "middle_sections_sampled": len(middle_section_indices),
            "tail_sections": tail_count,
            "total_kept": head_count + len(middle_section_indices) + tail_count,
            "omitted_sections": total_sections
            - (head_count + len(middle_section_indices) + tail_count),
            "sampling_method": "head_uniform_tail",
            "structure_preserved": "markdown_headings",
        }
        info.summary_message = (
            f"[Smart Truncation Applied - Markdown Structure Preserved]\n"
            f"Total: {total_sections} sections (with {len(heading_indices)} headings)\n"
            f"Kept: {head_count} head + {len(middle_section_indices)} middle (sampled) + {tail_count} tail sections\n"
            f"Omitted: {total_sections - (head_count + len(middle_section_indices) + tail_count)} sections"
        )

        return result_text, info

    def _truncate_plain_text(
        self,
        text: str,
        lines: List[str],
        max_length: int,
        info: SmartTruncationInfo,
    ) -> Tuple[str, SmartTruncationInfo]:
        """
        Truncate plain text with line-based head + uniform sampling + tail strategy.
        """
        total_lines = len(lines)
        original_length = len(text)

        # Calculate how many lines we can keep based on max_length
        avg_line_len = original_length / max(1, total_lines)
        overhead = 200  # Space for section markers and omission messages
        available_length = max_length - overhead
        max_lines_to_keep = max(3, int(available_length / avg_line_len))

        # Ensure we don't exceed total lines
        if max_lines_to_keep >= total_lines:
            truncated = text[:max_length]
            info.truncation_type = TruncationType.SIMPLE
            info.is_truncated = True
            info.original_length = original_length
            info.truncated_length = len(truncated)
            info.summary_message = f"Content truncated to {max_length} characters"
            return truncated, info

        # Distribute lines: head (25%), middle (50%), tail (25%)
        head_count, middle_count, tail_count = self._calculate_distribution(
            total_lines, max_lines_to_keep
        )

        # Calculate middle section boundaries
        middle_start = head_count
        middle_end = total_lines - tail_count
        middle_available = middle_end - middle_start

        if middle_available <= 0:
            head_count = max_lines_to_keep // 2
            tail_count = max_lines_to_keep - head_count
            middle_count = 0
            middle_available = 0

        # Extract sections
        head_section = list(enumerate(lines[:head_count], 1))
        tail_section = list(
            enumerate(
                lines[-tail_count:] if tail_count > 0 else [],
                total_lines - tail_count + 1,
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
                (middle_start + idx + 1, lines[middle_start + idx])
                for idx in middle_indices
            ]
        else:
            middle_section = []

        # Format output
        parts = []

        # Head lines
        if head_section:
            parts.append(f"# Head Section (lines 1-{head_count})")
            for line_num, line_text in head_section:
                parts.append(line_text)

        # Middle sampled lines
        if middle_section:
            parts.append(
                f"\n# Middle Section ({len(middle_section)} lines sampled from lines {middle_start + 1}-{middle_end})"
            )
            prev_line = head_count
            for line_num, line_text in middle_section:
                gap = line_num - prev_line - 1
                if gap > 0:
                    parts.append(f"  ... [{gap} lines skipped] ...")
                parts.append(f"[Line {line_num}] {line_text}")
                prev_line = line_num

            # Gap before tail
            if tail_section:
                gap_to_tail = (total_lines - tail_count + 1) - prev_line - 1
                if gap_to_tail > 0:
                    parts.append(f"  ... [{gap_to_tail} lines skipped] ...")
        elif head_section and tail_section:
            gap = total_lines - tail_count - head_count
            if gap > 0:
                parts.append(f"\n... [{gap} lines omitted] ...")

        # Tail lines
        if tail_section:
            parts.append(
                f"\n# Tail Section (lines {total_lines - tail_count + 1}-{total_lines})"
            )
            for line_num, line_text in tail_section:
                parts.append(line_text)

        result_text = "\n".join(parts)

        # Final length check
        if len(result_text) > max_length:
            result_text = result_text[:max_length]
            info.truncation_type = TruncationType.SIMPLE

        info.is_truncated = True
        info.original_length = original_length
        info.truncated_length = len(result_text)
        info.kept_structure = {
            "head_lines": head_count,
            "middle_lines_sampled": len(middle_section),
            "tail_lines": tail_count,
            "total_kept": head_count + len(middle_section) + len(tail_section),
            "omitted_lines": total_lines
            - (head_count + len(middle_section) + len(tail_section)),
            "sampling_method": "head_uniform_tail",
        }
        info.summary_message = (
            f"[Smart Truncation Applied - Head + Uniform Sampling + Tail]\n"
            f"Total: {total_lines} lines\n"
            f"Kept: {head_count} head + {len(middle_section)} middle (sampled) + {len(tail_section)} tail lines\n"
            f"Omitted: {total_lines - (head_count + len(middle_section) + len(tail_section))} lines"
        )

        return result_text, info

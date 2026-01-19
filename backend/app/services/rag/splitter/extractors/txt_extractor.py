# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Plain text extractor with basic structure detection."""

import logging
import re
from typing import Any, Dict, List, Tuple

from .base import BaseExtractor, LineMetadata

logger = logging.getLogger(__name__)


class TxtExtractor(BaseExtractor):
    """
    Extractor for plain text documents.

    Attempts to detect:
    - Pseudo-headings (all caps lines, lines ending with :)
    - List-like patterns (lines starting with -, *, numbers)
    - Code-like blocks (indented blocks)
    """

    # Plain text structure patterns
    ALL_CAPS_LINE = re.compile(r"^[A-Z][A-Z\s\d]+$")
    COLON_HEADING = re.compile(r"^[A-Z].*:$")
    LIST_BULLET = re.compile(r"^(\s*)([-*])\s+(.*)$")
    LIST_NUMBER = re.compile(r"^(\s*)(\d+)[.)]\s+(.*)$")
    INDENTED_LINE = re.compile(r"^(\s{4,}|\t+)(.*)$")

    def extract_from_text(
        self,
        text: str,
        filename: str,
    ) -> Tuple[str, List[LineMetadata], List[Dict[str, Any]]]:
        """
        Extract text content and metadata from plain text.

        Args:
            text: Raw text content
            filename: Original filename for logging

        Returns:
            Tuple of (cleaned_text, line_metadata, skipped_elements)
        """
        # Detect and record non-text elements (base64 images, etc.)
        has_non_text, skipped_elements = self.detect_non_text_elements(text)

        if has_non_text:
            logger.info(
                f"Document '{filename}' has {len(skipped_elements)} non-text elements to skip"
            )

        # Remove non-text elements
        cleaned_text = self.remove_non_text_elements(text)

        # Parse line metadata
        line_metadata = self._parse_line_metadata(cleaned_text)

        return cleaned_text, line_metadata, skipped_elements

    def _parse_line_metadata(self, text: str) -> List[LineMetadata]:
        """Parse line-by-line metadata from plain text."""
        lines = text.split("\n")
        metadata_list: List[LineMetadata] = []

        in_indented_block = False
        indent_start_level = 0

        for line_num, line in enumerate(lines, start=1):
            meta = LineMetadata(
                line_number=line_num,
                original_line=line,
            )

            stripped = line.strip()

            # Empty lines
            if not stripped:
                in_indented_block = False
                metadata_list.append(meta)
                continue

            # Check for indented code-like blocks
            indent_match = self.INDENTED_LINE.match(line)
            if indent_match:
                indent_len = len(indent_match.group(1).replace("\t", "    "))
                if not in_indented_block:
                    in_indented_block = True
                    indent_start_level = indent_len
                if indent_len >= indent_start_level:
                    meta.is_code_block = True
                    meta.indent_level = indent_len // 4
                    metadata_list.append(meta)
                    continue
            else:
                in_indented_block = False

            # Check for ALL CAPS headings
            if self.ALL_CAPS_LINE.match(stripped) and len(stripped) > 3:
                meta.is_heading = True
                meta.heading_level = 1  # Treat as top-level heading
                metadata_list.append(meta)
                continue

            # Check for colon-ending headings
            if self.COLON_HEADING.match(stripped) and len(stripped) < 100:
                meta.is_heading = True
                meta.heading_level = 2
                metadata_list.append(meta)
                continue

            # Check for bullet lists
            bullet_match = self.LIST_BULLET.match(line)
            if bullet_match:
                meta.is_list_item = True
                meta.list_type = "unordered"
                meta.indent_level = len(bullet_match.group(1)) // 2
                metadata_list.append(meta)
                continue

            # Check for numbered lists
            number_match = self.LIST_NUMBER.match(line)
            if number_match:
                meta.is_list_item = True
                meta.list_type = "ordered"
                meta.indent_level = len(number_match.group(1)) // 2
                metadata_list.append(meta)
                continue

            # Regular line
            meta.indent_level = self._get_indent_level(line)
            metadata_list.append(meta)

        return metadata_list

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Markdown text extractor with structure preservation."""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from .base import BaseExtractor, LineMetadata

logger = logging.getLogger(__name__)


class MarkdownExtractor(BaseExtractor):
    """
    Extractor for Markdown documents.

    Preserves:
    - Heading markers (#)
    - Code block markers (```)
    - List markers (-, *, 1.)
    - Table structure
    - Blockquote markers (>)

    Removes and records:
    - Image references
    - HTML embedded content
    """

    # Markdown-specific patterns
    HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$")
    CODE_BLOCK_START = re.compile(r"^```(\w*)\s*$")
    CODE_BLOCK_END = re.compile(r"^```\s*$")
    UNORDERED_LIST_PATTERN = re.compile(r"^(\s*)([-*+])\s+(.*)$")
    ORDERED_LIST_PATTERN = re.compile(r"^(\s*)(\d+)[.)]\s+(.*)$")
    BLOCKQUOTE_PATTERN = re.compile(r"^(\s*>)+\s*(.*)$")
    TABLE_ROW_PATTERN = re.compile(r"^\|.*\|$")
    TABLE_SEPARATOR_PATTERN = re.compile(r"^\|[\s\-:|]+\|$")
    DEFINITION_PATTERN = re.compile(r"^:\s+(.+)$")  # Definition in Markdown
    QA_QUESTION_PATTERN = re.compile(r"^[QqAa][:：]\s*(.+)$")

    def extract_from_text(
        self,
        text: str,
        filename: str,
    ) -> Tuple[str, List[LineMetadata], List[Dict[str, Any]]]:
        """
        Extract text content and metadata from Markdown text.

        Args:
            text: Raw Markdown text content
            filename: Original filename for logging

        Returns:
            Tuple of (cleaned_text, line_metadata, skipped_elements)
        """
        # Detect and record non-text elements
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
        """Parse line-by-line metadata from Markdown text."""
        lines = text.split("\n")
        metadata_list: List[LineMetadata] = []

        in_code_block = False
        code_language: Optional[str] = None

        for line_num, line in enumerate(lines, start=1):
            meta = LineMetadata(
                line_number=line_num,
                original_line=line,
            )

            # Check for code block boundaries
            if not in_code_block:
                code_start_match = self.CODE_BLOCK_START.match(line)
                if code_start_match:
                    in_code_block = True
                    code_language = code_start_match.group(1) or None
                    meta.is_code_block = True
                    meta.code_language = code_language
                    metadata_list.append(meta)
                    continue
            else:
                if self.CODE_BLOCK_END.match(line):
                    in_code_block = False
                    code_language = None
                    meta.is_code_block = True
                    metadata_list.append(meta)
                    continue
                else:
                    meta.is_code_block = True
                    meta.code_language = code_language
                    metadata_list.append(meta)
                    continue

            # Check for headings
            heading_match = self.HEADING_PATTERN.match(line)
            if heading_match:
                meta.is_heading = True
                meta.heading_level = len(heading_match.group(1))
                metadata_list.append(meta)
                continue

            # Check for unordered list
            unordered_match = self.UNORDERED_LIST_PATTERN.match(line)
            if unordered_match:
                meta.is_list_item = True
                meta.list_type = "unordered"
                meta.indent_level = len(unordered_match.group(1)) // 2
                metadata_list.append(meta)
                continue

            # Check for ordered list
            ordered_match = self.ORDERED_LIST_PATTERN.match(line)
            if ordered_match:
                meta.is_list_item = True
                meta.list_type = "ordered"
                meta.indent_level = len(ordered_match.group(1)) // 2
                metadata_list.append(meta)
                continue

            # Check for blockquote
            if self.BLOCKQUOTE_PATTERN.match(line):
                meta.metadata["is_blockquote"] = True
                metadata_list.append(meta)
                continue

            # Check for table row
            if self.TABLE_ROW_PATTERN.match(line):
                if self.TABLE_SEPARATOR_PATTERN.match(line):
                    meta.metadata["is_table_separator"] = True
                else:
                    meta.metadata["is_table_row"] = True
                metadata_list.append(meta)
                continue

            # Check for Q&A pattern
            qa_match = self.QA_QUESTION_PATTERN.match(line)
            if qa_match:
                meta.metadata["is_qa"] = True
                meta.metadata["qa_type"] = line[0].upper()  # Q or A
                metadata_list.append(meta)
                continue

            # Calculate indent level for regular lines
            meta.indent_level = self._get_indent_level(line)
            metadata_list.append(meta)

        return metadata_list

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DOCX text extractor with structure preservation."""

import logging
import re
from typing import Any, Dict, List, Tuple

from .base import BaseExtractor, LineMetadata

logger = logging.getLogger(__name__)


class DocxExtractor(BaseExtractor):
    """
    Extractor for DOCX documents.

    Note: The actual DOCX parsing is typically done before this extractor
    receives the text. This extractor handles the pre-converted text and
    detects any remaining non-text elements.

    For DOCX files that have been converted to text with structure markers:
    - Preserves heading markers
    - Detects embedded images/charts that may have been converted to text markers
    - Handles table structures
    """

    # DOCX-specific patterns (post-conversion markers)
    DOCX_IMAGE_MARKER = re.compile(r"\[IMAGE:?\s*([^\]]*)\]", re.IGNORECASE)
    DOCX_CHART_MARKER = re.compile(r"\[CHART:?\s*([^\]]*)\]", re.IGNORECASE)
    DOCX_DRAWING_MARKER = re.compile(r"\[DRAWING:?\s*([^\]]*)\]", re.IGNORECASE)
    DOCX_EQUATION_MARKER = re.compile(r"\[EQUATION:?\s*([^\]]*)\]", re.IGNORECASE)
    DOCX_TABLE_MARKER = re.compile(r"\[TABLE:?\s*([^\]]*)\]", re.IGNORECASE)

    # Heading patterns from DOCX conversion
    HEADING_STYLE_PATTERN = re.compile(r"^(#{1,6})\s+(.+)$")  # Markdown-style
    DOCX_HEADING_PATTERN = re.compile(
        r"^\s*(Heading\s*\d+|Title):\s*(.+)$", re.IGNORECASE
    )

    def __init__(self):
        """Initialize the DOCX extractor."""
        super().__init__()
        self._docx_patterns = {
            "docx_image": self.DOCX_IMAGE_MARKER,
            "docx_chart": self.DOCX_CHART_MARKER,
            "docx_drawing": self.DOCX_DRAWING_MARKER,
            "docx_equation": self.DOCX_EQUATION_MARKER,
        }

    def extract_from_text(
        self,
        text: str,
        filename: str,
    ) -> Tuple[str, List[LineMetadata], List[Dict[str, Any]]]:
        """
        Extract text content and metadata from DOCX-converted text.

        Args:
            text: DOCX text content (already converted from binary)
            filename: Original filename for logging

        Returns:
            Tuple of (cleaned_text, line_metadata, skipped_elements)
        """
        # Detect standard non-text elements
        has_non_text, skipped_elements = self.detect_non_text_elements(text)

        # Also detect DOCX-specific markers
        docx_skipped = self._detect_docx_markers(text)
        skipped_elements.extend(docx_skipped)

        if skipped_elements:
            logger.info(
                f"Document '{filename}' has {len(skipped_elements)} non-text elements to skip"
            )
            has_non_text = True

        # Remove non-text elements
        cleaned_text = self._remove_docx_markers(self.remove_non_text_elements(text))

        # Parse line metadata
        line_metadata = self._parse_line_metadata(cleaned_text)

        return cleaned_text, line_metadata, skipped_elements

    def _detect_docx_markers(self, text: str) -> List[Dict[str, Any]]:
        """Detect DOCX-specific markers like [IMAGE], [CHART], etc."""
        from ..models.ir import SkippedElement, SkippedElementType

        skipped = []
        lines = text.split("\n")

        type_mapping = {
            "docx_image": SkippedElementType.IMAGE,
            "docx_chart": SkippedElementType.CHART,
            "docx_drawing": SkippedElementType.DRAWING,
            "docx_equation": SkippedElementType.EQUATION,
        }

        for line_num, line in enumerate(lines, start=1):
            for marker_name, pattern in self._docx_patterns.items():
                matches = pattern.finditer(line)
                for match in matches:
                    elem_type = type_mapping.get(
                        marker_name, SkippedElementType.EMBEDDED_OBJECT
                    )
                    description = match.group(1) if match.groups() else None

                    elem = SkippedElement(
                        type=elem_type,
                        location={
                            "line_start": line_num,
                            "line_end": line_num,
                            "char_start": match.start(),
                            "char_end": match.end(),
                        },
                        original_marker=match.group(0)[:200],
                        description=description,
                        metadata={"pattern": marker_name},
                    )
                    skipped.append(elem.to_dict())

        return skipped

    def _remove_docx_markers(self, text: str) -> str:
        """Remove DOCX-specific markers from text."""
        result = text
        for pattern in self._docx_patterns.values():
            result = pattern.sub("", result)

        # Clean up excessive whitespace
        result = re.sub(r"\n{3,}", "\n\n", result)
        return result.strip()

    def _parse_line_metadata(self, text: str) -> List[LineMetadata]:
        """Parse line-by-line metadata from DOCX text."""
        lines = text.split("\n")
        metadata_list: List[LineMetadata] = []

        for line_num, line in enumerate(lines, start=1):
            meta = LineMetadata(
                line_number=line_num,
                original_line=line,
            )

            stripped = line.strip()

            # Empty lines
            if not stripped:
                metadata_list.append(meta)
                continue

            # Check for Markdown-style headings
            heading_match = self.HEADING_STYLE_PATTERN.match(line)
            if heading_match:
                meta.is_heading = True
                meta.heading_level = len(heading_match.group(1))
                metadata_list.append(meta)
                continue

            # Check for DOCX-style heading markers
            docx_heading_match = self.DOCX_HEADING_PATTERN.match(line)
            if docx_heading_match:
                meta.is_heading = True
                style = docx_heading_match.group(1).lower()
                if "title" in style:
                    meta.heading_level = 1
                else:
                    # Extract number from "Heading 2" etc.
                    try:
                        level = int(re.search(r"\d+", style).group())
                        meta.heading_level = min(level, 6)
                    except (AttributeError, ValueError):
                        meta.heading_level = 2
                metadata_list.append(meta)
                continue

            # List detection
            if stripped.startswith(("-", "*", "+")):
                meta.is_list_item = True
                meta.list_type = "unordered"
            elif re.match(r"^\d+[.)]\s", stripped):
                meta.is_list_item = True
                meta.list_type = "ordered"

            meta.indent_level = self._get_indent_level(line)
            metadata_list.append(meta)

        return metadata_list

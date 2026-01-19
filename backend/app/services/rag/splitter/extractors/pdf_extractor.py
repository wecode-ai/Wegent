# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PDF text extractor with structure preservation."""

import logging
import re
from typing import Any, Dict, List, Tuple

from .base import BaseExtractor, LineMetadata

logger = logging.getLogger(__name__)


class PdfExtractor(BaseExtractor):
    """
    Extractor for PDF documents.

    Note: The actual PDF parsing is typically done before this extractor
    receives the text (e.g., by pdfminer or PyMuPDF). This extractor handles
    the pre-converted text and detects structure and non-text elements.

    Detects:
    - Page boundaries
    - Pseudo-headings (bold/larger text markers, all caps)
    - Lists and tables
    - Image/figure markers
    """

    # PDF-specific patterns (post-conversion markers)
    PAGE_MARKER = re.compile(r"^---\s*Page\s+(\d+)\s*---$", re.IGNORECASE)
    FIGURE_MARKER = re.compile(
        r"\[?(?:Figure|Fig\.?)\s*(\d+[.\d]*)?:?\s*([^\]]*)\]?", re.IGNORECASE
    )
    TABLE_MARKER = re.compile(
        r"\[?(?:Table)\s*(\d+[.\d]*)?:?\s*([^\]]*)\]?", re.IGNORECASE
    )
    IMAGE_MARKER = re.compile(r"\[IMAGE\s*([^\]]*)\]", re.IGNORECASE)

    # Heading detection heuristics for PDF
    ALL_CAPS_LINE = re.compile(r"^[A-Z][A-Z\s\d\.\-:]+$")
    NUMBERED_HEADING = re.compile(r"^(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z].*)$")
    SHORT_BOLD_LINE = re.compile(r"^(?:\*\*|__)(.+?)(?:\*\*|__)$")

    def __init__(self):
        """Initialize the PDF extractor."""
        super().__init__()
        self._pdf_patterns = {
            "pdf_figure": self.FIGURE_MARKER,
            "pdf_image": self.IMAGE_MARKER,
        }

    def extract_from_text(
        self,
        text: str,
        filename: str,
    ) -> Tuple[str, List[LineMetadata], List[Dict[str, Any]]]:
        """
        Extract text content and metadata from PDF-converted text.

        Args:
            text: PDF text content (already converted from binary)
            filename: Original filename for logging

        Returns:
            Tuple of (cleaned_text, line_metadata, skipped_elements)
        """
        # Detect standard non-text elements
        has_non_text, skipped_elements = self.detect_non_text_elements(text)

        # Also detect PDF-specific markers
        pdf_skipped = self._detect_pdf_markers(text)
        skipped_elements.extend(pdf_skipped)

        if skipped_elements:
            logger.info(
                f"Document '{filename}' has {len(skipped_elements)} non-text elements to skip"
            )
            has_non_text = True

        # Remove non-text elements
        cleaned_text = self._remove_pdf_markers(self.remove_non_text_elements(text))

        # Parse line metadata with page tracking
        line_metadata = self._parse_line_metadata(cleaned_text)

        return cleaned_text, line_metadata, skipped_elements

    def _detect_pdf_markers(self, text: str) -> List[Dict[str, Any]]:
        """Detect PDF-specific markers like [Figure], [IMAGE], etc."""
        from ..models.ir import SkippedElement, SkippedElementType

        skipped = []
        lines = text.split("\n")

        for line_num, line in enumerate(lines, start=1):
            for marker_name, pattern in self._pdf_patterns.items():
                matches = pattern.finditer(line)
                for match in matches:
                    groups = match.groups()
                    description = None
                    if len(groups) >= 2:
                        description = groups[1] if groups[1] else groups[0]
                    elif groups:
                        description = groups[0]

                    elem = SkippedElement(
                        type=SkippedElementType.IMAGE,
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

    def _remove_pdf_markers(self, text: str) -> str:
        """Remove PDF-specific markers from text."""
        result = text
        for pattern in self._pdf_patterns.values():
            result = pattern.sub("", result)

        # Keep page markers but clean up figure/image references
        # Clean up excessive whitespace
        result = re.sub(r"\n{3,}", "\n\n", result)
        return result.strip()

    def _parse_line_metadata(self, text: str) -> List[LineMetadata]:
        """Parse line-by-line metadata from PDF text with page tracking."""
        lines = text.split("\n")
        metadata_list: List[LineMetadata] = []

        current_page = 1

        for line_num, line in enumerate(lines, start=1):
            meta = LineMetadata(
                line_number=line_num,
                original_line=line,
                page_number=current_page,
            )

            stripped = line.strip()

            # Check for page markers
            page_match = self.PAGE_MARKER.match(stripped)
            if page_match:
                current_page = int(page_match.group(1))
                meta.page_number = current_page
                meta.metadata["is_page_marker"] = True
                metadata_list.append(meta)
                continue

            # Empty lines
            if not stripped:
                metadata_list.append(meta)
                continue

            # Check for ALL CAPS headings (common in PDFs)
            if self.ALL_CAPS_LINE.match(stripped) and 3 < len(stripped) < 100:
                meta.is_heading = True
                meta.heading_level = 1
                metadata_list.append(meta)
                continue

            # Check for numbered headings (e.g., "1.2 Introduction")
            numbered_match = self.NUMBERED_HEADING.match(stripped)
            if numbered_match:
                meta.is_heading = True
                number = numbered_match.group(1)
                level = number.count(".") + 1  # "1" = level 1, "1.2" = level 2
                meta.heading_level = min(level, 6)
                metadata_list.append(meta)
                continue

            # Check for bold-formatted headings
            bold_match = self.SHORT_BOLD_LINE.match(stripped)
            if bold_match and len(stripped) < 100:
                meta.is_heading = True
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
            elif re.match(r"^[a-z][.)]\s", stripped):  # a) b) c) lists
                meta.is_list_item = True
                meta.list_type = "ordered"

            # Check for table-like content (multiple columns separated by tabs/spaces)
            if "\t" in line or re.search(r"\s{3,}", line):
                parts = re.split(r"\t|\s{3,}", stripped)
                if len(parts) >= 3:
                    meta.metadata["is_table_row"] = True

            meta.indent_level = self._get_indent_level(line)
            metadata_list.append(meta)

        return metadata_list

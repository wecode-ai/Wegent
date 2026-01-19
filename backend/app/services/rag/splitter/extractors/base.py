# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base extractor class and factory for text extraction.

All extractors inherit from BaseExtractor and implement the extract_from_text method.
"""

import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Type

from ..models.ir import SkippedElement, SkippedElementType

logger = logging.getLogger(__name__)


# Non-text element patterns for detection and removal
NON_TEXT_PATTERNS = {
    # Images
    "markdown_image": r"!\[([^\]]*)\]\(([^)]+)\)",  # ![alt](url)
    "html_image": r"<img[^>]*(?:src=['\"]([^'\"]+)['\"])?[^>]*>",  # <img src="...">
    "base64_image": r"data:image/[^;]+;base64,[A-Za-z0-9+/=]+",  # base64 images
    # Video
    "html_video": r"<video[^>]*>.*?</video>",  # <video>...</video>
    # Audio
    "html_audio": r"<audio[^>]*>.*?</audio>",  # <audio>...</audio>
    # Embedded objects
    "html_object": r"<object[^>]*>.*?</object>",  # <object>...</object>
    "html_embed": r"<embed[^>]*>",  # <embed>
    "html_iframe": r"<iframe[^>]*>.*?</iframe>",  # <iframe>...</iframe>
    # SVG and drawings
    "inline_svg": r"<svg[^>]*>.*?</svg>",  # inline SVG
}

# Map pattern names to skipped element types
PATTERN_TYPE_MAP = {
    "markdown_image": SkippedElementType.IMAGE,
    "html_image": SkippedElementType.IMAGE,
    "base64_image": SkippedElementType.IMAGE,
    "html_video": SkippedElementType.VIDEO,
    "html_audio": SkippedElementType.AUDIO,
    "html_object": SkippedElementType.EMBEDDED_OBJECT,
    "html_embed": SkippedElementType.EMBEDDED_OBJECT,
    "html_iframe": SkippedElementType.EMBEDDED_OBJECT,
    "inline_svg": SkippedElementType.DRAWING,
}


@dataclass
class LineMetadata:
    """Metadata for a line of text."""

    line_number: int
    page_number: Optional[int] = None
    original_line: str = ""
    is_heading: bool = False
    heading_level: Optional[int] = None
    is_code_block: bool = False
    code_language: Optional[str] = None
    is_list_item: bool = False
    list_type: Optional[str] = None  # "ordered" or "unordered"
    indent_level: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


class BaseExtractor(ABC):
    """
    Abstract base class for text extractors.

    Extractors are responsible for:
    1. Extracting text content from documents
    2. Detecting and recording non-text elements (images, videos, etc.)
    3. Providing line-level metadata for structure recognition
    """

    def __init__(self):
        """Initialize the extractor."""
        self._compiled_patterns: Dict[str, re.Pattern] = {}
        self._compile_patterns()

    def _compile_patterns(self) -> None:
        """Pre-compile regex patterns for efficiency."""
        for name, pattern in NON_TEXT_PATTERNS.items():
            try:
                self._compiled_patterns[name] = re.compile(
                    pattern, re.DOTALL | re.IGNORECASE
                )
            except re.error as e:
                logger.warning(f"Failed to compile pattern '{name}': {e}")

    @abstractmethod
    def extract_from_text(
        self,
        text: str,
        filename: str,
    ) -> Tuple[str, List[LineMetadata], List[Dict[str, Any]]]:
        """
        Extract text content and metadata from document text.

        Args:
            text: Raw document text content
            filename: Original filename for logging

        Returns:
            Tuple of:
            - Cleaned text with non-text elements removed
            - List of LineMetadata for each line
            - List of skipped element dictionaries
        """
        pass

    def detect_non_text_elements(
        self,
        text: str,
    ) -> Tuple[bool, List[Dict[str, Any]]]:
        """
        Detect non-text elements in text.

        Args:
            text: Text to scan for non-text elements

        Returns:
            Tuple of (has_non_text, list of skipped element dicts)
        """
        skipped_elements = []
        lines = text.split("\n")

        for line_num, line in enumerate(lines, start=1):
            for pattern_name, pattern in self._compiled_patterns.items():
                matches = pattern.finditer(line)
                for match in matches:
                    element_type = PATTERN_TYPE_MAP.get(
                        pattern_name, SkippedElementType.EMBEDDED_OBJECT
                    )

                    # Extract description if available
                    description = None
                    if pattern_name == "markdown_image":
                        groups = match.groups()
                        if groups and groups[0]:
                            description = groups[0]
                    elif pattern_name == "html_image":
                        groups = match.groups()
                        if groups and groups[0]:
                            description = groups[0]

                    skipped = SkippedElement(
                        type=element_type,
                        location={
                            "line_start": line_num,
                            "line_end": line_num,
                            "char_start": match.start(),
                            "char_end": match.end(),
                        },
                        original_marker=match.group(0)[:200],  # Limit length
                        description=description,
                        metadata={"pattern": pattern_name},
                    )
                    skipped_elements.append(skipped.to_dict())

        return len(skipped_elements) > 0, skipped_elements

    def remove_non_text_elements(self, text: str) -> str:
        """
        Remove non-text elements from text.

        Args:
            text: Text containing non-text elements

        Returns:
            Cleaned text with non-text elements removed
        """
        result = text

        for pattern_name, pattern in self._compiled_patterns.items():
            result = pattern.sub("", result)

        # Clean up excessive whitespace
        result = re.sub(r"\n{3,}", "\n\n", result)
        result = re.sub(r"[ \t]+\n", "\n", result)  # Trailing whitespace

        return result.strip()

    def _get_indent_level(self, line: str) -> int:
        """Calculate indentation level of a line."""
        stripped = line.lstrip()
        if not stripped:
            return 0
        indent_chars = len(line) - len(stripped)
        # Consider 2-4 spaces or 1 tab as one indent level
        return indent_chars // 2


class ExtractorFactory:
    """Factory for creating document extractors based on file type."""

    _extractors: Dict[str, Type[BaseExtractor]] = {}

    @classmethod
    def register(cls, file_type: str, extractor_class: Type[BaseExtractor]) -> None:
        """Register an extractor for a file type."""
        cls._extractors[file_type.lower()] = extractor_class

    @classmethod
    def get_extractor(cls, file_type: str) -> BaseExtractor:
        """
        Get an extractor for the specified file type.

        Args:
            file_type: File extension or type (e.g., "md", "pdf", "docx")

        Returns:
            Appropriate extractor instance
        """
        # Normalize file type
        file_type = file_type.lower().lstrip(".")

        # Map file types to extractors
        type_mapping = {
            "md": "markdown",
            "markdown": "markdown",
            "txt": "txt",
            "text": "txt",
            "pdf": "pdf",
            "docx": "docx",
            "doc": "docx",
        }

        normalized_type = type_mapping.get(file_type, "txt")

        if normalized_type not in cls._extractors:
            # Import and register extractors on first use
            cls._register_default_extractors()

        extractor_class = cls._extractors.get(normalized_type)
        if extractor_class:
            return extractor_class()

        # Fallback to TxtExtractor
        logger.warning(
            f"No extractor found for file type '{file_type}', using TxtExtractor"
        )
        return cls._extractors.get("txt", TxtExtractor)()

    @classmethod
    def _register_default_extractors(cls) -> None:
        """Register default extractors."""
        from .docx_extractor import DocxExtractor
        from .markdown_extractor import MarkdownExtractor
        from .pdf_extractor import PdfExtractor
        from .txt_extractor import TxtExtractor

        cls._extractors["markdown"] = MarkdownExtractor
        cls._extractors["txt"] = TxtExtractor
        cls._extractors["pdf"] = PdfExtractor
        cls._extractors["docx"] = DocxExtractor


# Placeholder for TxtExtractor import to avoid circular imports
try:
    from .txt_extractor import TxtExtractor
except ImportError:
    TxtExtractor = None  # type: ignore

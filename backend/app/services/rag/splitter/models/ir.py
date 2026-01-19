# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Intermediate Representation (IR) data structures for document processing.

This module defines the data models used throughout the six-phase
document splitting pipeline.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class BlockType(str, Enum):
    """Structure block types for document elements."""

    HEADING = "heading"
    PARAGRAPH = "paragraph"
    CODE = "code"
    TABLE = "table"
    FLOW = "flow"
    LIST = "list"
    QA = "qa"
    BLOCKQUOTE = "blockquote"
    DEFINITION = "definition"
    UNKNOWN = "unknown"


class SkippedElementType(str, Enum):
    """Types of skipped non-text elements."""

    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    EMBEDDED_OBJECT = "embedded_object"
    DRAWING = "drawing"
    CHART = "chart"
    EQUATION = "equation"


@dataclass
class SkippedElement:
    """Record of a skipped non-text element."""

    type: SkippedElementType
    location: Dict[str, Any]
    original_marker: str
    description: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": (
                self.type.value
                if isinstance(self.type, SkippedElementType)
                else self.type
            ),
            "location": self.location,
            "original_marker": self.original_marker,
            "description": self.description,
            "metadata": self.metadata,
        }


@dataclass
class StructureBlock:
    """
    Single structure block in IR (intermediate representation).

    Used internally during document processing.
    """

    type: BlockType
    content: str
    level: Optional[int] = None  # Heading level (1-6)
    line_start: int = 0
    line_end: int = 0
    page_number: Optional[int] = None
    language: Optional[str] = None  # Code block language
    headers: Optional[List[str]] = None  # Table headers
    rows: Optional[List[List[str]]] = None  # Table rows
    list_type: Optional[str] = None  # "ordered" or "unordered"
    items: Optional[List[str]] = None  # List items
    question: Optional[str] = None  # QA question
    answer: Optional[str] = None  # QA answer
    parent_headings: Optional[List[str]] = None  # Parent heading hierarchy
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for debugging/logging."""
        result = {
            "type": self.type.value if isinstance(self.type, BlockType) else self.type,
            "content": (
                self.content[:100] + "..." if len(self.content) > 100 else self.content
            ),
            "line_start": self.line_start,
            "line_end": self.line_end,
        }
        if self.level is not None:
            result["level"] = self.level
        if self.page_number is not None:
            result["page_number"] = self.page_number
        if self.language:
            result["language"] = self.language
        if self.parent_headings:
            result["parent_headings"] = self.parent_headings
        return result


@dataclass
class DocumentIR:
    """
    Intermediate Representation of a document.

    Used internally to pass structured data between pipeline phases.
    """

    blocks: List[StructureBlock]
    source_file: str
    file_type: str
    file_size: int
    total_lines: int
    total_pages: Optional[int] = None
    skipped_elements: List[SkippedElement] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ChunkItem:
    """
    Represents a single chunk of document content.

    This structure is backward-compatible with the existing ChunkItem schema.
    New fields have default values to ensure compatibility with existing data.
    """

    # === Required fields (backward compatible) ===
    chunk_index: int
    content: str
    token_count: int
    start_position: int
    end_position: int
    forced_split: bool = False

    # === New extended fields (optional, with defaults) ===
    chunk_type: Optional[str] = (
        None  # Block type: heading/paragraph/code/table/flow/list/qa
    )
    title_path: Optional[List[str]] = (
        None  # Heading hierarchy path: ["Section", "Subsection"]
    )
    page_number: Optional[int] = None  # Page number (for PDF)
    line_start: Optional[int] = None  # Start line number
    line_end: Optional[int] = None  # End line number
    is_merged: bool = False  # Whether merged from smaller chunks
    is_split: bool = False  # Whether split from larger chunk
    split_index: Optional[int] = None  # Split index if this is a split chunk
    notes: Optional[str] = None  # Processing notes
    metadata: Dict[str, Any] = field(default_factory=dict)  # Additional metadata


@dataclass
class DocumentChunks:
    """
    Container for document chunks and metadata.

    This structure is backward-compatible with the existing DocumentChunks schema.
    New fields have default values to ensure compatibility with existing data.
    """

    # === Required fields (backward compatible) ===
    chunks: List[ChunkItem] = field(default_factory=list)
    total_chunks: int = 0
    overlap_tokens: int = 80
    has_non_text_content: bool = False
    skipped_elements: List[str] = field(
        default_factory=list
    )  # Keep as list[str] for compatibility

    # === New extended fields (optional) ===
    skipped_elements_detail: List[Dict[str, Any]] = field(
        default_factory=list
    )  # Detailed skipped elements
    processing_stats: Dict[str, Any] = field(
        default_factory=dict
    )  # Processing statistics

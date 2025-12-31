# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document Block data models.

This module defines the data structures for document blocks used
during parsing and before database persistence.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional


class BlockType(str, Enum):
    """Enumeration of supported block types."""

    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST = "list"
    CODE = "code"
    TABLE = "table"
    IMAGE = "image"
    AI_SUMMARY = "ai_summary"
    UNSUPPORTED = "unsupported"


@dataclass
class DocumentBlockData:
    """
    Data class representing a parsed document block.

    This is the intermediate representation used during parsing,
    before the block is persisted to the database.
    """

    document_id: str
    block_type: BlockType
    order_index: int
    content: Optional[str] = None
    editable: bool = False
    source_ref: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert block data to dictionary for database insertion.

        Returns:
            Dictionary representation of the block
        """
        return {
            "id": self.id,
            "document_id": self.document_id,
            "block_type": self.block_type.value
            if isinstance(self.block_type, BlockType)
            else self.block_type,
            "content": self.content,
            "editable": self.editable,
            "order_index": self.order_index,
            "source_ref": self.source_ref,
            "metadata": self.metadata,
        }


@dataclass
class ParseResult:
    """
    Result of a document parsing operation.

    Contains the parsed blocks and any metadata about the parsing process.
    """

    document_id: str
    blocks: list = field(default_factory=list)
    success: bool = True
    error_message: Optional[str] = None
    parse_time_ms: Optional[int] = None
    total_blocks: int = 0

    def __post_init__(self):
        """Update total_blocks after initialization."""
        self.total_blocks = len(self.blocks)

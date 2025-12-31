# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document Block Pydantic schemas.

Defines request/response schemas for the document parsing API.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class BlockTypeEnum(str, Enum):
    """Enumeration of supported block types."""

    HEADING = "heading"
    PARAGRAPH = "paragraph"
    LIST = "list"
    CODE = "code"
    TABLE = "table"
    IMAGE = "image"
    AI_SUMMARY = "ai_summary"
    UNSUPPORTED = "unsupported"


class SourceTypeEnum(str, Enum):
    """Enumeration of document source types."""

    MARKDOWN = "markdown"
    PDF = "pdf"
    DOCX = "docx"
    IMAGE = "image"
    GIT = "git"
    AI = "ai"


class DocumentBlockBase(BaseModel):
    """Base schema for document blocks."""

    source_type: SourceTypeEnum = Field(
        SourceTypeEnum.MARKDOWN, description="Source type: markdown, pdf, docx, image, git, ai"
    )
    block_type: BlockTypeEnum = Field(..., description="Type of the block")
    content: Optional[str] = Field(None, description="Text content or description")
    editable: bool = Field(False, description="Whether the block can be edited")
    order_index: int = Field(..., description="Order within the document")
    source_ref: Optional[Dict[str, Any]] = Field(
        None, description="Source reference (page, line, etc.)"
    )
    metadata: Optional[Dict[str, Any]] = Field(
        None, description="Additional metadata (image_url, lang, level, etc.)"
    )


class DocumentBlockCreate(DocumentBlockBase):
    """Schema for creating a document block."""

    document_id: str = Field(..., description="ID of the parent document")


class DocumentBlockResponse(DocumentBlockBase):
    """Schema for document block response."""

    id: str = Field(..., description="Block ID")
    document_id: str = Field(..., description="ID of the parent document")
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: datetime = Field(..., description="Last update timestamp")

    class Config:
        from_attributes = True


class DocumentBlockUpdate(BaseModel):
    """Schema for updating a document block."""

    content: str = Field(..., description="New content for the block")


class DocumentBlockListResponse(BaseModel):
    """Schema for list of document blocks response."""

    document_id: str = Field(..., description="Document ID")
    total: int = Field(..., description="Total number of blocks")
    blocks: List[DocumentBlockResponse] = Field(..., description="List of blocks")


class ParseDocumentRequest(BaseModel):
    """Schema for triggering document parsing."""

    document_id: str = Field(..., description="ID of the document to parse")
    force: bool = Field(
        False, description="Force re-parsing even if blocks already exist"
    )


class ParseDocumentResponse(BaseModel):
    """Schema for parse document response."""

    document_id: str = Field(..., description="Document ID")
    status: str = Field(..., description="Parsing status (queued, completed, failed)")
    message: Optional[str] = Field(None, description="Status message or error")
    total_blocks: int = Field(0, description="Number of blocks created")


class SupportedFormatsResponse(BaseModel):
    """Schema for supported formats response."""

    content_types: List[str] = Field(..., description="Supported MIME types")
    extensions: List[str] = Field(..., description="Supported file extensions")

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask context schemas for API responses and request validation.

Provides schemas for the unified context system that supports
attachments, knowledge bases, and other context types.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ContextType(str, Enum):
    """Context type enumeration."""

    ATTACHMENT = "attachment"
    KNOWLEDGE_BASE = "knowledge_base"
    TABLE = "table"
    SELECTED_DOCUMENTS = "selected_documents"
    GENERATED_PPTX = "generated_pptx"


class ContextStatus(str, Enum):
    """Context processing status."""

    PENDING = "pending"
    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"


# ============================================================
# Truncation Info (shared with attachment responses)
# ============================================================


class TruncationInfo(BaseModel):
    """Information about content truncation."""

    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None
    truncation_message_key: Optional[str] = None  # i18n key for frontend


# ============================================================
# Full Response Schema
# ============================================================


class SubtaskContextResponse(BaseModel):
    """Full context response schema."""

    id: int
    subtask_id: int
    user_id: int
    context_type: ContextType
    name: str
    status: ContextStatus
    error_message: Optional[str] = None
    text_length: int = 0
    type_data: Dict[str, Any] = {}
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ============================================================
# Brief Schema for Message Display
# ============================================================


class SubtaskContextBrief(BaseModel):
    """Brief context info for message list display."""

    id: int
    context_type: ContextType
    name: str
    status: ContextStatus
    # Attachment fields (from type_data)
    file_extension: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    # Knowledge base fields (from type_data)
    document_count: Optional[int] = None
    # Table fields (from type_data) - nested structure to match frontend expectation
    source_config: Optional[Dict[str, Any]] = None
    # Generated PPTX fields (from type_data)
    slide_count: Optional[int] = None
    preview_images: Optional[List[int]] = None  # List of attachment IDs for preview thumbnails
    pptx_attachment_id: Optional[int] = None  # ID of the PPTX file attachment

    class Config:
        from_attributes = True

    @classmethod
    def from_model(cls, context) -> "SubtaskContextBrief":
        """Create brief from SubtaskContext model."""
        type_data = context.type_data or {}

        # Build source_config for table contexts
        source_config = None
        document_count = type_data.get("document_count")

        # Handle context type as string or enum
        context_type = context.context_type
        if hasattr(context_type, "value"):
            context_type_str = context_type.value
        else:
            context_type_str = str(context_type)

        # Handle PPTX-specific fields
        slide_count = None
        preview_images = None
        pptx_attachment_id = None

        if context_type_str == ContextType.TABLE.value:
            url = type_data.get("url")
            if url:
                source_config = {"url": url}
                # DEBUG: Log table context creation
                import logging

                logger = logging.getLogger(__name__)
                logger.info(
                    f"[SubtaskContextBrief] Building table context: id={context.id}, "
                    f"url={url}, source_config={source_config}"
                )
        elif context_type_str == ContextType.SELECTED_DOCUMENTS.value:
            # For selected_documents, count the document_ids
            document_ids = type_data.get("document_ids", [])
            document_count = len(document_ids) if document_ids else 0
        elif context_type_str == ContextType.GENERATED_PPTX.value:
            # For generated PPTX, include slide count and preview images
            slide_count = type_data.get("slide_count")
            preview_images = type_data.get("preview_images", [])
            pptx_attachment_id = type_data.get("pptx_attachment_id")

        return cls(
            id=context.id,
            context_type=context.context_type,
            name=context.name,
            status=context.status,
            file_extension=type_data.get("file_extension"),
            file_size=type_data.get("file_size"),
            mime_type=type_data.get("mime_type"),
            document_count=document_count,
            source_config=source_config,
            slide_count=slide_count,
            preview_images=preview_images,
            pptx_attachment_id=pptx_attachment_id,
        )


# ============================================================
# Attachment Response (backward compatible)
# ============================================================


class AttachmentResponse(BaseModel):
    """Attachment upload/query response (backward compatible)."""

    id: int
    filename: str
    file_size: int
    mime_type: str
    status: str
    file_extension: str = ""
    text_length: Optional[int] = None
    error_message: Optional[str] = None
    error_code: Optional[str] = None  # Error code for i18n mapping
    truncation_info: Optional[TruncationInfo] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_context(
        cls,
        context,
        truncation_info: Optional[TruncationInfo] = None,
    ) -> "AttachmentResponse":
        """Create from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            filename=type_data.get("original_filename", context.name),
            file_size=type_data.get("file_size", 0),
            mime_type=type_data.get("mime_type", ""),
            status=(
                context.status
                if isinstance(context.status, str)
                else context.status.value
            ),
            file_extension=type_data.get("file_extension", ""),
            text_length=context.text_length,
            error_message=context.error_message,
            truncation_info=truncation_info,
            created_at=context.created_at,
        )


class AttachmentDetailResponse(AttachmentResponse):
    """Detailed attachment response including subtask_id."""

    subtask_id: Optional[int] = None

    @classmethod
    def from_context(
        cls,
        context,
        truncation_info: Optional[TruncationInfo] = None,
    ) -> "AttachmentDetailResponse":
        """Create from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            filename=type_data.get("original_filename", context.name),
            file_size=type_data.get("file_size", 0),
            mime_type=type_data.get("mime_type", ""),
            status=(
                context.status
                if isinstance(context.status, str)
                else context.status.value
            ),
            file_extension=type_data.get("file_extension", ""),
            text_length=context.text_length,
            error_message=context.error_message,
            truncation_info=truncation_info,
            created_at=context.created_at,
            subtask_id=context.subtask_id if context.subtask_id > 0 else None,
        )


# ============================================================
# Create Schemas
# ============================================================


class AttachmentContextCreate(BaseModel):
    """Data for creating attachment context (internal use)."""

    original_filename: str
    file_extension: str
    file_size: int
    mime_type: str
    storage_backend: str = "mysql"
    storage_key: Optional[str] = None


class KnowledgeBaseContextCreate(BaseModel):
    """Data for creating knowledge base context."""

    knowledge_id: int
    name: str
    document_count: Optional[int] = None


class TableContextCreate(BaseModel):
    """Data for creating table context."""

    document_id: int
    name: str
    url: Optional[str] = None


# ============================================================
# Generated PPTX Schemas
# ============================================================


class GeneratedPPTXContextCreate(BaseModel):
    """Data for creating generated PPTX context."""

    name: str  # Presentation title
    slide_count: int
    pptx_attachment_id: int  # ID of the PPTX file attachment
    preview_images: List[int] = Field(default_factory=list)  # IDs of thumbnail attachments


class GeneratedPPTXResponse(BaseModel):
    """Response for generated PPTX."""

    id: int
    name: str
    status: str
    slide_count: int
    pptx_attachment_id: int  # ID for downloading the PPTX
    preview_images: List[int] = Field(default_factory=list)  # IDs for preview thumbnails
    file_size: Optional[int] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_context(cls, context) -> "GeneratedPPTXResponse":
        """Create from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            name=context.name,
            status=(
                context.status
                if isinstance(context.status, str)
                else context.status.value
            ),
            slide_count=type_data.get("slide_count", 0),
            pptx_attachment_id=type_data.get("pptx_attachment_id", 0),
            preview_images=type_data.get("preview_images", []),
            file_size=type_data.get("file_size"),
            created_at=context.created_at,
        )

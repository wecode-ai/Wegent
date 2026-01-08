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

    class Config:
        from_attributes = True

    @classmethod
    def from_model(cls, context) -> "SubtaskContextBrief":
        """Create brief from SubtaskContext model."""
        type_data = context.type_data or {}

        # Build source_config for table contexts
        source_config = None
        if context.context_type == ContextType.TABLE:
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

        return cls(
            id=context.id,
            context_type=context.context_type,
            name=context.name,
            status=context.status,
            file_extension=type_data.get("file_extension"),
            file_size=type_data.get("file_size"),
            mime_type=type_data.get("mime_type"),
            document_count=type_data.get("document_count"),
            source_config=source_config,
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

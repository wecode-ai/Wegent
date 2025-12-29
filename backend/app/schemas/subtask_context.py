# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subtask context schemas for API responses and request validation.

Provides unified schemas for context operations including attachments,
knowledge base references, and other extensible context types.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ContextType(str, Enum):
    """Context type discriminator."""

    ATTACHMENT = "attachment"
    KNOWLEDGE_BASE = "knowledge_base"


class ContextStatus(str, Enum):
    """Context processing status."""

    PENDING = "pending"
    UPLOADING = "uploading"
    PARSING = "parsing"
    READY = "ready"
    FAILED = "failed"


# === Full Response Schema ===


class SubtaskContextResponse(BaseModel):
    """Full context response with all fields."""

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


# === Brief Schema for Message Display ===


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

    class Config:
        from_attributes = True

    @classmethod
    def from_model(cls, context) -> "SubtaskContextBrief":
        """Create brief from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            context_type=context.context_type,
            name=context.name,
            status=context.status,
            file_extension=type_data.get("file_extension"),
            file_size=type_data.get("file_size"),
            mime_type=type_data.get("mime_type"),
            document_count=type_data.get("document_count"),
        )


# === Truncation Info ===


class TruncationInfo(BaseModel):
    """Information about content truncation."""

    is_truncated: bool = False
    original_length: Optional[int] = None
    truncated_length: Optional[int] = None
    truncation_message_key: Optional[str] = None  # i18n key for frontend


# === Attachment Response (backward compatible) ===


class AttachmentResponse(BaseModel):
    """Attachment upload/query response - backward compatible with old API."""

    id: int
    filename: str
    file_size: int
    mime_type: str
    status: str
    file_extension: str
    text_length: Optional[int] = None
    error_message: Optional[str] = None
    error_code: Optional[str] = None  # Error code for i18n mapping
    truncation_info: Optional[TruncationInfo] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_context(
        cls, context, truncation_info: Optional[TruncationInfo] = None
    ) -> "AttachmentResponse":
        """Create AttachmentResponse from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            filename=type_data.get("original_filename", context.name),
            file_size=type_data.get("file_size", 0),
            mime_type=type_data.get("mime_type", ""),
            status=context.status,
            file_extension=type_data.get("file_extension", ""),
            text_length=context.text_length,
            error_message=context.error_message,
            truncation_info=truncation_info,
        )


class AttachmentDetailResponse(AttachmentResponse):
    """Detailed response model including subtask_id."""

    subtask_id: Optional[int] = None
    created_at: Optional[str] = None

    @classmethod
    def from_context(
        cls, context, truncation_info: Optional[TruncationInfo] = None
    ) -> "AttachmentDetailResponse":
        """Create AttachmentDetailResponse from SubtaskContext model."""
        type_data = context.type_data or {}
        return cls(
            id=context.id,
            filename=type_data.get("original_filename", context.name),
            file_size=type_data.get("file_size", 0),
            mime_type=type_data.get("mime_type", ""),
            status=context.status,
            file_extension=type_data.get("file_extension", ""),
            text_length=context.text_length,
            error_message=context.error_message,
            truncation_info=truncation_info,
            subtask_id=context.subtask_id if context.subtask_id != 0 else None,
            created_at=context.created_at.isoformat() if context.created_at else None,
        )


# === Create Schemas ===


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
    retriever_name: Optional[str] = None
    retriever_namespace: Optional[str] = None


# === List Response ===


class SubtaskContextListResponse(BaseModel):
    """List of contexts for a subtask."""

    contexts: List[SubtaskContextBrief]
    total: int

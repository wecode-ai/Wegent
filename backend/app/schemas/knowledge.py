# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base and document management.
"""

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class DocumentStatus(str, Enum):
    """Document status enumeration."""

    ENABLED = "enabled"
    DISABLED = "disabled"


class ResourceScope(str, Enum):
    """Resource scope for filtering."""

    PERSONAL = "personal"
    GROUP = "group"
    ALL = "all"


# ============== Knowledge Base Schemas ==============


class KnowledgeBaseCreate(BaseModel):
    """Schema for creating a knowledge base."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    namespace: str = Field(default="default", max_length=255)


class KnowledgeBaseUpdate(BaseModel):
    """Schema for updating a knowledge base."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)


class KnowledgeBaseResponse(BaseModel):
    """Schema for knowledge base response."""

    id: int
    name: str
    description: Optional[str] = None
    user_id: int
    namespace: str
    document_count: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_kind(cls, kind):
        """Create response from Kind object"""
        spec = kind.json.get("spec", {})
        return cls(
            id=kind.id,
            name=spec.get("name", ""),
            description=spec.get("description"),
            user_id=kind.user_id,
            namespace=kind.namespace,
            document_count=spec.get("document_count", 0),
            is_active=kind.is_active,
            created_at=kind.created_at,
            updated_at=kind.updated_at,
        )

    class Config:
        from_attributes = True


class KnowledgeBaseListResponse(BaseModel):
    """Schema for knowledge base list response."""

    total: int
    items: list[KnowledgeBaseResponse]


# ============== Knowledge Document Schemas ==============


class KnowledgeDocumentCreate(BaseModel):
    """Schema for creating a knowledge document."""

    attachment_id: int = Field(..., description="ID of the uploaded attachment")
    name: str = Field(..., min_length=1, max_length=255)
    file_extension: str = Field(..., max_length=50)
    file_size: int = Field(..., ge=0)


class KnowledgeDocumentUpdate(BaseModel):
    """Schema for updating a knowledge document."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[DocumentStatus] = None


class KnowledgeDocumentResponse(BaseModel):
    """Schema for knowledge document response."""

    id: int
    kind_id: int
    attachment_id: Optional[int] = None
    name: str
    file_extension: str
    file_size: int
    status: DocumentStatus
    user_id: int
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class KnowledgeDocumentListResponse(BaseModel):
    """Schema for knowledge document list response."""

    total: int
    items: list[KnowledgeDocumentResponse]


# ============== Batch Operation Schemas ==============


class BatchDocumentIds(BaseModel):
    """Schema for batch document operation request."""

    document_ids: list[int] = Field(..., min_length=1, description="List of document IDs to operate on")


class BatchOperationResult(BaseModel):
    """Schema for batch operation result."""

    success_count: int = Field(..., description="Number of successfully processed documents")
    failed_count: int = Field(..., description="Number of failed documents")
    failed_ids: list[int] = Field(default_factory=list, description="List of failed document IDs")
    message: str = Field(..., description="Operation result message")


# ============== Accessible Knowledge Schemas ==============


class AccessibleKnowledgeBase(BaseModel):
    """Schema for accessible knowledge base info."""

    id: int
    name: str
    description: Optional[str] = None
    document_count: int
    updated_at: datetime


class TeamKnowledgeGroup(BaseModel):
    """Schema for team knowledge group."""

    group_name: str
    group_display_name: Optional[str] = None
    knowledge_bases: list[AccessibleKnowledgeBase]


class AccessibleKnowledgeResponse(BaseModel):
    """Schema for all accessible knowledge bases response."""

    personal: list[AccessibleKnowledgeBase]
    team: list[TeamKnowledgeGroup]

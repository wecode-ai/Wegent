# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base and document management.
"""

from datetime import datetime
from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Import shared types from kind.py to avoid duplication
from app.schemas.kind import (
    EmbeddingModelRef,
    HybridWeights,
    RetrievalConfig,
    RetrieverRef,
)

# Import SplitterConfig from rag.py to use unified splitter configuration
from app.schemas.rag import SplitterConfig


class DocumentStatus(str, Enum):
    """Document status enumeration."""

    ENABLED = "enabled"
    DISABLED = "disabled"


class DocumentSourceType(str, Enum):
    """Document source type enumeration."""

    FILE = "file"
    TEXT = "text"
    TABLE = "table"


class ResourceScope(str, Enum):
    """Resource scope for filtering."""

    PERSONAL = "personal"
    GROUP = "group"
    ALL = "all"


# ============== Knowledge Base Schemas ==============
# Note: RetrieverRef, EmbeddingModelRef, HybridWeights, RetrievalConfig
# are imported from app.schemas.kind to maintain single source of truth


class KnowledgeBaseCreate(BaseModel):
    """Schema for creating a knowledge base."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    namespace: str = Field(default="default", max_length=255)
    retrieval_config: Optional[RetrievalConfig] = Field(
        None, description="Retrieval configuration"
    )


class RetrievalConfigUpdate(BaseModel):
    """Schema for updating retrieval configuration (excluding retriever and embedding model)."""

    retrieval_mode: Optional[str] = Field(
        None, description="Retrieval mode: 'vector', 'keyword', or 'hybrid'"
    )
    top_k: Optional[int] = Field(
        None, ge=1, le=10, description="Number of results to return"
    )
    score_threshold: Optional[float] = Field(
        None, ge=0.0, le=1.0, description="Minimum score threshold"
    )
    hybrid_weights: Optional[HybridWeights] = Field(
        None, description="Hybrid search weights"
    )


class KnowledgeBaseUpdate(BaseModel):
    """Schema for updating a knowledge base."""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    retrieval_config: Optional[RetrievalConfigUpdate] = Field(
        None,
        description="Retrieval configuration update (excludes retriever and embedding model)",
    )


class KnowledgeBaseResponse(BaseModel):
    """Schema for knowledge base response."""

    id: int
    name: str
    description: Optional[str] = None
    user_id: int
    namespace: str
    document_count: int
    is_active: bool
    retrieval_config: Optional[RetrievalConfig] = Field(
        None, description="Retrieval configuration"
    )
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_kind(cls, kind, document_count: int = 0):
        """Create response from Kind object

        Args:
            kind: Kind object
            document_count: Document count (should be queried from database)
        """
        spec = kind.json.get("spec", {})
        return cls(
            id=kind.id,
            name=spec.get("name", ""),
            description=spec.get("description"),
            user_id=kind.user_id,
            namespace=kind.namespace,
            document_count=document_count,
            retrieval_config=spec.get("retrievalConfig"),
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
# Note: SplitterConfig is imported from app.schemas.rag to use unified splitter configuration


class KnowledgeDocumentCreate(BaseModel):
    """Schema for creating a knowledge document."""

    attachment_id: Optional[int] = Field(
        None,
        description="ID of the uploaded attachment (required for file/text source)",
    )
    name: str = Field(..., min_length=1, max_length=255)
    file_extension: str = Field(..., max_length=50)
    file_size: int = Field(default=0, ge=0)
    splitter_config: Optional[SplitterConfig] = None
    source_type: DocumentSourceType = Field(default=DocumentSourceType.FILE)
    source_config: dict = Field(
        default_factory=dict,
        description="Source configuration (e.g., {'url': '...'} for table)",
    )


class KnowledgeDocumentUpdate(BaseModel):
    """Schema for updating a knowledge document."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[DocumentStatus] = None
    splitter_config: Optional[SplitterConfig] = Field(
        None, description="Splitter configuration for document chunking"
    )


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
    splitter_config: Optional[SplitterConfig] = None
    source_type: DocumentSourceType = DocumentSourceType.FILE
    source_config: Optional[dict] = None
    doc_ref: Optional[str] = Field(
        None, description="RAG storage document reference ID"
    )
    created_at: datetime
    updated_at: datetime

    @field_validator("source_config", mode="before")
    @classmethod
    def ensure_source_config_dict(cls, v):
        """Convert None to empty dict for backward compatibility."""
        if v is None:
            return {}
        return v

    class Config:
        from_attributes = True


class KnowledgeDocumentListResponse(BaseModel):
    """Schema for knowledge document list response."""

    total: int
    items: list[KnowledgeDocumentResponse]


# ============== Batch Operation Schemas ==============


class BatchDocumentIds(BaseModel):
    """Schema for batch document operation request."""

    document_ids: list[int] = Field(
        ..., min_length=1, description="List of document IDs to operate on"
    )


class BatchOperationResult(BaseModel):
    """Schema for batch operation result."""

    success_count: int = Field(
        ..., description="Number of successfully processed documents"
    )
    failed_count: int = Field(..., description="Number of failed documents")
    failed_ids: list[int] = Field(
        default_factory=list, description="List of failed document IDs"
    )
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


# ============== Table URL Validation Schemas ==============


class TableUrlValidationRequest(BaseModel):
    """Schema for table URL validation request."""

    url: str = Field(..., min_length=1, description="The table URL to validate")


class TableUrlValidationResponse(BaseModel):
    """Schema for table URL validation response."""

    valid: bool = Field(..., description="Whether the URL is valid")
    provider: Optional[str] = Field(
        None, description="Detected table provider (e.g., 'dingtalk')"
    )
    base_id: Optional[str] = Field(None, description="Extracted base ID from URL")
    sheet_id: Optional[str] = Field(None, description="Extracted sheet ID from URL")
    error_code: Optional[str] = Field(
        None, description="Error code if validation failed"
    )
    error_message: Optional[str] = Field(
        None, description="Error message if validation failed"
    )


# ============== Document Summary Schemas ==============


class DocumentSummaryMetaInfo(BaseModel):
    """Metadata extracted from document during summarization."""

    author: Optional[str] = Field(None, description="Document author if available")
    source: Optional[str] = Field(None, description="Document source if available")
    type: Optional[str] = Field(None, description="Document type classification")

    class Config:
        extra = "allow"


class DocumentSummary(BaseModel):
    """Summary information for a knowledge document."""

    short_summary: Optional[str] = Field(
        None, max_length=200, description="Short summary (30-50 characters)"
    )
    long_summary: Optional[str] = Field(
        None, max_length=2000, description="Long summary (up to 500 characters)"
    )
    topics: Optional[List[str]] = Field(
        None, max_length=10, description="Key topics/tags extracted from document"
    )
    meta_info: Optional[DocumentSummaryMetaInfo] = Field(
        None, description="Metadata extracted from document"
    )
    status: Literal["pending", "generating", "completed", "failed"] = Field(
        "pending", description="Summary generation status"
    )
    error: Optional[str] = Field(
        None, description="Error message if summary generation failed"
    )
    updated_at: Optional[datetime] = Field(
        None, description="Last summary update timestamp"
    )

    class Config:
        extra = "allow"


class DocumentSummaryResponse(BaseModel):
    """Response schema for document summary endpoint."""

    document_id: int
    summary: Optional[DocumentSummary] = None


class DocumentSummaryRefreshRequest(BaseModel):
    """Request schema for refreshing document summary."""

    force: bool = Field(
        False, description="Force refresh even if summary already exists"
    )


# ============== Knowledge Base Summary Schemas ==============


class KnowledgeBaseSummaryMetaInfo(BaseModel):
    """Metadata for knowledge base summary."""

    document_count: Optional[int] = Field(
        None, description="Number of documents when summary was generated"
    )
    last_updated: Optional[datetime] = Field(None, description="Last update timestamp")

    class Config:
        extra = "allow"


class KnowledgeBaseSummary(BaseModel):
    """Summary information for a knowledge base."""

    short_summary: Optional[str] = Field(
        None, max_length=200, description="Short summary (30-50 characters)"
    )
    long_summary: Optional[str] = Field(
        None, max_length=2000, description="Long summary (up to 500 characters)"
    )
    topics: Optional[List[str]] = Field(
        None, max_length=20, description="Key topics across all documents"
    )
    meta_info: Optional[KnowledgeBaseSummaryMetaInfo] = Field(
        None, description="Summary metadata"
    )
    status: Literal["pending", "generating", "completed", "failed"] = Field(
        "pending", description="Summary generation status"
    )
    error: Optional[str] = Field(
        None, description="Error message if summary generation failed"
    )
    updated_at: Optional[datetime] = Field(
        None, description="Last summary update timestamp"
    )
    last_summary_doc_count: Optional[int] = Field(
        None, description="Document count when summary was last generated"
    )

    class Config:
        extra = "allow"


class KnowledgeBaseSummaryResponse(BaseModel):
    """Response schema for knowledge base summary endpoint."""

    knowledge_base_id: int
    summary: Optional[KnowledgeBaseSummary] = None


class KnowledgeBaseSummaryRefreshRequest(BaseModel):
    """Request schema for refreshing knowledge base summary."""

    force: bool = Field(
        False,
        description="Force refresh even if change threshold not reached",
    )


# ============== Summary Callback Schemas ==============


class DocumentSummaryCallbackRequest(BaseModel):
    """Request schema for document summary callback from executor."""

    short_summary: Optional[str] = Field(None, description="Short summary")
    long_summary: Optional[str] = Field(None, description="Long summary")
    topics: Optional[List[str]] = Field(None, description="Topics/tags")
    meta_info: Optional[DocumentSummaryMetaInfo] = Field(None, description="Metadata")
    status: Literal["completed", "failed"] = Field(
        ..., description="Summary generation result status"
    )
    error: Optional[str] = Field(None, description="Error message if failed")


class KnowledgeBaseSummaryCallbackRequest(BaseModel):
    """Request schema for knowledge base summary callback from executor."""

    short_summary: Optional[str] = Field(None, description="Short summary")
    long_summary: Optional[str] = Field(None, description="Long summary")
    topics: Optional[List[str]] = Field(None, description="Topics/tags")
    status: Literal["completed", "failed"] = Field(
        ..., description="Summary generation result status"
    )
    error: Optional[str] = Field(None, description="Error message if failed")

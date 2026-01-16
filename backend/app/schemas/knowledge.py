# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base and document management.
"""

from datetime import datetime
from enum import Enum
from typing import Dict, Optional

from pydantic import BaseModel, Field, field_validator

# Import shared types from kind.py to avoid duplication
from app.schemas.kind import (
    EmbeddingModelRef,
    HybridWeights,
    RetrievalConfig,
    RetrieverRef,
    SummaryModelRef,
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
    summary_enabled: bool = Field(
        default=False,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation. Format: {'name': 'model-name', 'namespace': 'default', 'type': 'public|user|group'}",
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
    summary_enabled: Optional[bool] = Field(
        None,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation. Format: {'name': 'model-name', 'namespace': 'default', 'type': 'public|user|group'}",
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
    summary_enabled: bool = Field(
        default=False,
        description="Enable automatic summary generation for documents",
    )
    summary_model_ref: Optional[Dict[str, str]] = Field(
        None,
        description="Model reference for summary generation",
    )
    summary: Optional[dict] = Field(
        None,
        description="Knowledge base summary (short_summary, long_summary, topics, etc.)",
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
        # Extract summary from spec.summary if available
        summary = spec.get("summary")
        # Extract summary_model_ref from spec
        summary_model_ref = spec.get("summaryModelRef")
        return cls(
            id=kind.id,
            name=spec.get("name", ""),
            description=spec.get("description") or None,  # Convert empty string to None
            user_id=kind.user_id,
            namespace=kind.namespace,
            document_count=document_count,
            retrieval_config=spec.get("retrievalConfig"),
            summary_enabled=spec.get("summaryEnabled", False),
            summary_model_ref=summary_model_ref,
            summary=summary,
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


# ============== Document Detail Schemas ==============


class DocumentDetailResponse(BaseModel):
    """Schema for document detail response (content + summary)."""

    document_id: int = Field(..., description="Document ID")
    content: Optional[str] = Field(
        None, description="Extracted text content from document"
    )
    content_length: Optional[int] = Field(
        None, description="Length of content in characters"
    )
    truncated: Optional[bool] = Field(None, description="Whether content was truncated")
    summary: Optional[dict] = Field(None, description="Document summary object")

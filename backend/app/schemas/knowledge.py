# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Pydantic schemas for knowledge base and document management.
"""

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

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
from app.services.knowledge.splitter_config import normalize_splitter_config


class DocumentStatus(str, Enum):
    """Document status enumeration."""

    ENABLED = "enabled"
    DISABLED = "disabled"


class DocumentSourceType(str, Enum):
    """Document source type enumeration."""

    FILE = "file"
    TEXT = "text"
    TABLE = "table"
    WEB = "web"
    ATTACHMENT = "attachment"


class DocumentIndexStatus(str, Enum):
    """Business status enumeration for document indexing."""

    NOT_INDEXED = "not_indexed"
    QUEUED = "queued"
    INDEXING = "indexing"
    SUCCESS = "success"
    FAILED = "failed"


class ResourceScope(str, Enum):
    """Resource scope for filtering."""

    PERSONAL = "personal"
    GROUP = "group"
    ORGANIZATION = "organization"
    ALL = "all"


# ============== Knowledge Base Schemas ==============
# Note: RetrieverRef, EmbeddingModelRef, HybridWeights, RetrievalConfig
# are imported from app.schemas.kind to maintain single source of truth


class KnowledgeBaseCreate(BaseModel):
    """Schema for creating a knowledge base."""

    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    namespace: str = Field(default="default", max_length=255)
    kb_type: Optional[str] = Field(
        "notebook",
        description="Knowledge base type: 'notebook' (3-column layout with chat) or 'classic' (document list only)",
    )
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
    guided_questions: Optional[List[str]] = Field(
        None,
        max_length=3,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )

    @field_validator("guided_questions")
    @classmethod
    def validate_guided_questions(cls, v):
        """Validate guided questions list."""
        if v is not None:
            if len(v) > 3:
                raise ValueError("Maximum 3 guided questions allowed")
            for i, q in enumerate(v):
                if not q or len(q.strip()) == 0:
                    raise ValueError(f"Guided question at index {i} cannot be empty")
                if len(q) > 200:
                    raise ValueError(
                        f"Guided question at index {i} exceeds 200 characters"
                    )
        return v


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
    guided_questions: Optional[List[str]] = Field(
        None,
        max_length=3,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )

    # Knowledge base tool call limit configuration
    max_calls_per_conversation: Optional[int] = Field(
        None,
        ge=2,
        le=50,
        description="Maximum number of knowledge base tool calls allowed per conversation",
    )
    exempt_calls_before_check: Optional[int] = Field(
        None,
        ge=1,
        description="Number of calls exempt from token checking (must be < max_calls_per_conversation)",
    )

    @model_validator(mode="after")
    def validate_call_limits(self):
        """Validate that exempt_calls_before_check < max_calls_per_conversation"""
        if (
            self.exempt_calls_before_check is not None
            and self.max_calls_per_conversation is not None
        ):
            if self.exempt_calls_before_check >= self.max_calls_per_conversation:
                raise ValueError(
                    "exempt_calls_before_check must be less than max_calls_per_conversation"
                )
        return self

    @field_validator("guided_questions")
    @classmethod
    def validate_guided_questions(cls, v):
        """Validate guided questions list."""
        if v is not None:
            if len(v) > 3:
                raise ValueError("Maximum 3 guided questions allowed")
            for i, q in enumerate(v):
                if not q or len(q.strip()) == 0:
                    raise ValueError(f"Guided question at index {i} cannot be empty")
                if len(q) > 200:
                    raise ValueError(
                        f"Guided question at index {i} exceeds 200 characters"
                    )
        return v


class KnowledgeBaseTypeUpdate(BaseModel):
    """Schema for updating knowledge base type (notebook <-> classic conversion)."""

    kb_type: str = Field(
        ...,
        pattern="^(notebook|classic)$",
        description="New knowledge base type: 'notebook' or 'classic'",
    )


class KnowledgeBaseResponse(BaseModel):
    """Schema for knowledge base response."""

    id: int
    name: str
    description: Optional[str] = None
    user_id: int
    namespace: str
    kb_type: Optional[str] = Field(
        "notebook",
        description="Knowledge base type: 'notebook' (3-column layout with chat) or 'classic' (document list only)",
    )
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
    guided_questions: Optional[List[str]] = Field(
        None,
        description="Guided questions list (max 3) to show in notebook mode for quick user interaction",
    )

    # Knowledge base tool call limit configuration
    max_calls_per_conversation: int = Field(default=10)
    exempt_calls_before_check: int = Field(default=5)

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
        # Extract kb_type from spec, default to 'notebook' for backward compatibility
        kb_type = spec.get("kbType", "notebook")

        # Extract guided questions from spec
        guided_questions = spec.get("guidedQuestions")

        # Extract call limit configuration with defaults for backward compatibility
        max_calls = spec.get("maxCallsPerConversation", 10)
        exempt_calls = spec.get("exemptCallsBeforeCheck", 5)

        # Validate: exempt_calls must be < max_calls
        if exempt_calls >= max_calls:
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                f"Invalid KB config for {kind.id}: exemptCallsBeforeCheck ({exempt_calls}) "
                f">= maxCallsPerConversation ({max_calls}). Using default values."
            )
            max_calls, exempt_calls = 10, 5

        return cls(
            id=kind.id,
            name=spec.get("name", ""),
            description=spec.get("description") or None,  # Convert empty string to None
            user_id=kind.user_id,
            namespace=kind.namespace,
            kb_type=kb_type,
            document_count=document_count,
            retrieval_config=spec.get("retrievalConfig"),
            summary_enabled=spec.get("summaryEnabled", False),
            summary_model_ref=summary_model_ref,
            summary=summary,
            guided_questions=guided_questions,
            max_calls_per_conversation=max_calls,
            exempt_calls_before_check=exempt_calls,
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
    index_status: DocumentIndexStatus
    index_generation: int
    splitter_config: Optional[SplitterConfig] = None
    source_type: DocumentSourceType = DocumentSourceType.FILE
    source_config: Optional[dict] = None
    doc_ref: Optional[str] = Field(
        None, description="RAG storage document reference ID"
    )
    created_at: datetime
    updated_at: datetime

    @field_validator("source_type", mode="before")
    @classmethod
    def ensure_source_type_enum(cls, v):
        """Convert string to DocumentSourceType enum for ORM compatibility."""
        if isinstance(v, str):
            try:
                return DocumentSourceType(v)
            except ValueError:
                return DocumentSourceType.FILE
        return v

    @field_validator("source_config", mode="before")
    @classmethod
    def ensure_source_config_dict(cls, v):
        """Convert None to empty dict for backward compatibility."""
        if v is None:
            return {}
        return v

    @field_validator("splitter_config", mode="before")
    @classmethod
    def normalize_splitter_config_for_response(cls, v):
        """Return normalized splitter config payloads in API responses."""
        if v is None:
            return v
        return normalize_splitter_config(v)

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


# ============== All Grouped Knowledge Schemas ==============


class KnowledgeBaseWithGroupInfo(BaseModel):
    """Schema for knowledge base with group info for all-grouped response."""

    id: int
    name: str
    description: Optional[str] = None
    kb_type: Optional[str] = "notebook"
    namespace: str
    document_count: int = 0
    updated_at: datetime
    created_at: datetime
    user_id: int
    # Group info for display
    group_id: str  # namespace or 'default'
    group_name: str  # Display name
    group_type: str  # 'personal' | 'personal-shared' | 'group' | 'organization'
    # User's role/permission for this knowledge base
    my_role: Optional[str] = Field(
        None,
        description="Current user's role for this KB: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst' | None",
    )


class AllGroupedPersonal(BaseModel):
    """Schema for personal knowledge bases in all-grouped response."""

    created_by_me: list[KnowledgeBaseWithGroupInfo]
    shared_with_me: list[KnowledgeBaseWithGroupInfo]


class AllGroupedTeamGroup(BaseModel):
    """Schema for a team group in all-grouped response."""

    group_name: str
    group_display_name: str
    kb_count: int
    knowledge_bases: list[KnowledgeBaseWithGroupInfo]


class AllGroupedOrganization(BaseModel):
    """Schema for organization knowledge bases in all-grouped response."""

    namespace: Optional[str] = None
    display_name: Optional[str] = None
    kb_count: int = 0
    knowledge_bases: list[KnowledgeBaseWithGroupInfo]


class AllGroupedSummary(BaseModel):
    """Schema for summary in all-grouped response."""

    total_count: int
    personal_count: int
    group_count: int
    organization_count: int


class AllGroupedKnowledgeResponse(BaseModel):
    """Schema for all knowledge bases grouped response.

    This is the response for GET /api/v1/knowledge-bases/all-grouped
    which returns all knowledge bases accessible to the user in a single request,
    solving the N+1 query problem.
    """

    personal: AllGroupedPersonal
    groups: list[AllGroupedTeamGroup]
    organization: AllGroupedOrganization
    summary: AllGroupedSummary


class PersonalKnowledgeBaseGroup(BaseModel):
    """Schema for personal knowledge base group (created by me vs shared with me)."""

    created_by_me: list[KnowledgeBaseResponse]
    shared_with_me: list[KnowledgeBaseResponse]


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


class DocumentContentReadResponse(BaseModel):
    """Schema for raw document content reads with pagination metadata."""

    document_id: int = Field(..., description="Document ID")
    name: str = Field(..., description="Document name")
    content: str = Field(..., description="Document content (partial)")
    total_length: int = Field(
        ..., ge=0, description="Total document length in characters"
    )
    offset: int = Field(..., ge=0, description="Actual start position")
    returned_length: int = Field(..., ge=0, description="Number of characters returned")
    has_more: bool = Field(..., description="Whether more content is available")
    kb_id: int = Field(..., description="Knowledge base ID")
    index_status: DocumentIndexStatus = Field(
        ..., description="Document indexing status"
    )


class DocumentContentUpdate(BaseModel):
    """Schema for updating document content (TEXT type only)."""

    content: str = Field(
        ..., min_length=1, max_length=500000, description="New Markdown content"
    )


# ============== Web Scraper Schemas ==============


class WebScrapeRequest(BaseModel):
    """Schema for web scrape request."""

    url: str = Field(..., min_length=1, description="URL to scrape")


class WebScrapeResponse(BaseModel):
    """Schema for web scrape response."""

    title: Optional[str] = Field(None, description="Page title")
    content: str = Field(..., description="Markdown content")
    url: str = Field(..., description="Source URL")
    scraped_at: str = Field(..., description="Scrape timestamp (ISO format)")
    content_length: int = Field(0, description="Content length in characters")
    description: Optional[str] = Field(None, description="Page description")
    success: bool = Field(True, description="Whether scraping succeeded")
    error_code: Optional[str] = Field(None, description="Error code if failed")
    error_message: Optional[str] = Field(None, description="Error message if failed")


# ============== Chunk Schemas ==============


class ChunkItem(BaseModel):
    """Schema for a single chunk item."""

    index: int = Field(..., ge=0, description="Chunk index (0-based)")
    content: str = Field(..., description="Chunk text content")
    token_count: int = Field(0, ge=0, description="Token count for this chunk")
    start_position: int = Field(
        0, ge=0, description="Start position in original document"
    )
    end_position: int = Field(0, ge=0, description="End position in original document")


class ChunkMetadata(BaseModel):
    """Schema for document chunks metadata stored in database."""

    items: list[ChunkItem] = Field(
        default_factory=list, description="List of chunk items"
    )
    total_count: int = Field(0, ge=0, description="Total number of chunks")
    splitter_type: str = Field(
        "flat",
        description="Normalized chunk strategy used for indexing (flat|hierarchical|semantic)",
    )
    splitter_subtype: Optional[str] = Field(
        None,
        description="Optional parser subtype resolved during format enhancement",
    )
    created_at: str = Field(..., description="Chunk creation timestamp (ISO format)")


class ChunkResponse(BaseModel):
    """Schema for single chunk response."""

    index: int = Field(..., ge=0, description="Chunk index (0-based)")
    content: str = Field(..., description="Full chunk content")
    token_count: int = Field(0, ge=0, description="Token count for this chunk")
    document_name: str = Field(..., description="Document name")
    document_id: int = Field(..., description="Document ID")
    kb_id: int = Field(..., description="Knowledge base ID")


class ChunkListResponse(BaseModel):
    """Schema for chunk list response with pagination."""

    total: int = Field(..., description="Total number of chunks")
    page: int = Field(1, ge=1, description="Current page number")
    page_size: int = Field(20, ge=1, le=100, description="Page size")
    items: list[ChunkItem] = Field(default_factory=list, description="Chunk items")
    splitter_type: Optional[str] = Field(
        None,
        description="Normalized chunk strategy used for indexing (flat|hierarchical|semantic)",
    )
    splitter_subtype: Optional[str] = Field(
        None,
        description="Optional parser subtype resolved during format enhancement",
    )


# ============== Citation Schemas ==============


class CandidateChunk(BaseModel):
    """Schema for a candidate chunk from retrieval (internal use, passed to AI)."""

    retrieval_index: int = Field(
        ..., ge=1, description="Retrieval result index (1-based), for AI citation"
    )
    kb_id: int = Field(..., description="Knowledge base ID")
    document_id: int = Field(..., description="Document ID")
    document_name: str = Field(..., description="Document name")
    chunk_index: int = Field(..., ge=0, description="Chunk index in document (0-based)")
    content: str = Field(..., description="Chunk full content")
    score: float = Field(..., ge=0.0, le=1.0, description="Retrieval relevance score")


class CitationSource(BaseModel):
    """Schema for citation source returned to frontend (after filtering and re-indexing)."""

    index: int = Field(
        ...,
        ge=1,
        description="Re-indexed citation number (1, 2, 3...), corresponds to [1], [2], [3] in AI response",
    )
    kb_id: int = Field(..., description="Knowledge base ID")
    document_id: int = Field(..., description="Document ID")
    document_name: str = Field(..., description="Document name")
    chunk_index: int = Field(
        ..., ge=0, description="Chunk index in document (0-based), for precise location"
    )


# ============== Knowledge Base Migration Schemas ==============


class KnowledgeBaseMigrateRequest(BaseModel):
    """Schema for migrating knowledge base to group request."""

    target_group_name: str = Field(
        ...,
        min_length=1,
        description="Target group name (namespace) to migrate the knowledge base to",
    )


class KnowledgeBaseMigrateResponse(BaseModel):
    """Schema for knowledge base migration response."""

    success: bool = Field(..., description="Whether migration succeeded")
    message: str = Field(..., description="Migration result message")
    knowledge_base_id: int = Field(..., description="Knowledge base ID")
    old_namespace: str = Field(..., description="Original namespace")
    new_namespace: str = Field(..., description="New namespace after migration")


# ============== v1 API Schemas ==============

# Maximum allowed binary size for base64-encoded file uploads (10 MiB)
_MAX_FILE_DECODED_BYTES = 10 * 1024 * 1024
_MAX_FILE_BASE64_LEN = ((_MAX_FILE_DECODED_BYTES + 2) // 3) * 4  # 13_981_016


class KnowledgeDocumentCreateV1(BaseModel):
    """Request schema for v1 document creation endpoint.

    Accepts all source types; unsupported types are rejected at the
    handler level with a descriptive error.
    """

    knowledge_base_id: int = Field(..., description="Target knowledge base ID")
    name: str = Field(..., min_length=1, max_length=255, description="Document name")
    source_type: DocumentSourceType = Field(
        DocumentSourceType.TEXT,
        description=(
            "Document source type: 'text' (inline content), 'file' (base64 binary), "
            "'web' (URL scraping), 'attachment' (existing attachment ID)"
        ),
    )
    # source_type=text
    content: Optional[str] = Field(
        None,
        min_length=1,
        max_length=500_000,
        description="Text content (required for source_type='text')",
    )
    file_extension: Optional[str] = Field(
        None,
        max_length=50,
        description="File extension without leading dot, e.g. 'md' (optional for source_type='text')",
    )
    # source_type=file
    file_base64: Optional[str] = Field(
        None,
        max_length=_MAX_FILE_BASE64_LEN,
        description="Base64-encoded file binary (required for source_type='file', max 10 MB decoded)",
    )
    # source_type=web
    url: Optional[str] = Field(
        None,
        description="URL to scrape (required for source_type='web')",
    )
    # source_type=attachment
    attachment_id: Optional[int] = Field(
        None,
        description="Attachment context ID (required for source_type='attachment')",
    )
    # common optional
    splitter_config: Optional[SplitterConfig] = Field(
        None,
        description="Custom text splitter configuration",
    )


class DocumentContentUpdateResponse(BaseModel):
    """Response schema for the v1 document content update endpoint."""

    success: bool = Field(..., description="Whether the update succeeded")
    document_id: int = Field(..., description="ID of the updated document")
    message: str = Field(..., description="Human-readable result message")


class KnowledgeSearchRequest(BaseModel):
    """Request schema for v1 knowledge base search endpoint.

    Resolves retriever and embedding model automatically from KB config,
    so callers only need to specify what to search, not how.
    """

    knowledge_base_id: int = Field(..., description="Knowledge base ID to search in")
    query: str = Field(
        ..., min_length=1, max_length=2000, description="Search query text"
    )
    top_k: int = Field(5, ge=1, le=100, description="Number of results to return")
    score_threshold: float = Field(
        0.7, ge=0.0, le=1.0, description="Minimum similarity score threshold"
    )
    route_mode: str = Field(
        "auto",
        description="Retrieval mode: 'auto', 'direct_injection', or 'rag_retrieval'",
    )
    context_window: int = Field(
        128000,
        ge=1,
        description="Context window size for direct injection mode",
    )
    used_context_tokens: int = Field(
        0,
        ge=0,
        description="Already used context tokens",
    )
    reserved_output_tokens: int = Field(
        4096,
        ge=0,
        description="Reserved output tokens",
    )
    context_buffer_ratio: float = Field(
        0.1,
        ge=0.0,
        le=1.0,
        description="Context buffer ratio for safety margin",
    )
    max_direct_chunks: int = Field(
        500,
        ge=1,
        le=10000,
        description="Maximum chunks for direct injection",
    )

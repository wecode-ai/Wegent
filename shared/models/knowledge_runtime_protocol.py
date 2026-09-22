# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight transport models for Backend <-> knowledge_runtime."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from shared.models.runtime_config import (
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.models.search_hints import MAX_SEARCH_QUERY_LENGTH, SearchHints


class KnowledgeRuntimeProtocolModel(BaseModel):
    """Base protocol model with strict field validation."""

    model_config = ConfigDict(extra="forbid")


class BackendAttachmentStreamContentRef(KnowledgeRuntimeProtocolModel):
    """Content reference resolved by streaming through Backend."""

    kind: Literal["backend_attachment_stream"]
    url: str
    auth_token: str
    expires_at: datetime | None = None


class PresignedUrlContentRef(KnowledgeRuntimeProtocolModel):
    """Content reference resolved directly from object storage."""

    kind: Literal["presigned_url"]
    url: str
    expires_at: datetime | None = None
    is_encrypted: bool = False


ContentRef = Annotated[
    BackendAttachmentStreamContentRef | PresignedUrlContentRef,
    Field(discriminator="kind"),
]


RetrievalPolicy = Literal[
    "chunk_only",
    "summary_first",
    "summary_then_chunk_expand",
    "hybrid",
]


class KnowledgeRuntimeAuth(KnowledgeRuntimeProtocolModel):
    """Simple internal auth carrier for the runtime service."""

    scheme: Literal["bearer"] = "bearer"
    token: str


class RemoteRagError(KnowledgeRuntimeProtocolModel):
    """Standardized remote error payload."""

    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None


class RemoteKnowledgeBaseQueryConfig(KnowledgeRuntimeProtocolModel):
    """Resolved execution config for one queryable knowledge base."""

    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    embedding_model_config: RuntimeEmbeddingModelConfig
    retrieval_config: RuntimeRetrievalConfig


class RemoteKnowledgeBaseRetrievalOverride(KnowledgeRuntimeProtocolModel):
    """Per-request retrieval-only override for one knowledge base."""

    knowledge_base_id: int
    retrieval_config: RuntimeRetrievalConfig


class RetrievalScope(KnowledgeRuntimeProtocolModel):
    """Domain-level retrieval scope.

    This is intentionally minimal for now. Document IDs are business document
    IDs and must be compiled by storage backends into their native doc_ref
    filters instead of being represented as generic metadata conditions.
    """

    document_ids: list[int] | None = None

    @field_validator("document_ids")
    @classmethod
    def validate_document_ids(cls, value: list[int] | None) -> list[int] | None:
        """Validate and deduplicate document scope IDs."""
        if value is None:
            return None
        if not value:
            raise ValueError("document_ids must not be empty")
        if any(document_id < 1 for document_id in value):
            raise ValueError("document_ids must contain positive integers")
        return list(dict.fromkeys(value))


class RemoteIndexRequest(KnowledgeRuntimeProtocolModel):
    """Index request - reference mode. KR resolves configs from DB."""

    knowledge_base_id: int
    user_id: int
    document_id: int | None = None
    source_file: str | None = None
    file_extension: str | None = None
    content_ref: ContentRef
    trace_context: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


class RemoteDeleteDocumentIndexRequest(KnowledgeRuntimeProtocolModel):
    """Delete-document-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    document_ref: str
    extensions: dict[str, Any] | None = None


class RemotePurgeKnowledgeIndexRequest(KnowledgeRuntimeProtocolModel):
    """Purge-knowledge-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    extensions: dict[str, Any] | None = None


class RemoteDropKnowledgeIndexRequest(KnowledgeRuntimeProtocolModel):
    """Drop-physical-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    extensions: dict[str, Any] | None = None


class RemoteListChunksRequest(KnowledgeRuntimeProtocolModel):
    """List-chunks request - reference mode."""

    knowledge_base_id: int
    user_id: int
    max_chunks: int = Field(default=10000, gt=0, le=10000)
    query: str | None = None
    metadata_condition: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


class RemoteQueryRequest(KnowledgeRuntimeProtocolModel):
    """Query request - reference mode. KR resolves configs from DB."""

    knowledge_base_ids: list[int]
    user_id: int
    query: str = Field(min_length=1, max_length=MAX_SEARCH_QUERY_LENGTH)
    search_hints: SearchHints | None = None
    max_results: int = Field(default=5, gt=0)
    knowledge_base_retrieval_overrides: (
        list[RemoteKnowledgeBaseRetrievalOverride] | None
    ) = None
    scope: RetrievalScope | None = None
    document_ids: list[int] | None = None
    metadata_condition: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None

    @field_validator("document_ids")
    @classmethod
    def validate_compatible_document_ids(
        cls,
        value: list[int] | None,
    ) -> list[int] | None:
        """Validate the compatibility document scope field."""
        return RetrievalScope.validate_document_ids(value)

    @model_validator(mode="after")
    def validate_scope_compatibility(self) -> RemoteQueryRequest:
        """Reject conflicting new and compatibility document scope fields."""
        if self.scope is None or self.document_ids is None:
            return self

        if set(self.scope.document_ids or []) != set(self.document_ids or []):
            raise ValueError(
                "scope.document_ids and document_ids must match when both are set"
            )
        return self


class RemoteQueryRecord(KnowledgeRuntimeProtocolModel):
    """Single retrieval record returned by knowledge_runtime."""

    content: str
    title: str
    score: float | None = None
    metadata: dict[str, Any] | None = None
    knowledge_base_id: int | None = None
    document_id: int | None = None
    index_family: str = "chunk_vector"


class RemoteQueryResponse(KnowledgeRuntimeProtocolModel):
    """Query response returned by knowledge_runtime."""

    records: list[RemoteQueryRecord]
    total: int
    total_estimated_tokens: int = 0


class RemoteListChunkRecord(KnowledgeRuntimeProtocolModel):
    """Single chunk returned by knowledge_runtime list-chunks endpoint."""

    content: str
    title: str
    chunk_id: int | None = None
    doc_ref: str | None = None
    metadata: dict[str, Any] | None = None


class RemoteListChunksResponse(KnowledgeRuntimeProtocolModel):
    """Chunk listing response returned by knowledge_runtime."""

    chunks: list[RemoteListChunkRecord]
    total: int

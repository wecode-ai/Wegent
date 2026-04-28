# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight transport models for Backend <-> knowledge_runtime."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from shared.models.runtime_config import (
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


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
    query: str
    max_results: int = Field(default=5, gt=0)
    document_ids: list[int] | None = None
    metadata_condition: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


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

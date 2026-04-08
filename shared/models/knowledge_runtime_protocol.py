# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight transport models for Backend <-> knowledge_runtime."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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

RetrievalMode = Literal["vector", "keyword", "hybrid"]


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


class RuntimeRetrieverConfig(KnowledgeRuntimeProtocolModel):
    """Resolved retriever identity and storage configuration."""

    name: str
    namespace: str = "default"
    storage_config: dict[str, Any] = Field(default_factory=dict)


class RuntimeEmbeddingModelConfig(KnowledgeRuntimeProtocolModel):
    """Resolved embedding model configuration."""

    model_name: str
    model_namespace: str = "default"
    resolved_config: dict[str, Any] = Field(default_factory=dict)


class RuntimeRetrievalConfig(KnowledgeRuntimeProtocolModel):
    """Normalized retrieval config for a single knowledge base target."""

    top_k: int = Field(default=20, gt=0)
    score_threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    retrieval_mode: RetrievalMode = "vector"
    vector_weight: float | None = Field(default=None, ge=0.0, le=1.0)
    keyword_weight: float | None = Field(default=None, ge=0.0, le=1.0)


class RemoteKnowledgeBaseQueryConfig(KnowledgeRuntimeProtocolModel):
    """Resolved execution config for one queryable knowledge base."""

    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    embedding_model_config: RuntimeEmbeddingModelConfig
    retrieval_config: RuntimeRetrievalConfig


class RemoteIndexRequest(KnowledgeRuntimeProtocolModel):
    """Index request sent from Backend to knowledge_runtime."""

    knowledge_base_id: int
    document_id: int | None = None
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    embedding_model_config: RuntimeEmbeddingModelConfig
    splitter_config: dict[str, Any] | None = None
    source_file: str | None = None
    file_extension: str | None = None
    index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    content_ref: ContentRef
    trace_context: dict[str, Any] | None = None
    user_name: str | None = None
    extensions: dict[str, Any] | None = None


class RemoteDeleteDocumentIndexRequest(KnowledgeRuntimeProtocolModel):
    """Delete-document-index request sent from Backend to knowledge_runtime."""

    knowledge_base_id: int
    document_ref: str
    index_owner_user_id: int | None = None
    retriever_config: RuntimeRetrieverConfig
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    extensions: dict[str, Any] | None = None


class RemoteListChunksRequest(KnowledgeRuntimeProtocolModel):
    """List-chunks request sent from Backend to knowledge_runtime."""

    knowledge_base_id: int
    index_owner_user_id: int
    retriever_config: RuntimeRetrieverConfig
    max_chunks: int = Field(default=10000, gt=0, le=10000)
    query: str | None = None
    metadata_condition: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


class RemoteTestConnectionRequest(KnowledgeRuntimeProtocolModel):
    """Test-connection request sent from Backend to knowledge_runtime."""

    retriever_config: RuntimeRetrieverConfig
    extensions: dict[str, Any] | None = None


class RemoteQueryRequest(KnowledgeRuntimeProtocolModel):
    """Query request sent from Backend to knowledge_runtime."""

    knowledge_base_ids: list[int]
    query: str
    max_results: int = Field(default=5, gt=0)
    document_ids: list[int] | None = None
    metadata_condition: dict[str, Any] | None = None
    user_name: str | None = None
    knowledge_base_configs: list[RemoteKnowledgeBaseQueryConfig]
    enabled_index_families: list[str] = Field(default_factory=lambda: ["chunk_vector"])
    retrieval_policy: RetrievalPolicy = "chunk_only"
    extensions: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_knowledge_base_configs(self) -> "RemoteQueryRequest":
        if not self.knowledge_base_configs:
            raise ValueError("knowledge_base_configs must not be empty")

        requested_ids = list(self.knowledge_base_ids)
        configured_ids = [
            config.knowledge_base_id for config in self.knowledge_base_configs
        ]
        if Counter(requested_ids) != Counter(configured_ids):
            raise ValueError(
                "knowledge_base_configs must align with knowledge_base_ids"
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

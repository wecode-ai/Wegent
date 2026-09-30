# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Lightweight transport models for Backend <-> knowledge_runtime."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from shared.knowledge_contracts.retrieval_scope import RetrievalScope
from shared.knowledge_contracts.runtime_config import (
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.knowledge_contracts.search_hints import (
    MAX_SEARCH_QUERY_LENGTH,
    SearchHints,
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


class RemoteRetrievalResourceRef(KnowledgeRuntimeProtocolModel):
    """A retrieval resource reference authorized by Backend for this call."""

    kind: Literal["Retriever", "Model"]
    name: str
    namespace: str = "default"


class RemoteAuthorizedRetrievalResources(KnowledgeRuntimeProtocolModel):
    """Per-knowledge-base resources Backend authorized for one remote operation.

    Backend verifies the caller may read the knowledge base and that the
    knowledge base owner may use these retriever and embedding model records,
    then sends only the references. The runtime loads just these records instead
    of widening the lookup with a bare Kind query.

    ``explicit_selection`` marks the entry as the resources the caller
    explicitly selected for a public query, so they supersede the stored
    configuration. Without it the stored configuration must name these same
    resources, keeping the previous "edited outside the authorized set" failure.
    Index requests never set it: indexing always executes the stored
    configuration, restricted to the authorized records.

    MVP trust boundary: the shared internal service token only proves the caller
    holds it. It cannot prove Backend generated these references, and it is not
    an authorization credential, so other services must not treat it as one.
    """

    knowledge_base_id: int
    index_owner_user_id: int
    retriever: RemoteRetrievalResourceRef
    embedding_model: RemoteRetrievalResourceRef
    explicit_selection: bool = False


class RemoteAuthorizedIndexResources(KnowledgeRuntimeProtocolModel):
    """Operation-bound storage reference; no embedding or query parameters."""

    knowledge_base_id: int
    index_owner_user_id: int
    operation: Literal["delete", "purge", "drop", "list_chunks"]
    retriever: RemoteRetrievalResourceRef


class RemoteIndexRequest(KnowledgeRuntimeProtocolModel):
    """Index request - reference mode. KR resolves configs from DB.

    ``authorized_resources`` carries the retrieval resources Backend authorized
    for this knowledge base owner. The runtime loads only those records and
    resolves the index configuration through the shared module.
    """

    knowledge_base_id: int
    user_id: int
    document_id: int | None = None
    source_file: str | None = None
    file_extension: str | None = None
    content_ref: ContentRef
    authorized_resources: RemoteAuthorizedRetrievalResources | None = None
    trace_context: dict[str, Any] | None = None
    extensions: dict[str, Any] | None = None


class RemoteDeleteDocumentIndexRequest(KnowledgeRuntimeProtocolModel):
    """Delete-document-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    authorized_resources: RemoteAuthorizedIndexResources | None = None
    document_ref: str
    extensions: dict[str, Any] | None = None


class RemotePurgeKnowledgeIndexRequest(KnowledgeRuntimeProtocolModel):
    """Purge-knowledge-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    authorized_resources: RemoteAuthorizedIndexResources | None = None
    extensions: dict[str, Any] | None = None


class RemoteDropKnowledgeIndexRequest(KnowledgeRuntimeProtocolModel):
    """Drop-physical-index request - reference mode."""

    knowledge_base_id: int
    user_id: int
    authorized_resources: RemoteAuthorizedIndexResources | None = None
    extensions: dict[str, Any] | None = None


class RemoteListChunksRequest(KnowledgeRuntimeProtocolModel):
    """List-chunks request - reference mode."""

    knowledge_base_id: int
    user_id: int
    authorized_resources: RemoteAuthorizedIndexResources | None = None
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
    authorized_resources: list[RemoteAuthorizedRetrievalResources] | None = None
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

"""Models and protocols for pluggable retrieval sources."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Optional, Protocol

from app.schemas.external_knowledge import (
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeRef,
)

if TYPE_CHECKING:
    from app.api.endpoints.internal.rag import RetrieveRecord


@dataclass(frozen=True)
class RetrievalContext:
    """Request-scoped context passed to external retrieval providers."""

    user_id: int
    user_name: Optional[str] = None


@dataclass(frozen=True)
class RetrievalSourceStatus:
    """Per-source retrieval status used by UI diagnostics."""

    provider: str
    source_id: str
    source_name: Optional[str] = None
    status: Literal["hit", "no_hit", "ignored", "failed"] = "no_hit"
    record_count: int = 0
    citation_count: int = 0
    mode: Optional[str] = None


@dataclass(frozen=True)
class RetrievalSourceSummary:
    """Provider-level retrieval summary."""

    provider: str
    searched_source_ids: list[str]
    ignored_source_ids: list[str]
    source_statuses: list[RetrievalSourceStatus] = field(default_factory=list)


@dataclass
class RetrievalSourceResult:
    """Provider retrieval result."""

    records: list[RetrieveRecord]
    summary: Optional[RetrievalSourceSummary] = None
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ExternalKnowledgeDocument:
    """Document entry exposed by an external knowledge source."""

    provider: str
    source_id: str
    source_name: Optional[str]
    document_id: str
    title: str
    node_id: Optional[str] = None
    parent_id: Optional[str] = None
    mime_type: Optional[str] = None
    file_extension: Optional[str] = None
    source_uri: Optional[str] = None


@dataclass
class ExternalKnowledgeDocumentListResult:
    """Provider document listing result."""

    documents: list[ExternalKnowledgeDocument]
    warnings: list[str] = field(default_factory=list)


class ExternalRefValidationError(Exception):
    """External knowledge binding validation failed."""


class RetrievalSourceProvider(Protocol):
    """Protocol implemented by external retrieval source providers."""

    name: str

    async def retrieve(
        self,
        query: str,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
    ) -> RetrievalSourceResult:
        """Retrieve records for refs."""
        ...

    def validate_refs(
        self,
        refs: list[ExternalKnowledgeRef],
        *,
        binding_level: ExternalKnowledgeBindingLevel,
    ) -> None:
        """Validate refs for a binding level."""
        ...


class DocumentListingSourceProvider(Protocol):
    """Optional capability for providers that can list visible documents."""

    async def list_documents(
        self,
        refs: list[ExternalKnowledgeRef],
        ctx: RetrievalContext,
        *,
        limit: int,
        offset: int,
    ) -> ExternalKnowledgeDocumentListResult:
        """List documents visible through refs."""
        ...


def validate_external_refs(
    refs: list[ExternalKnowledgeRef],
    *,
    binding_level: ExternalKnowledgeBindingLevel,
) -> None:
    """Validate external refs and dispatch provider-specific validation."""
    from .registry import retrieval_source_registry

    refs_by_provider: dict[str, list[ExternalKnowledgeRef]] = {}
    for ref in refs:
        refs_by_provider.setdefault(ref.provider, []).append(ref)

    for provider_name, provider_refs in refs_by_provider.items():
        provider = retrieval_source_registry.get(provider_name)
        if provider and hasattr(provider, "validate_refs"):
            provider.validate_refs(provider_refs, binding_level=binding_level)

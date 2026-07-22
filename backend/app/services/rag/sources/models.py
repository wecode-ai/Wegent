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
    canonical_ref_key: Optional[str] = None
    reason: Optional[str] = None


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
class ExternalProviderCapabilities:
    """Security and selection capabilities declared by a retrieval provider."""

    enforces_per_user_access: bool = False
    supports_virtual_containers: bool = False


@dataclass(frozen=True)
class ExternalRefGateRequest:
    """Context required to validate an external knowledge binding."""

    refs: list[ExternalKnowledgeRef]
    binding_level: ExternalKnowledgeBindingLevel
    actor_user_id: int


@dataclass(frozen=True)
class ExternalRefValidationResult:
    """Provider-reported validation result for one input ref."""

    ref: ExternalKnowledgeRef
    reason: Optional[str] = None
    message: Optional[str] = None

    @property
    def is_valid(self) -> bool:
        return self.reason is None


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
    """External knowledge binding validation failed with a provider-neutral reason."""

    def __init__(self, message: str, *, reason: str = "invalid_selection") -> None:
        super().__init__(message)
        self.reason = reason


class RetrievalSourceProvider(Protocol):
    """Protocol implemented by external retrieval source providers."""

    name: str
    capabilities: ExternalProviderCapabilities

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
        *,
        gate: ExternalRefGateRequest,
    ) -> None:
        """Validate refs for a binding level."""
        ...


class BatchExternalRefValidationProvider(Protocol):
    """Optional provider capability for one-call, per-ref gate results."""

    def validate_refs_batch(
        self,
        *,
        gate: ExternalRefGateRequest,
    ) -> list[ExternalRefValidationResult]:
        """Return one ordered result for every input ref."""
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
    actor_user_id: int,
) -> None:
    """Validate external refs and dispatch provider-specific validation."""
    from .registry import retrieval_source_registry

    refs_by_provider: dict[str, list[ExternalKnowledgeRef]] = {}
    for ref in refs:
        if binding_level == "agent" and ref.mode == "all_accessible":
            raise ExternalRefValidationError(
                "all_accessible external knowledge refs cannot be saved as agent defaults",
                reason="unsupported_binding",
            )
        refs_by_provider.setdefault(ref.provider, []).append(ref)

    for provider_name, provider_refs in refs_by_provider.items():
        provider = retrieval_source_registry.get(provider_name)
        if provider is None:
            raise ExternalRefValidationError(
                f"External knowledge provider is not registered: {provider_name}",
                reason="provider_unavailable",
            )

        capabilities = getattr(
            provider,
            "capabilities",
            ExternalProviderCapabilities(),
        )
        if binding_level == "agent" and not capabilities.enforces_per_user_access:
            raise ExternalRefValidationError(
                f"External knowledge provider cannot be saved as an agent default: {provider_name}",
                reason="unsupported_binding",
            )

        if hasattr(provider, "validate_refs"):
            provider.validate_refs(
                gate=ExternalRefGateRequest(
                    refs=provider_refs,
                    binding_level=binding_level,
                    actor_user_id=actor_user_id,
                )
            )

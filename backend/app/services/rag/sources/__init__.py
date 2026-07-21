"""External retrieval source framework."""

from .dingtalk import register_dingtalk_retrieval_source_provider
from .models import (
    DocumentListingSourceProvider,
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    ExternalKnowledgeRef,
    ExternalProviderCapabilities,
    ExternalRefGateRequest,
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceProvider,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
    validate_external_refs,
)
from .registry import retrieval_source_registry

register_dingtalk_retrieval_source_provider()

__all__ = [
    "DocumentListingSourceProvider",
    "ExternalProviderCapabilities",
    "ExternalRefGateRequest",
    "ExternalKnowledgeBindingLevel",
    "ExternalKnowledgeRef",
    "ExternalKnowledgeDocument",
    "ExternalKnowledgeDocumentListResult",
    "ExternalRefValidationError",
    "RetrievalContext",
    "RetrievalSourceProvider",
    "RetrievalSourceResult",
    "RetrievalSourceSummary",
    "RetrievalSourceStatus",
    "retrieval_source_registry",
    "validate_external_refs",
]

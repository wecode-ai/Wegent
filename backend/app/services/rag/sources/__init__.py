"""External retrieval source framework."""

from .dingtalk import dingtalk_knowledge_provider
from .models import (
    DocumentListingSourceProvider,
    ExternalKnowledgeBindingLevel,
    ExternalKnowledgeDocument,
    ExternalKnowledgeDocumentListResult,
    ExternalKnowledgeRef,
    ExternalRefValidationError,
    RetrievalContext,
    RetrievalSourceProvider,
    RetrievalSourceResult,
    RetrievalSourceStatus,
    RetrievalSourceSummary,
    validate_external_refs,
)
from .registry import retrieval_source_registry

retrieval_source_registry.register(dingtalk_knowledge_provider)

__all__ = [
    "DocumentListingSourceProvider",
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

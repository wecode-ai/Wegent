# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reusable knowledge module shared by Wegent and a second service.

The module owns the knowledge business rules for composing and validating
retrieval configuration, and for converting, indexing and deleting documents.
It stays free of Wegent product ORM models, database sessions and task workers,
so a service can reuse it without loading the product persistence layer. Each
side implements :class:`KnowledgeConfigAdapter` for configuration, plus the
conversion and index adapters it executes with.
"""

from .adapter import (
    EMBEDDING_RESOURCE_CATEGORY,
    MODEL_RESOURCE_KIND,
    RETRIEVER_RESOURCE_KIND,
    KnowledgeConfigAdapter,
    RetrievalProfileRecord,
    RetrievalResource,
)
from .config import (
    DEFAULT_RETRIEVAL_MODE,
    DEFAULT_SCORE_THRESHOLD,
    DEFAULT_TOP_K,
    MAX_TOP_K,
    MIN_TOP_K,
    VALID_RETRIEVAL_MODES,
    KnowledgeConfigError,
    ProfileHealth,
    evaluate_profile,
    prepare_knowledge_config,
    validate_knowledge_config,
    validate_retrieval_config_update,
)
from .documents import (
    CONVERSION_COMPLETE_STATUSES,
    CONVERSION_START_STATUSES,
    DOCUMENT_CONVERSION_PREFIX,
    ContentConversionAdapter,
    ConversionEngineResult,
    ConversionRequest,
    ConvertedContent,
    DocumentChunkMetadata,
    DocumentDeleteRequest,
    DocumentIndexAdapter,
    DocumentIndexRequest,
    DocumentStateDecision,
    KnowledgeDocumentError,
    build_document_chunk_metadata,
    build_document_delete_request,
    conversion_output_name,
    conversion_storage_prefix,
    convert_content,
    decide_conversion_completed,
    decide_conversion_started,
    delete_document,
    finalize_index_result,
    index_document,
    normalize_document_extension,
)
from .execution import (
    HISTORICAL_SCORE_THRESHOLD_FALLBACK,
    HISTORICAL_TOP_K_FALLBACK,
    AuthorizedRetrievalResources,
    ResolvedExecutionConfig,
    RetrievalResourceSelection,
    resolve_execution_config,
    resolve_management_config,
)
from .index_state import (
    IndexStateDecision,
    IndexStateSnapshot,
    active_index_stale_reason,
    decide_index_transition,
)
from .operations import (
    IndexManagementAdapter,
    QueryAdapter,
    QueryTarget,
    manage_index,
    query_documents,
)
from .query_planning import plan_query

__all__ = [
    "plan_query",
    "IndexStateSnapshot",
    "IndexStateDecision",
    "active_index_stale_reason",
    "decide_index_transition",
    "IndexManagementAdapter",
    "QueryAdapter",
    "QueryTarget",
    "manage_index",
    "query_documents",
    # Adapter boundary
    "KnowledgeConfigAdapter",
    "RetrievalResource",
    "RetrievalProfileRecord",
    "RETRIEVER_RESOURCE_KIND",
    "MODEL_RESOURCE_KIND",
    "EMBEDDING_RESOURCE_CATEGORY",
    # Configuration rules
    "KnowledgeConfigError",
    "ProfileHealth",
    "prepare_knowledge_config",
    "validate_knowledge_config",
    "validate_retrieval_config_update",
    "evaluate_profile",
    # Execution configuration
    "resolve_execution_config",
    "resolve_management_config",
    "AuthorizedRetrievalResources",
    "RetrievalResourceSelection",
    "ResolvedExecutionConfig",
    "HISTORICAL_TOP_K_FALLBACK",
    "HISTORICAL_SCORE_THRESHOLD_FALLBACK",
    "DEFAULT_RETRIEVAL_MODE",
    "DEFAULT_TOP_K",
    "DEFAULT_SCORE_THRESHOLD",
    "MIN_TOP_K",
    "MAX_TOP_K",
    "VALID_RETRIEVAL_MODES",
    # Conversion and indexing rules
    "KnowledgeDocumentError",
    "ContentConversionAdapter",
    "ConversionRequest",
    "ConversionEngineResult",
    "ConvertedContent",
    "convert_content",
    "conversion_output_name",
    "conversion_storage_prefix",
    "normalize_document_extension",
    "DOCUMENT_CONVERSION_PREFIX",
    "CONVERSION_START_STATUSES",
    "CONVERSION_COMPLETE_STATUSES",
    "DocumentIndexAdapter",
    "DocumentIndexRequest",
    "DocumentDeleteRequest",
    "build_document_delete_request",
    "DocumentChunkMetadata",
    "DocumentStateDecision",
    "build_document_chunk_metadata",
    "finalize_index_result",
    "index_document",
    "delete_document",
    "decide_conversion_started",
    "decide_conversion_completed",
]

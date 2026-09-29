# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reusable knowledge module shared by Wegent and a second service.

The module owns the knowledge business rules for composing and validating
retrieval configuration. It stays free of Wegent product ORM models, database
sessions and task workers, so a service can reuse it without loading the product
persistence layer. Each side implements :class:`KnowledgeConfigAdapter` to
supply only the records it has authorized.
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
from .execution import (
    HISTORICAL_SCORE_THRESHOLD_FALLBACK,
    HISTORICAL_TOP_K_FALLBACK,
    AuthorizedRetrievalResources,
    ResolvedExecutionConfig,
    RetrievalResourceSelection,
    resolve_execution_config,
)

__all__ = [
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
]

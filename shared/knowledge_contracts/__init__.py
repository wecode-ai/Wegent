# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pure knowledge contracts shared by Wegent and the reusable knowledge module.

These contracts describe knowledge configuration, retrieval scope, and content
splitting. They must stay free of Wegent product ORM models, database sessions,
and task workers so another service can reuse them without loading the product
persistence layer.
"""

from .retrieval_scope import RetrievalScope
from .runtime_config import (
    RetrievalMode,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from .search_hints import (
    MAX_SEARCH_HINT_KEYWORDS,
    MAX_SEARCH_HINT_PHRASES,
    MAX_SEARCH_HINT_TERM_LENGTH,
    MAX_SEARCH_QUERY_LENGTH,
    SearchHints,
    coerce_search_hints,
    normalize_search_terms,
    normalize_search_text,
)
from .splitter_config import (
    FlatChunkConfig,
    HierarchicalChunkConfig,
    LegacySplitterConfig,
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
    SplitterConfigModel,
    build_runtime_default_splitter_config,
    normalize_runtime_splitter_config,
    normalize_splitter_config,
    serialize_splitter_config,
)

__all__ = [
    # Retrieval scope
    "RetrievalScope",
    # Runtime configuration
    "RetrievalMode",
    "RuntimeRetrieverConfig",
    "RuntimeEmbeddingModelConfig",
    "RuntimeRetrievalConfig",
    # Search hints
    "MAX_SEARCH_QUERY_LENGTH",
    "MAX_SEARCH_HINT_TERM_LENGTH",
    "MAX_SEARCH_HINT_KEYWORDS",
    "MAX_SEARCH_HINT_PHRASES",
    "SearchHints",
    "normalize_search_text",
    "normalize_search_terms",
    "coerce_search_hints",
    # Splitter configuration
    "SplitterConfigModel",
    "SemanticSplitterConfig",
    "SentenceSplitterConfig",
    "SmartSplitterConfig",
    "FlatChunkConfig",
    "HierarchicalChunkConfig",
    "MarkdownEnhancementConfig",
    "NormalizedSplitterConfig",
    "LegacySplitterConfig",
    "SplitterConfig",
    "normalize_splitter_config",
    "normalize_runtime_splitter_config",
    "build_runtime_default_splitter_config",
    "serialize_splitter_config",
]

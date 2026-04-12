# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document splitter helpers for knowledge_engine."""

from knowledge_engine.splitter.config import (
    FlatChunkConfig,
    HierarchicalChunkConfig,
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
    build_runtime_default_splitter_config,
    normalize_runtime_splitter_config,
    normalize_splitter_config,
    parse_splitter_config,
    serialize_splitter_config,
)
from knowledge_engine.splitter.factory import create_splitter
from knowledge_engine.splitter.file_aware import (
    resolve_file_aware_parser_subtype,
    supports_file_aware_split,
)
from knowledge_engine.splitter.markdown_enhancement import enhance_markdown_nodes
from knowledge_engine.splitter.smart import SmartSplitter
from knowledge_engine.splitter.splitter import (
    DocumentSplitter,
    SemanticSplitter,
    SentenceSplitter,
)

__all__ = [
    "DocumentSplitter",
    "FlatChunkConfig",
    "HierarchicalChunkConfig",
    "MarkdownEnhancementConfig",
    "NormalizedSplitterConfig",
    "SemanticSplitter",
    "SemanticSplitterConfig",
    "SentenceSplitter",
    "SentenceSplitterConfig",
    "SmartSplitter",
    "SmartSplitterConfig",
    "SplitterConfig",
    "build_runtime_default_splitter_config",
    "create_splitter",
    "enhance_markdown_nodes",
    "normalize_splitter_config",
    "normalize_runtime_splitter_config",
    "parse_splitter_config",
    "serialize_splitter_config",
    "resolve_file_aware_parser_subtype",
    "supports_file_aware_split",
]

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.base.embeddings.base import BaseEmbedding

from knowledge_engine.splitter.config import (
    FlatChunkConfig,
    HierarchicalChunkConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SplitterConfig,
)
from knowledge_engine.splitter.smart import SmartSplitter
from knowledge_engine.splitter.splitter import SemanticSplitter, SentenceSplitter


def _resolve_file_aware_extension(file_extension: str | None) -> str:
    return file_extension or ".txt"


def create_splitter(
    config: SplitterConfig | None,
    embed_model: BaseEmbedding,
    file_extension: str | None = None,
) -> SemanticSplitter | SentenceSplitter | SmartSplitter:
    if config is None:
        return SemanticSplitter(embed_model=embed_model)

    if isinstance(config, NormalizedSplitterConfig):
        if config.chunk_strategy == "semantic":
            semantic_config = config.semantic_config or SemanticSplitterConfig()
            return SemanticSplitter(
                embed_model=embed_model,
                buffer_size=semantic_config.buffer_size,
                breakpoint_percentile_threshold=(
                    semantic_config.breakpoint_percentile_threshold
                ),
            )

        if config.chunk_strategy == "hierarchical":
            hierarchical_config = (
                config.hierarchical_config or HierarchicalChunkConfig()
            )
            return SentenceSplitter(
                chunk_size=hierarchical_config.child_chunk_size,
                chunk_overlap=hierarchical_config.child_chunk_overlap,
                separator=hierarchical_config.child_separator,
                paragraph_separator=hierarchical_config.child_separator,
            )

        flat_config = config.flat_config or FlatChunkConfig()
        if config.format_enhancement == "file_aware":
            return SmartSplitter(
                file_extension=_resolve_file_aware_extension(file_extension),
                chunk_size=flat_config.chunk_size,
                chunk_overlap=flat_config.chunk_overlap,
                markdown_enhancement_enabled=config.markdown_enhancement.enabled,
            )

        return SentenceSplitter(
            chunk_size=flat_config.chunk_size,
            chunk_overlap=flat_config.chunk_overlap,
            separator=flat_config.separator,
            paragraph_separator=flat_config.separator,
        )

    if isinstance(config, SemanticSplitterConfig):
        return SemanticSplitter(
            embed_model=embed_model,
            buffer_size=config.buffer_size,
            breakpoint_percentile_threshold=config.breakpoint_percentile_threshold,
        )

    raise ValueError(f"Unknown splitter config type: {type(config)}")

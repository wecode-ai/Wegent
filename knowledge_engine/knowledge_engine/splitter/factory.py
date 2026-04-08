# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.base.embeddings.base import BaseEmbedding

from knowledge_engine.splitter.config import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
)
from knowledge_engine.splitter.smart import SmartSplitter
from knowledge_engine.splitter.splitter import SemanticSplitter, SentenceSplitter


def create_splitter(
    config: SplitterConfig | None,
    embed_model: BaseEmbedding,
    file_extension: str | None = None,
) -> SemanticSplitter | SentenceSplitter | SmartSplitter:
    if config is None:
        return SemanticSplitter(embed_model=embed_model)

    if isinstance(config, SemanticSplitterConfig):
        return SemanticSplitter(
            embed_model=embed_model,
            buffer_size=config.buffer_size,
            breakpoint_percentile_threshold=config.breakpoint_percentile_threshold,
        )

    if isinstance(config, SentenceSplitterConfig):
        return SentenceSplitter(
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            separator=config.separator,
        )

    if isinstance(config, SmartSplitterConfig):
        ext = config.file_extension or file_extension or ".txt"
        return SmartSplitter(
            file_extension=ext,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
        )

    raise ValueError(f"Unknown splitter config type: {type(config)}")

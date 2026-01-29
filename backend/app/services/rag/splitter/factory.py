# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating document splitters based on configuration.
"""

from typing import Union

from llama_index.core.base.embeddings.base import BaseEmbedding

from app.schemas.rag import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SmartSplitterConfig,
    SplitterConfig,
)
from app.services.rag.splitter.smart import SmartSplitter
from app.services.rag.splitter.splitter import SemanticSplitter, SentenceSplitter


def create_splitter(
    config: Union[SplitterConfig, None],
    embed_model: BaseEmbedding,
    file_extension: str = None,
) -> Union[SemanticSplitter, SentenceSplitter, SmartSplitter]:
    """
    Create a document splitter based on configuration.

    Args:
        config: Splitter configuration. If None, defaults to SemanticSplitter
        embed_model: Embedding model (required for SemanticSplitter)
        file_extension: File extension for smart splitter (optional, used when
                       config.file_extension is not set)

    Returns:
        Configured splitter instance

    Raises:
        ValueError: If config type is unknown
    """
    # Default to semantic splitter if no config provided
    if config is None:
        return SemanticSplitter(embed_model=embed_model)

    if isinstance(config, SemanticSplitterConfig):
        return SemanticSplitter(
            embed_model=embed_model,
            buffer_size=config.buffer_size,
            breakpoint_percentile_threshold=config.breakpoint_percentile_threshold,
        )
    elif isinstance(config, SentenceSplitterConfig):
        return SentenceSplitter(
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            separator=config.separator,
        )
    elif isinstance(config, SmartSplitterConfig):
        # Use config.file_extension if available, otherwise use parameter
        ext = config.file_extension or file_extension or ".txt"
        return SmartSplitter(
            file_extension=ext,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
        )
    else:
        raise ValueError(f"Unknown splitter config type: {type(config)}")

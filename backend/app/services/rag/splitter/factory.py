# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory for creating document splitters based on configuration.
"""

from typing import Optional, Union

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
    embed_model: BaseEmbedding = None,
    file_extension: Optional[str] = None,
    embedding_model_name: str = "",
) -> Union[SemanticSplitter, SentenceSplitter, SmartSplitter]:
    """
    Create a document splitter based on configuration.

    Args:
        config: Splitter configuration. If None, defaults to SemanticSplitter
        embed_model: Embedding model (required for SemanticSplitter)
        file_extension: File extension (required for SmartSplitter)
        embedding_model_name: Name of embedding model for token counting

    Returns:
        Configured splitter instance

    Raises:
        ValueError: If config type is unknown or required params are missing
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
        if not file_extension:
            raise ValueError("file_extension is required for SmartSplitter")
        return SmartSplitter(
            file_extension=file_extension,
            embedding_model_name=embedding_model_name,
        )
    else:
        raise ValueError(f"Unknown splitter config type: {type(config)}")

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document splitting for RAG indexing.
Supports multiple splitting strategies: semantic and sentence-based.
"""

from typing import List

from llama_index.core import Document
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.node_parser import (
    SemanticSplitterNodeParser,
)
from llama_index.core.node_parser import SentenceSplitter as LlamaIndexSentenceSplitter
from llama_index.core.schema import BaseNode


class SemanticSplitter:
    """
    Semantic-based document splitter.

    Uses embedding similarity to determine natural breakpoints in documents.
    """

    def __init__(
        self,
        embed_model: BaseEmbedding,
        buffer_size: int = 1,
        breakpoint_percentile_threshold: int = 95,
    ):
        """
        Initialize semantic splitter.

        Args:
            embed_model: Embedding model for semantic splitting
            buffer_size: Buffer size for semantic splitter
            breakpoint_percentile_threshold: Percentile threshold for breakpoints
        """
        self.embed_model = embed_model
        self.buffer_size = buffer_size
        self.breakpoint_percentile_threshold = breakpoint_percentile_threshold
        self.splitter = SemanticSplitterNodeParser(
            buffer_size=buffer_size,
            breakpoint_percentile_threshold=breakpoint_percentile_threshold,
            embed_model=embed_model,
        )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents into nodes using semantic splitting.

        Args:
            documents: List of documents to split

        Returns:
            List of nodes
        """
        return self.splitter.get_nodes_from_documents(documents)

    def get_config(self) -> dict:
        """Get splitter configuration."""
        return {
            "type": "semantic",
            "buffer_size": self.buffer_size,
            "breakpoint_percentile_threshold": self.breakpoint_percentile_threshold,
        }


class SentenceSplitter:
    """
    Sentence-based document splitter.

    Splits documents based on separators (e.g., sentences, paragraphs, newlines)
    with configurable chunk size and overlap.
    """

    def __init__(
        self,
        chunk_size: int = 1024,
        chunk_overlap: int = 200,
        separator: str = " ",
    ):
        """
        Initialize sentence splitter.

        Args:
            chunk_size: Maximum chunk size in characters (default: 1024)
            chunk_overlap: Number of characters to overlap between chunks (default: 200)
            separator: Separator to use for splitting (default: " " for word-level)
                      Common options:
                      - " " (space): word-level splitting
                      - "\n" (newline): line-level splitting
                      - "\n\n" (double newline): paragraph-level splitting
                      - "." (period): sentence-level splitting
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.separator = separator

        # Use LlamaIndex's SentenceSplitter
        self.splitter = LlamaIndexSentenceSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separator=separator,
        )

    def split_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Split documents into nodes using sentence-based splitting.

        Args:
            documents: List of documents to split

        Returns:
            List of nodes
        """
        return self.splitter.get_nodes_from_documents(documents)

    def get_config(self) -> dict:
        """Get splitter configuration."""
        return {
            "type": "sentence",
            "chunk_size": self.chunk_size,
            "chunk_overlap": self.chunk_overlap,
            "separator": self.separator,
        }


# Backward compatibility alias
DocumentSplitter = SemanticSplitter

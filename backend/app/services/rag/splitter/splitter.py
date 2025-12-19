# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document splitting for RAG indexing.
"""

from typing import List

from llama_index.core import Document
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.node_parser import SemanticSplitterNodeParser
from llama_index.core.schema import BaseNode


class DocumentSplitter:
    """Document splitting with semantic chunking."""

    def __init__(
        self,
        embed_model: BaseEmbedding,
        buffer_size: int = 1,
        breakpoint_percentile_threshold: int = 95,
    ):
        """
        Initialize document splitter.

        Args:
            embed_model: Embedding model for semantic splitting
            buffer_size: Buffer size for semantic splitter
            breakpoint_percentile_threshold: Percentile threshold for breakpoints
        """
        self.embed_model = embed_model
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

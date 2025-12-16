# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Document chunking for RAG indexing.
"""

from typing import List
from llama_index.core import Document
from llama_index.core.schema import BaseNode
from llama_index.core.node_parser import SemanticSplitterNodeParser


class DocumentChunker:
    """Document chunking with semantic splitting."""

    def __init__(self, embed_model, buffer_size: int = 1, breakpoint_percentile_threshold: int = 95):
        """
        Initialize document chunker.

        Args:
            embed_model: Embedding model for semantic chunking
            buffer_size: Buffer size for semantic splitter
            breakpoint_percentile_threshold: Percentile threshold for breakpoints
        """
        self.embed_model = embed_model
        self.splitter = SemanticSplitterNodeParser(
            buffer_size=buffer_size,
            breakpoint_percentile_threshold=breakpoint_percentile_threshold,
            embed_model=embed_model
        )

    def chunk_documents(self, documents: List[Document]) -> List[BaseNode]:
        """
        Chunk documents into nodes using semantic splitting.

        Args:
            documents: List of documents to chunk

        Returns:
            List of nodes
        """
        return self.splitter.get_nodes_from_documents(documents)

    def add_metadata(
        self,
        nodes: List[BaseNode],
        knowledge_id: str,
        document_id: str,
        source_file: str,
        created_at: str
    ) -> List[BaseNode]:
        """
        Add metadata to nodes.

        Args:
            nodes: List of nodes
            knowledge_id: Knowledge base ID
            document_id: Document ID
            source_file: Source file name
            created_at: Creation timestamp

        Returns:
            Nodes with updated metadata
        """
        for idx, node in enumerate(nodes):
            node.metadata.update({
                "knowledge_id": knowledge_id,
                "document_id": document_id,
                "source_file": source_file,
                "chunk_index": idx,
                "created_at": created_at
            })
        return nodes

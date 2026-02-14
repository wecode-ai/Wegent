# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Data models for RAG storage backends.
"""

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List

from llama_index.core.schema import BaseNode


@dataclass
class ChunkMetadata:
    """
    Standard metadata structure for document chunks in vector stores.

    This dataclass defines the common metadata fields used across all storage
    backends (Milvus, Elasticsearch, Qdrant) for indexing document chunks.

    The chunk_index field is optional and typically set during node iteration.

    Attributes:
        knowledge_id: Knowledge base ID that this chunk belongs to
        doc_ref: Document reference ID (doc_xxx format)
        source_file: Original source file name
        created_at: ISO 8601 timestamp when the chunk was created
        chunk_index: Index of this chunk within the document (0-based),
                     set during indexing iteration
    """

    knowledge_id: str
    doc_ref: str
    source_file: str
    created_at: str
    chunk_index: int = field(default=0)

    def to_dict(self) -> Dict[str, Any]:
        """
        Convert metadata to dictionary for node.metadata.update().

        Returns:
            Dictionary representation of the metadata
        """
        return asdict(self)

    def with_chunk_index(self, chunk_index: int) -> "ChunkMetadata":
        """
        Create a new ChunkMetadata with the specified chunk_index.

        This method is used during node iteration to set the chunk index
        for each node while keeping other metadata fields unchanged.

        Args:
            chunk_index: The index of the chunk within the document

        Returns:
            New ChunkMetadata instance with updated chunk_index
        """
        return ChunkMetadata(
            knowledge_id=self.knowledge_id,
            doc_ref=self.doc_ref,
            source_file=self.source_file,
            created_at=self.created_at,
            chunk_index=chunk_index,
        )

    def apply_to_nodes(self, nodes: List[BaseNode]) -> List[BaseNode]:
        """
        Apply metadata to all nodes with appropriate chunk_index.

        This method iterates through the nodes and updates each node's metadata
        with the chunk metadata, setting the correct chunk_index for each node.

        Args:
            nodes: List of nodes to apply metadata to

        Returns:
            The same list of nodes with updated metadata (modified in place)
        """
        for idx, node in enumerate(nodes):
            node.metadata.update(self.with_chunk_index(idx).to_dict())
        return nodes

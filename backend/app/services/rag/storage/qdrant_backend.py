# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Qdrant storage backend implementation.

Supported retrieval modes:
- vector: Pure vector similarity search using embeddings

Note on non-vector retrieval support:
- Current implementation only supports vector search
- Qdrant's newer versions (1.7+) do support full-text search via BM42 algorithm
  and hybrid search capabilities, but this implementation does not yet utilize them
- For keyword or hybrid search needs, use Elasticsearch backend instead
- Future enhancement: Add BM42/hybrid search support when upgrading Qdrant integration
"""

from typing import Any, ClassVar, Dict, List, Optional

from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.schema import BaseNode
from llama_index.core.vector_stores import ExactMatchFilter, MetadataFilters
from llama_index.core.vector_stores.types import (
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http import models as qdrant_models

from app.services.rag.retrieval.filters import parse_metadata_filters
from app.services.rag.storage.base import BaseStorageBackend


class QdrantBackend(BaseStorageBackend):
    """
    Qdrant storage backend implementation.

    Supported retrieval modes:
    - vector: Pure vector similarity search (default and only mode)

    Note on non-vector retrieval support:
    - Current implementation only supports vector search
    - Qdrant's newer versions (1.7+) do support full-text search via BM42 algorithm
      and hybrid search capabilities, but this implementation does not yet utilize them
    - For keyword or hybrid search needs, use Elasticsearch backend instead
    - Future enhancement: Add BM42/hybrid search support when upgrading Qdrant integration

    Class Attributes:
        SUPPORTED_RETRIEVAL_METHODS: List of supported retrieval method names
        INDEX_PREFIX: Prefix for rolling collection names
    """

    # Qdrant only supports vector search
    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = ["vector"]

    # Override INDEX_PREFIX for Qdrant collections
    INDEX_PREFIX: ClassVar[str] = "collection"

    def __init__(self, config: Dict):
        """
        Initialize Qdrant backend.

        Args:
            config: Storage configuration dict containing:
                - url: Qdrant server URL (e.g., "http://localhost:6333")
                - apiKey: Optional API key for Qdrant Cloud
                - indexStrategy: Index/collection naming strategy
                - ext: Additional config (e.g., vector_size, distance)
        """
        super().__init__(config)

        # Get vector configuration from ext (used by QdrantVectorStore for auto-creation)
        self.vector_size = self.ext.get("vector_size", 1536)  # Default for OpenAI
        self.distance = self.ext.get("distance", "Cosine")  # Cosine, Euclid, Dot

        # Initialize Qdrant client
        if self.api_key:
            # Qdrant Cloud connection
            self.client = QdrantClient(
                url=self.url,
                api_key=self.api_key,
            )
        else:
            # Local Qdrant connection
            self.client = QdrantClient(url=self.url)

    def create_vector_store(self, collection_name: str):
        """
        Create Qdrant vector store.

        LlamaIndex's QdrantVectorStore automatically creates the collection
        if it doesn't exist when adding nodes.

        Args:
            collection_name: Name of the collection

        Returns:
            QdrantVectorStore instance
        """
        return QdrantVectorStore(
            client=self.client,
            collection_name=collection_name,
        )

    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        knowledge_id: str,
        doc_ref: str,
        source_file: str,
        created_at: str,
        embed_model,
        **kwargs,
    ) -> Dict:
        """
        Add metadata to nodes and index them into Qdrant.

        Args:
            nodes: List of nodes to index
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            source_file: Source file name
            created_at: Creation timestamp
            embed_model: Embedding model
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            Indexing result dict
        """
        # Add metadata to nodes
        for idx, node in enumerate(nodes):
            node.metadata.update(
                {
                    "knowledge_id": knowledge_id,
                    "doc_ref": doc_ref,
                    "source_file": source_file,
                    "chunk_index": idx,
                    "created_at": created_at,
                }
            )

        # Get collection name
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        # Index nodes (LlamaIndex auto-creates collection if needed)
        vector_store = self.create_vector_store(collection_name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        VectorStoreIndex(
            nodes,
            storage_context=storage_context,
            embed_model=embed_model,
            show_progress=True,
        )

        return {
            "indexed_count": len(nodes),
            "index_name": collection_name,
            "status": "success",
        }

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict:
        """
        Retrieve nodes from Qdrant (Dify-style API).

        Uses LlamaIndex's VectorStoreQuery with DEFAULT mode (vector search only).

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1)
                - retrieval_mode: Only 'vector' is supported
            metadata_condition: Optional metadata filtering
            **kwargs: Additional parameters

        Returns:
            Retrieval result dict

        Raises:
            ValueError: If retrieval_mode is not 'vector'
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        # Increased default top_k from 5 to 20 for better RAG coverage
        top_k = retrieval_setting.get("top_k", 20)
        score_threshold = retrieval_setting.get("score_threshold", 0.7)
        retrieval_mode = retrieval_setting.get("retrieval_mode", "vector")

        # Validate retrieval mode - Qdrant only supports vector search
        if retrieval_mode not in self.SUPPORTED_RETRIEVAL_METHODS:
            raise ValueError(
                f"Qdrant does not support '{retrieval_mode}' retrieval mode. "
                f"Supported modes: {self.SUPPORTED_RETRIEVAL_METHODS}. "
                f"For keyword or hybrid search, use Elasticsearch backend."
            )

        # Create vector store
        vector_store = self.create_vector_store(collection_name)

        # Build metadata filters
        filters = self._build_metadata_filters(knowledge_id, metadata_condition)

        # Generate query embedding
        query_embedding = embed_model.get_query_embedding(query)

        # Create VectorStoreQuery (vector mode only)
        vs_query = VectorStoreQuery(
            query_str=query,
            query_embedding=query_embedding,
            similarity_top_k=top_k,
            mode=VectorStoreQueryMode.DEFAULT,
            filters=filters,
        )

        # Execute query
        result = vector_store.query(vs_query)

        # Process results
        return self._process_query_results(result, score_threshold)

    def _build_metadata_filters(
        self, knowledge_id: str, metadata_condition: Optional[Dict[str, Any]] = None
    ):
        """
        Build metadata filters from condition dict.

        Args:
            knowledge_id: Knowledge base ID (always filtered)
            metadata_condition: Optional additional metadata conditions

        Returns:
            MetadataFilters object
        """
        return parse_metadata_filters(knowledge_id, metadata_condition)

    def _process_query_results(
        self,
        result,
        score_threshold: float,
    ) -> Dict:
        """
        Process VectorStoreQueryResult into Dify-compatible format.

        Args:
            result: VectorStoreQueryResult from LlamaIndex
            score_threshold: Minimum relevance score (0-1)

        Returns:
            Dict with 'records' list in Dify-compatible format
        """
        # Handle empty results
        if not result.nodes:
            return {"records": []}

        # Process results (Dify-compatible format)
        results = []
        similarities = result.similarities or []

        for i, node in enumerate(result.nodes):
            score = (
                similarities[i]
                if i < len(similarities) and similarities[i] is not None
                else 0.0
            )

            # Qdrant with cosine similarity returns scores in 0-1 range
            if score >= score_threshold:
                results.append(
                    {
                        "content": node.text,
                        "score": float(score),
                        "title": node.metadata.get("source_file", ""),
                        "metadata": node.metadata,
                    }
                )

        return {"records": results}

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Delete document from Qdrant using LlamaIndex API.

        Uses delete_nodes with metadata filters to remove all chunks
        with matching doc_ref.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            **kwargs: Additional parameters

        Returns:
            Deletion result dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(collection_name)

        # Build filters to match the document
        filters = self._build_doc_ref_filters(knowledge_id, doc_ref)

        # Get nodes first to count them
        nodes = vector_store.get_nodes(filters=filters)
        deleted_count = len(nodes)

        # Delete nodes using LlamaIndex API
        vector_store.delete_nodes(filters=filters)

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_count,
            "status": "deleted",
        }

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Get document details from Qdrant using LlamaIndex API.

        Uses get_nodes with metadata filters to retrieve all chunks
        with matching doc_ref.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            **kwargs: Additional parameters

        Returns:
            Document details dict with chunks
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(collection_name)

        # Build filters to match the document
        filters = self._build_doc_ref_filters(knowledge_id, doc_ref)

        # Get nodes using LlamaIndex API
        nodes = vector_store.get_nodes(filters=filters)

        if not nodes:
            raise ValueError(f"Document {doc_ref} not found")

        # Extract chunks and sort by chunk_index
        chunks = []
        source_file = None
        for node in nodes:
            metadata = node.metadata

            if source_file is None:
                source_file = metadata.get("source_file")

            chunks.append(
                {
                    "chunk_index": metadata.get("chunk_index"),
                    "content": node.text,
                    "metadata": metadata,
                }
            )

        # Sort by chunk_index
        chunks.sort(key=lambda x: x.get("chunk_index", 0))

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": source_file,
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

    def _build_doc_ref_filters(self, knowledge_id: str, doc_ref: str):
        """
        Build metadata filters for document reference lookup.

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)

        Returns:
            MetadataFilters object for filtering by knowledge_id and doc_ref
        """
        return MetadataFilters(
            filters=[
                ExactMatchFilter(key="knowledge_id", value=knowledge_id),
                ExactMatchFilter(key="doc_ref", value=doc_ref),
            ],
            condition="and",
        )

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """
        List documents in Qdrant collection.

        Uses Qdrant's scroll API to aggregate documents by doc_ref.
        Note: This uses native Qdrant API as LlamaIndex doesn't provide
        aggregation functionality.

        Args:
            knowledge_id: Knowledge base ID
            page: Page number
            page_size: Page size
            **kwargs: Additional parameters

        Returns:
            Document list dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        # Use Qdrant scroll to get all points with matching knowledge_id
        # Then aggregate by doc_ref in Python
        scroll_filter = qdrant_models.Filter(
            must=[
                qdrant_models.FieldCondition(
                    key="knowledge_id",
                    match=qdrant_models.MatchValue(value=knowledge_id),
                )
            ]
        )

        # Scroll through all matching points
        all_points = []
        offset = None
        while True:
            results, offset = self.client.scroll(
                collection_name=collection_name,
                scroll_filter=scroll_filter,
                limit=1000,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            all_points.extend(results)
            if offset is None:
                break

        # Aggregate by doc_ref
        doc_map: Dict[str, Dict] = {}
        for point in all_points:
            payload = point.payload or {}
            doc_ref = payload.get("doc_ref")
            if not doc_ref:
                continue

            if doc_ref not in doc_map:
                doc_map[doc_ref] = {
                    "doc_ref": doc_ref,
                    "source_file": payload.get("source_file"),
                    "chunk_count": 0,
                    "created_at": payload.get("created_at"),
                }
            doc_map[doc_ref]["chunk_count"] += 1

        # Convert to list and sort by created_at
        all_docs = list(doc_map.values())
        all_docs.sort(key=lambda x: x.get("created_at") or "", reverse=True)

        # Pagination
        total = len(all_docs)
        start = (page - 1) * page_size
        end = start + page_size
        documents = all_docs[start:end]

        return {
            "documents": documents,
            "total": total,
            "page": page,
            "page_size": page_size,
            "knowledge_id": knowledge_id,
        }

    def test_connection(self) -> bool:
        """
        Test connection to Qdrant.

        Returns:
            True if connection successful, False otherwise
        """
        try:
            # Try to get collections list as a connection test
            self.client.get_collections()
            return True
        except Exception:
            return False

    def get_all_chunks(
        self, knowledge_id: str, max_chunks: int = 10000, **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base in Qdrant.

        Uses scroll API to efficiently retrieve all chunks for a knowledge base.

        Args:
            knowledge_id: Knowledge base ID
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        # Build filter for knowledge_id
        scroll_filter = qdrant_models.Filter(
            must=[
                qdrant_models.FieldCondition(
                    key="knowledge_id",
                    match=qdrant_models.MatchValue(value=knowledge_id),
                )
            ]
        )

        try:
            # Check if collection exists
            try:
                self.client.get_collection(collection_name)
            except Exception:
                return []

            # Scroll through all matching points
            all_points = []
            offset = None
            batch_size = min(1000, max_chunks)

            while len(all_points) < max_chunks:
                results, offset = self.client.scroll(
                    collection_name=collection_name,
                    scroll_filter=scroll_filter,
                    limit=batch_size,
                    offset=offset,
                    with_payload=True,
                    with_vectors=False,
                )
                all_points.extend(results)
                if offset is None or len(results) == 0:
                    break

            # Convert to chunk format
            chunks = []
            for point in all_points[:max_chunks]:
                payload = point.payload or {}

                # Normalize content to plain text. Qdrant stores the original
                # LlamaIndex node payload in `_node_content`, which may be a
                # serialized TextNode JSON. We use extract_chunk_text to
                # extract the human-readable `text` field and drop internal
                # fields (id_, relationships, embeddings, etc.).
                raw_content = payload.get("_node_content", "")

                chunks.append(
                    {
                        "content": self.extract_chunk_text(raw_content),
                        "title": payload.get("source_file", ""),
                        "chunk_id": payload.get("chunk_index", 0),
                        "doc_ref": payload.get("doc_ref", ""),
                        "metadata": payload,
                    }
                )

            # Sort by doc_ref and chunk_index
            chunks.sort(key=lambda x: (x.get("doc_ref", ""), x.get("chunk_id", 0)))

            return chunks

        except Exception as e:
            # Log error but return empty list to allow fallback to RAG
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                f"[Qdrant] Failed to get all chunks for KB {knowledge_id}: {e}"
            )
            return []

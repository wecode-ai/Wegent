# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Milvus storage backend implementation.

Supported retrieval modes:
- vector: Pure vector similarity search using embeddings (VectorStoreQueryMode.DEFAULT)
- keyword: BM25 keyword search (VectorStoreQueryMode.TEXT_SEARCH)
- hybrid: Combined vector + BM25 search with RRF ranking (VectorStoreQueryMode.HYBRID)

Note: Requires Milvus 2.5+ for keyword and hybrid search support.
"""

import logging
from typing import Any, ClassVar, Dict, List, Optional

from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.schema import BaseNode
from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
from llama_index.core.vector_stores.types import (
    FilterOperator,
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.milvus import MilvusVectorStore
from pymilvus import MilvusClient

from app.services.rag.retrieval.filters import parse_metadata_filters
from app.services.rag.storage.base import BaseStorageBackend

logger = logging.getLogger(__name__)


class MilvusBackend(BaseStorageBackend):
    """
    Milvus storage backend implementation.

    Supported retrieval modes:
    - vector: Pure vector similarity search (default)
    - keyword: Pure BM25 keyword search
    - hybrid: Combined vector + BM25 search with RRF ranking

    Class Attributes:
        SUPPORTED_RETRIEVAL_METHODS: List of supported retrieval method names
        INDEX_PREFIX: Prefix for collection names
    """

    # Milvus supports vector, keyword (BM25), and hybrid search
    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = ["vector", "keyword", "hybrid"]

    # Override INDEX_PREFIX for Milvus collections
    INDEX_PREFIX: ClassVar[str] = "collection"

    def __init__(self, config: Dict):
        """
        Initialize Milvus backend.

        Args:
            config: Storage configuration dict containing:
                - url: Milvus connection URL with db_name (e.g., "http://localhost:19530/default")
                - username: Optional username for authentication
                - password: Optional password for authentication
                - indexStrategy: Index/collection naming strategy
                - ext: Additional config (e.g., dim for vector dimension)

        Authentication:
            If both username and password are provided, they are concatenated
            as "{username}:{password}" to form the token.
        """
        super().__init__(config)

        # Get vector dimension from ext (default: 1536 for OpenAI embeddings)
        self.dim = self.ext.get("dim", 1536)

        # Build token for authentication: username:password
        if self.username and self.password:
            self.token = f"{self.username}:{self.password}"
        else:
            self.token = ""

    def create_vector_store(
        self, collection_name: str, retrieval_mode: str = "vector"
    ) -> MilvusVectorStore:
        """
        Create Milvus vector store instance.

        Args:
            collection_name: Name of the collection
            retrieval_mode: Retrieval mode - 'vector', 'keyword', or 'hybrid'

        Returns:
            MilvusVectorStore instance
        """
        return MilvusVectorStore(
            uri=self.url,
            token=self.token,
            collection_name=collection_name,
            dim=self.dim,
            overwrite=False,  # Do not overwrite existing collection
            enable_sparse=True,  # Enable sparse vector for keyword/hybrid search
            hybrid_ranker="RRFRanker",  # Use RRF for hybrid search ranking
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
        Add metadata to nodes and index them into Milvus.

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

        # Create vector store with upsert mode for data append/overwrite
        vector_store = MilvusVectorStore(
            uri=self.url,
            token=self.token,
            collection_name=collection_name,
            dim=self.dim,
            overwrite=False,
            enable_sparse=True,
            hybrid_ranker="RRFRanker",
        )

        # Index nodes using LlamaIndex
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
        Retrieve nodes from Milvus (Dify-style API).

        Uses LlamaIndex's VectorStoreQuery with different modes:
        - DEFAULT: Pure vector similarity search
        - TEXT_SEARCH: Pure BM25 keyword search
        - HYBRID: Combined vector + BM25 search with RRF ranking

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1)
                - retrieval_mode: Optional 'vector'/'keyword'/'hybrid' (default: 'vector')
            metadata_condition: Optional metadata filtering
            **kwargs: Additional parameters

        Returns:
            Retrieval result dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        # Increased default top_k from 5 to 20 for better RAG coverage
        top_k = retrieval_setting.get("top_k", 20)
        score_threshold = retrieval_setting.get("score_threshold", 0.7)
        retrieval_mode = retrieval_setting.get("retrieval_mode", "vector")

        # Validate retrieval mode
        if retrieval_mode not in self.SUPPORTED_RETRIEVAL_METHODS:
            raise ValueError(
                f"Milvus does not support '{retrieval_mode}' retrieval mode. "
                f"Supported modes: {self.SUPPORTED_RETRIEVAL_METHODS}."
            )

        # Create vector store
        vector_store = self.create_vector_store(collection_name, retrieval_mode)

        # Build metadata filters
        filters = self._build_metadata_filters(knowledge_id, metadata_condition)

        # Determine query mode and parameters
        if retrieval_mode == "keyword":
            # Pure BM25 keyword search - no embedding needed
            query_mode = VectorStoreQueryMode.TEXT_SEARCH
            query_embedding = None
        elif retrieval_mode == "hybrid":
            # Hybrid search - needs embedding
            query_mode = VectorStoreQueryMode.HYBRID
            query_embedding = embed_model.get_query_embedding(query)
        else:
            # Default: Pure vector search
            query_mode = VectorStoreQueryMode.DEFAULT
            query_embedding = embed_model.get_query_embedding(query)

        # Create VectorStoreQuery
        vs_query = VectorStoreQuery(
            query_str=query,
            query_embedding=query_embedding,
            similarity_top_k=top_k,
            mode=query_mode,
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

            # Milvus cosine similarity returns scores in 0-1 range
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
        Delete document from Milvus using LlamaIndex API.

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
        try:
            nodes = vector_store.get_nodes(filters=filters)
            deleted_count = len(nodes)
        except Exception:
            deleted_count = 0

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
        Get document details from Milvus using LlamaIndex API.

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
                MetadataFilter(
                    key="knowledge_id", value=knowledge_id, operator=FilterOperator.EQ
                ),
                MetadataFilter(key="doc_ref", value=doc_ref, operator=FilterOperator.EQ),
            ],
            condition="and",
        )

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """
        List documents in Milvus collection.

        Uses MilvusClient directly for aggregation functionality.

        Args:
            knowledge_id: Knowledge base ID
            page: Page number
            page_size: Page size
            **kwargs: Additional parameters

        Returns:
            Document list dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        try:
            # Create MilvusClient for direct query
            client = MilvusClient(uri=self.url, token=self.token)

            # Check if collection exists
            collections = client.list_collections()
            if collection_name not in collections:
                return {
                    "documents": [],
                    "total": 0,
                    "page": page,
                    "page_size": page_size,
                    "knowledge_id": knowledge_id,
                }

            # Query all records with matching knowledge_id
            # Note: Milvus requires specifying output fields
            results = client.query(
                collection_name=collection_name,
                filter=f'knowledge_id == "{knowledge_id}"',
                output_fields=["doc_ref", "source_file", "created_at", "chunk_index"],
                limit=10000,  # Safety limit
            )

            # Aggregate by doc_ref
            doc_map: Dict[str, Dict] = {}
            for record in results:
                doc_ref = record.get("doc_ref")
                if not doc_ref:
                    continue

                if doc_ref not in doc_map:
                    doc_map[doc_ref] = {
                        "doc_ref": doc_ref,
                        "source_file": record.get("source_file"),
                        "chunk_count": 0,
                        "created_at": record.get("created_at"),
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

        except Exception as e:
            logger.warning(
                f"[Milvus] Failed to list documents for KB {knowledge_id}: {e}"
            )
            return {
                "documents": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "knowledge_id": knowledge_id,
            }

    def test_connection(self) -> bool:
        """
        Test connection to Milvus.

        Returns:
            True if connection successful, False otherwise
        """
        try:
            client = MilvusClient(uri=self.url, token=self.token)
            # Try to list collections as a connection test
            client.list_collections()
            return True
        except Exception:
            return False

    def get_all_chunks(
        self, knowledge_id: str, max_chunks: int = 10000, **kwargs
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base in Milvus.

        Uses MilvusClient directly for efficient batch retrieval.

        Args:
            knowledge_id: Knowledge base ID
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)

        try:
            # Create MilvusClient for direct query
            client = MilvusClient(uri=self.url, token=self.token)

            # Check if collection exists
            collections = client.list_collections()
            if collection_name not in collections:
                return []

            # Query all records with matching knowledge_id
            results = client.query(
                collection_name=collection_name,
                filter=f'knowledge_id == "{knowledge_id}"',
                output_fields=[
                    "doc_ref",
                    "source_file",
                    "created_at",
                    "chunk_index",
                    "text",
                ],
                limit=max_chunks,
            )

            # Convert to chunk format
            chunks = []
            for record in results:
                # Get text content - try 'text' field first, then fallback
                raw_content = record.get("text", "")

                chunks.append(
                    {
                        "content": self.extract_chunk_text(raw_content),
                        "title": record.get("source_file", ""),
                        "chunk_id": record.get("chunk_index", 0),
                        "doc_ref": record.get("doc_ref", ""),
                        "metadata": record,
                    }
                )

            # Sort by doc_ref and chunk_index
            chunks.sort(key=lambda x: (x.get("doc_ref", ""), x.get("chunk_id", 0)))

            return chunks[:max_chunks]

        except Exception as e:
            logger.warning(
                f"[Milvus] Failed to get all chunks for KB {knowledge_id}: {e}"
            )
            return []

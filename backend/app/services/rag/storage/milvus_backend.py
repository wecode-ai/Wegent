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
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.schema import BaseNode
from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
from llama_index.core.vector_stores.types import (
    FilterOperator,
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.milvus import MilvusVectorStore
from llama_index.vector_stores.milvus.base import IndexManagement
from pymilvus import AsyncMilvusClient, MilvusClient

from app.services.rag.retrieval.filters import parse_metadata_filters
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.chunk_metadata import ChunkMetadata

logger = logging.getLogger(__name__)

# Named constants for magic numbers
DEFAULT_EMBEDDING_DIM = 1024  # Default vector dimension (OpenAI text-embedding-ada-002)
MAX_QUERY_LIMIT = 10000  # Maximum records to fetch for aggregation queries
DEFAULT_TOP_K = 20  # Default top_k for retrieval


class LazyAsyncMilvusVectorStore(MilvusVectorStore):
    """
    MilvusVectorStore subclass with lazy AsyncMilvusClient initialization.

    The original MilvusVectorStore creates AsyncMilvusClient in __init__,
    which requires an event loop. This causes issues when running in
    thread pools (e.g., Celery tasks via asyncio.to_thread).

    This subclass defers AsyncMilvusClient creation to first access,
    allowing synchronous operations to work without an event loop.

    See: https://github.com/run-llama/llama_index/issues/20313
    See: https://github.com/run-llama/llama_index/pull/20695
    """

    # Store config for lazy async client creation
    _milvusclient_config: Dict[str, Any] = {}

    def __init__(self, **kwargs: Any) -> None:
        """
        Initialize without creating AsyncMilvusClient.

        Stores connection params for lazy initialization and patches
        the parent class to skip AsyncMilvusClient creation.
        """
        import llama_index.vector_stores.milvus.base as milvus_base

        # Store the original AsyncMilvusClient class
        original_async_client = milvus_base.AsyncMilvusClient

        # Replace AsyncMilvusClient with a dummy that does nothing
        # This prevents the parent __init__ from creating the async client
        milvus_base.AsyncMilvusClient = lambda **kw: None  # type: ignore

        try:
            # Call parent __init__ - it will use our dummy AsyncMilvusClient
            super().__init__(**kwargs)
        finally:
            # Restore the original AsyncMilvusClient
            milvus_base.AsyncMilvusClient = original_async_client

        # Store connection params for lazy async client creation
        # Following the pattern from PR #20695
        uri = kwargs.get("uri", "./milvus_llamaindex.db")
        token = kwargs.get("token", "")
        # Filter out 'alias' as pymilvus sets it internally
        filtered_kwargs = {k: v for k, v in kwargs.items() if k != "alias"}

        self._milvusclient_config = {
            "uri": uri,
            "token": token,
            "kwargs": filtered_kwargs,
        }

        # Set _async_milvusclient to None for lazy initialization
        self._async_milvusclient = None  # type: ignore

    @property
    def aclient(self) -> AsyncMilvusClient:
        """
        Get async client (lazily created on first access).

        This property creates the AsyncMilvusClient only when needed,
        allowing synchronous operations to work without an event loop.
        """
        if self._async_milvusclient is None:
            self._async_milvusclient = AsyncMilvusClient(
                uri=self._milvusclient_config["uri"],
                token=self._milvusclient_config["token"],
                **self._milvusclient_config["kwargs"],
            )
        return self._async_milvusclient


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
                - url: Milvus connection URL with optional db_name path
                  (e.g., "http://localhost:19530/mydb" or "http://localhost:19530")
                - username: Optional username for authentication
                - password: Optional password for authentication
                - indexStrategy: Index/collection naming strategy
                - ext: Additional config (e.g., dim for vector dimension, db_name)

        Authentication:
            If both username and password are provided, they are concatenated
            as "{username}:{password}" to form the token.

        Database Name:
            The db_name can be specified in three ways (in order of priority):
            1. ext.db_name - explicit db_name in ext config
            2. URL path - e.g., "http://localhost:19530/mydb"
            3. Default - "default" if not specified
        """
        super().__init__(config)

        # Get vector dimension from ext (default: 1536 for OpenAI embeddings)
        self.dim = self.ext.get("dim", DEFAULT_EMBEDDING_DIM)

        # Build token for authentication: username:password
        if self.username and self.password:
            self.token = f"{self.username}:{self.password}"
        else:
            self.token = ""

        # Parse db_name from URL or ext config
        # pymilvus requires db_name as a separate parameter, not in URL path
        self.db_name, self.base_url = self._parse_db_name_from_url(self.url)

    def _parse_db_name_from_url(self, url: str) -> tuple:
        """
        Parse db_name from URL path and return base URL without db_name.

        Milvus requires db_name as a separate parameter, not in the URL path.
        This method extracts db_name from URL like "http://host:port/dbname"
        and returns the base URL "http://host:port".

        Priority for db_name:
        1. ext.db_name - explicit config takes highest priority
        2. URL path - extracted from URL if present
        3. Default - "default" if not specified

        Args:
            url: Milvus connection URL (e.g., "http://localhost:19530/mydb")

        Returns:
            Tuple of (db_name, base_url)
        """
        from urllib.parse import urlparse, urlunparse

        # Priority 1: Check ext.db_name first
        if self.ext.get("db_name"):
            return self.ext["db_name"], url

        # Priority 2: Parse from URL path
        if not url:
            return "default", url

        parsed = urlparse(url)

        # Extract db_name from path (e.g., "/mydb" -> "mydb")
        path = parsed.path.strip("/")

        if path:
            # Has path component - use it as db_name
            db_name = path
            # Rebuild URL without the path
            base_url = urlunparse(
                (parsed.scheme, parsed.netloc, "", parsed.params, parsed.query, "")
            )
            return db_name, base_url
        else:
            # No path - use default db_name
            return "default", url

    @staticmethod
    def _sanitize_filter_value(value: str) -> str:
        """
        Sanitize a string value for use in Milvus filter expressions.

        Escapes backslashes and double quotes to prevent expression injection.

        Args:
            value: The string value to sanitize

        Returns:
            Sanitized string safe for use in filter expressions
        """
        return value.replace("\\", "\\\\").replace('"', '\\"')

    def _get_client(self) -> MilvusClient:
        """
        Create a MilvusClient instance.

        Uses base_url (without db_name path) and passes db_name as separate parameter.

        Returns:
            MilvusClient instance for direct Milvus operations
        """
        return MilvusClient(uri=self.base_url, token=self.token, db_name=self.db_name)

    def create_vector_store(
        self,
        collection_name: str,
        retrieval_mode: str = "vector",
        dim: Optional[int] = None,
    ) -> MilvusVectorStore:
        """
        Create Milvus vector store instance.

        Uses base_url (without db_name path) and passes db_name as separate parameter.

        Args:
            collection_name: Name of the collection
            retrieval_mode: Retrieval mode - 'vector', 'keyword', or 'hybrid'
            dim: Optional embedding dimension. If provided, overrides self.dim.
                 This allows dynamic dimension based on the actual embedding model.

        Returns:
            MilvusVectorStore instance
        """
        # Use provided dim if available, otherwise fall back to configured dim
        effective_dim = dim if dim is not None else self.dim

        logger.info(
            f"[Milvus] create_vector_store: collection={collection_name}, "
            f"dim_param={dim}, self.dim={self.dim}, effective_dim={effective_dim}"
        )

        return LazyAsyncMilvusVectorStore(
            uri=self.base_url,
            token=self.token,
            db_name=self.db_name,
            collection_name=collection_name,
            dim=effective_dim,
            upsert_mode=True,
            overwrite=False,  # Do not overwrite existing collection
            enable_sparse=True,  # Enable sparse vector for keyword/hybrid search
            hybrid_ranker="RRFRanker",  # Use RRF for hybrid search ranking
        )

    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        chunk_metadata: ChunkMetadata,
        embed_model,
        **kwargs,
    ) -> Dict:
        """
        Index nodes into Milvus.

        Note: Metadata is already applied to nodes by the indexer layer via
        chunk_metadata.apply_to_nodes() before calling this method.

        This method automatically uses the embedding dimension from the embed_model
        if available (via _dimension attribute set from Model CRD's embeddingConfig).
        This ensures the Milvus collection schema matches the actual embedding vectors.

        Args:
            nodes: List of nodes to index (metadata already applied)
            chunk_metadata: ChunkMetadata instance containing document metadata
            embed_model: Embedding model (may have _dimension attribute from Model CRD)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            Indexing result dict
        """
        # Get collection name
        collection_name = self.get_index_name(chunk_metadata.knowledge_id, **kwargs)

        # Get embedding dimension from embed_model if available
        # CustomEmbedding stores dimension in _dimension attribute (set from Model CRD)
        embed_dim = getattr(embed_model, "_dimension", None)
        if embed_dim:
            logger.info(f"[Milvus] Using embedding dimension from model: {embed_dim}")

        # Create vector store with detected dimension (or fall back to configured dim)
        vector_store = self.create_vector_store(collection_name, dim=embed_dim)

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

        Note on score_threshold:
        - For vector search: score_threshold is applied (cosine similarity 0-1)
        - For keyword search: score_threshold is applied (BM25 scores vary)
        - For hybrid search: score_threshold is IGNORED because RRF scores are
          in a different range (typically 0.01-0.05) and ranking is already
          optimized by the fusion algorithm

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1, ignored for hybrid)
                - retrieval_mode: Optional 'vector'/'keyword'/'hybrid' (default: 'vector')
            metadata_condition: Optional metadata filtering
            **kwargs: Additional parameters

        Returns:
            Retrieval result dict
        """
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        # Increased default top_k from 5 to 20 for better RAG coverage
        top_k = retrieval_setting.get("top_k", DEFAULT_TOP_K)
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

        # Debug logging for hybrid search troubleshooting
        logger.debug(
            f"[Milvus] retrieve: mode={retrieval_mode}, query_mode={query_mode}, "
            f"sparse_embedding_function={type(vector_store.sparse_embedding_function)}, "
            f"enable_sparse={vector_store.enable_sparse}"
        )

        # Execute query
        result = vector_store.query(vs_query)

        # Debug logging for query results
        logger.debug(
            f"[Milvus] query result: nodes_count={len(result.nodes) if result.nodes else 0}, "
            f"similarities={result.similarities[:5] if result.similarities else None}"
        )

        # Process results
        # For hybrid search, skip score_threshold because RRF scores are in a different
        # range (0.01-0.05) and the ranking is already optimized by the fusion algorithm
        effective_threshold = 0.0 if retrieval_mode == "hybrid" else score_threshold
        return self._process_query_results(result, effective_threshold)

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
            score_threshold: Minimum relevance score (0-1).
                            For hybrid search, this should be set to 0.0 because
                            RRF scores are in a different range (0.01-0.05).

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

            # Apply score threshold filter
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
                MetadataFilter(
                    key="doc_ref", value=doc_ref, operator=FilterOperator.EQ
                ),
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
        client = None

        try:
            # Create MilvusClient for direct query
            client = self._get_client()

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

            # Sanitize knowledge_id to prevent expression injection
            safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
            filter_expr = f'knowledge_id == "{safe_knowledge_id}"'

            # Query all records with matching knowledge_id
            # Note: Milvus requires specifying output fields
            results = client.query(
                collection_name=collection_name,
                filter=filter_expr,
                output_fields=["doc_ref", "source_file", "created_at", "chunk_index"],
                limit=MAX_QUERY_LIMIT,
            )

            # Warn if results may be truncated
            if len(results) >= MAX_QUERY_LIMIT:
                logger.warning(
                    f"[Milvus] Knowledge base {knowledge_id} has >= {MAX_QUERY_LIMIT} "
                    "chunks; document listing may be incomplete."
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
        finally:
            # Ensure client is closed to avoid connection leaks
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def test_connection(self) -> bool:
        """
        Test connection to Milvus.

        Returns:
            True if connection successful, False otherwise
        """
        client = None
        try:
            client = self._get_client()
            # Try to list collections as a connection test
            client.list_collections()
            return True
        except Exception:
            return False
        finally:
            # Ensure client is closed to avoid connection leaks
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def get_all_chunks(
        self, knowledge_id: str, max_chunks: int = MAX_QUERY_LIMIT, **kwargs
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
        client = None

        try:
            # Create MilvusClient for direct query
            client = self._get_client()

            # Check if collection exists
            collections = client.list_collections()
            if collection_name not in collections:
                return []

            # Sanitize knowledge_id to prevent expression injection
            safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
            filter_expr = f'knowledge_id == "{safe_knowledge_id}"'

            # Query all records with matching knowledge_id
            results = client.query(
                collection_name=collection_name,
                filter=filter_expr,
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
        finally:
            # Ensure client is closed to avoid connection leaks
            if client:
                try:
                    client.close()
                except Exception:
                    pass

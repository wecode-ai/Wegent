# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Legacy Milvus storage adapter.

This is the implementation the online main branch shipped for a Retriever whose
``storageConfig.type`` is ``milvus``: collections named by the shared index
strategy, real collections built by the LlamaIndex Milvus store plus a
parent-node sidecar, and the delete-then-index lifecycle the business layer
drives. It is restored frozen; only its routing, its adaptation to the current
public storage interface and the mechanical split across the modules beside it
distinguish it from that source.

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
from llama_index.core.vector_stores import MetadataFilters
from llama_index.core.vector_stores.types import (
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.milvus import MilvusVectorStore
from llama_index.vector_stores.milvus.base import _to_milvus_filter
from pymilvus import MilvusClient

from knowledge_engine.retrieval.filters import parse_metadata_filters
from knowledge_engine.retrieval.search_hints import resolve_search_queries
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_legacy.constants import (
    DEFAULT_EMBEDDING_DIM,
    DEFAULT_TOP_K,
    MAX_QUERY_LIMIT,
)
from knowledge_engine.storage.milvus_legacy.documents import LegacyMilvusDocumentReads
from knowledge_engine.storage.milvus_legacy.lazy_store import LazyAsyncMilvusVectorStore
from knowledge_engine.storage.milvus_legacy.parent_store import LegacyMilvusParentStore
from shared.models import RetrievalScope

logger = logging.getLogger(__name__)


class LegacyMilvusBackend(
    LegacyMilvusDocumentReads,
    LegacyMilvusParentStore,
    BaseStorageBackend,
):
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
    supports_retrieval_scope: ClassVar[bool] = True

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

    def _resolve_hybrid_ranker(self) -> str:
        """
        Resolve the hybrid ranker with WeightedRanker as the default.

        RRFRanker remains available as an explicit compatibility opt-out.
        """
        configured_ranker = self.ext.get("hybrid_ranker")
        if configured_ranker == "RRFRanker":
            return configured_ranker
        if configured_ranker == "WeightedRanker":
            return configured_ranker
        return "WeightedRanker"

    def _resolve_hybrid_ranker_params(
        self,
        retrieval_setting: Optional[Dict[str, Any]] = None,
        *,
        configured_ranker: Optional[str] = None,
    ) -> Dict[str, Any]:
        configured_ranker = configured_ranker or self._resolve_hybrid_ranker()
        configured_params = dict(self.ext.get("hybrid_ranker_params") or {})

        if configured_ranker != "WeightedRanker":
            return configured_params

        vector_weight = (
            retrieval_setting.get("vector_weight")
            if retrieval_setting is not None
            else None
        )
        keyword_weight = (
            retrieval_setting.get("keyword_weight")
            if retrieval_setting is not None
            else None
        )
        if vector_weight is not None and keyword_weight is not None:
            total = vector_weight + keyword_weight
            if total > 0:
                normalized_weights = [
                    float(vector_weight) / float(total),
                    float(keyword_weight) / float(total),
                ]
                logger.info(
                    "[Milvus] Using WeightedRanker params from retrieval weights: weights=%s",
                    normalized_weights,
                )
                return {"weights": normalized_weights}

        return configured_params

    def create_vector_store(
        self,
        collection_name: str,
        retrieval_mode: str = "vector",
        dim: Optional[int] = None,
        retrieval_setting: Optional[Dict[str, Any]] = None,
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

        hybrid_ranker = self._resolve_hybrid_ranker()
        hybrid_ranker_params = self._resolve_hybrid_ranker_params(
            retrieval_setting,
            configured_ranker=hybrid_ranker,
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
            hybrid_ranker=hybrid_ranker,
            hybrid_ranker_params=hybrid_ranker_params,
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

        nodes_for_embedding = self.prepare_nodes_for_embedding(nodes)
        VectorStoreIndex(
            nodes_for_embedding,
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
        scope: Optional[RetrievalScope] = None,
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
        vector_store = self.create_vector_store(
            collection_name,
            retrieval_mode,
            retrieval_setting=retrieval_setting,
        )

        filters = self._build_metadata_filters(knowledge_id, metadata_condition)
        native_filter_expr = self._build_scoped_native_filter_expr(
            scope=scope,
            metadata_filters=filters,
        )
        query_filters = None if native_filter_expr else filters

        # Determine query mode and parameters
        resolved_queries = resolve_search_queries(query, retrieval_setting)
        if retrieval_mode == "keyword":
            # Pure BM25 keyword search - no embedding needed
            query_mode = VectorStoreQueryMode.TEXT_SEARCH
            query_embedding = None
            query_str = resolved_queries.sparse_query
        elif retrieval_mode == "hybrid":
            # Hybrid search - needs embedding
            query_mode = VectorStoreQueryMode.HYBRID
            query_embedding = embed_model.get_query_embedding(
                resolved_queries.dense_query
            )
            query_str = resolved_queries.sparse_query
        else:
            # Default: Pure vector search
            query_mode = VectorStoreQueryMode.DEFAULT
            query_embedding = embed_model.get_query_embedding(
                resolved_queries.dense_query
            )
            query_str = resolved_queries.dense_query

        # Create VectorStoreQuery
        vs_query = VectorStoreQuery(
            query_str=query_str,
            query_embedding=query_embedding,
            similarity_top_k=top_k,
            mode=query_mode,
            filters=query_filters,
        )

        logger.info(
            "[Milvus] retrieve: collection=%s, mode=%s, query_mode=%s, top_k=%s, score_threshold=%s, effective_threshold=%s, hybrid_ranker=%s, hybrid_ranker_params=%s, dense_query=%s, sparse_query=%s",
            collection_name,
            retrieval_mode,
            query_mode,
            top_k,
            score_threshold,
            0.0 if retrieval_mode == "hybrid" else score_threshold,
            getattr(vector_store, "hybrid_ranker", None),
            getattr(vector_store, "hybrid_ranker_params", None),
            resolved_queries.dense_query,
            query_str,
        )

        # Debug logging for hybrid search troubleshooting
        logger.debug(
            f"[Milvus] retrieve: mode={retrieval_mode}, query_mode={query_mode}, "
            f"sparse_embedding_function={type(vector_store.sparse_embedding_function)}, "
            f"enable_sparse={vector_store.enable_sparse}"
        )

        # Execute query
        query_kwargs = {"string_expr": native_filter_expr} if native_filter_expr else {}
        result = vector_store.query(vs_query, **query_kwargs)

        logger.info(
            "[Milvus] query result: collection=%s, nodes_count=%d, top_scores=%s",
            collection_name,
            len(result.nodes) if result.nodes else 0,
            result.similarities[:5] if result.similarities else None,
        )

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

    def _build_scoped_native_filter_expr(
        self,
        *,
        scope: Optional[RetrievalScope],
        metadata_filters: MetadataFilters,
    ) -> str:
        if not scope or not scope.document_ids:
            return ""

        metadata_expr = _to_milvus_filter(metadata_filters)
        doc_refs = [
            f'"{self._sanitize_filter_value(str(doc_id))}"'
            for doc_id in scope.document_ids
        ]
        doc_scope_expr = f"doc_ref in [{', '.join(doc_refs)}]"

        expressions = []
        if metadata_expr:
            expressions.append(self._parenthesize_filter_expr(metadata_expr))
        expressions.append(doc_scope_expr)
        return " and ".join(expressions)

    @staticmethod
    def _parenthesize_filter_expr(expression: str) -> str:
        normalized = expression.strip()
        if normalized.startswith("(") and normalized.endswith(")"):
            return normalized
        if " and " in normalized or " or " in normalized:
            return f"({normalized})"
        return normalized

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
                        "content": self.get_node_display_text(node),
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
        self.delete_parent_nodes(knowledge_id, doc_ref, **kwargs)

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_count,
            "status": "deleted",
        }

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete all chunks and parent nodes for a knowledge base."""
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        parent_collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = None

        try:
            client = self._get_client()
            deleted_chunks = self._delete_collection_by_knowledge_id(
                client,
                collection_name,
                knowledge_id,
            )
            deleted_parent_nodes = self._delete_collection_by_knowledge_id(
                client,
                parent_collection_name,
                knowledge_id,
            )
            return {
                "knowledge_id": knowledge_id,
                "deleted_chunks": deleted_chunks,
                "deleted_parent_nodes": deleted_parent_nodes,
                "status": "deleted",
            }
        finally:
            if client:
                try:
                    client.close()
                except Exception:
                    pass

    def _delete_collection_by_knowledge_id(
        self,
        client: MilvusClient,
        collection_name: str,
        knowledge_id: str,
    ) -> int:
        if not client.has_collection(collection_name):
            return 0

        safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
        results = client.query(
            collection_name=collection_name,
            filter=f'knowledge_id == "{safe_knowledge_id}"',
            output_fields=["doc_ref"],
            limit=MAX_QUERY_LIMIT,
        )
        client.delete(
            collection_name=collection_name,
            filter=f'knowledge_id == "{safe_knowledge_id}"',
        )
        return len(results)

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing collection for a dedicated KB strategy."""
        self._ensure_can_drop_physical_index()
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        parent_collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = None

        try:
            client = self._get_client()
            dropped_parent_collection = False

            if client.has_collection(collection_name):
                client.drop_collection(collection_name=collection_name)

            if client.has_collection(parent_collection_name):
                client.drop_collection(collection_name=parent_collection_name)
                dropped_parent_collection = True

            return {
                "knowledge_id": knowledge_id,
                "collection_name": collection_name,
                "dropped_parent_collection": dropped_parent_collection,
                "status": "dropped",
            }
        finally:
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

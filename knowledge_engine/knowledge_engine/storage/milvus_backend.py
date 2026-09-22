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

import json
import logging
from typing import Any, ClassVar, Dict, List, Optional

from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.schema import BaseNode, MetadataMode
from llama_index.core.vector_stores import MetadataFilter, MetadataFilters
from llama_index.core.vector_stores.types import (
    FilterOperator,
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.milvus import MilvusVectorStore
from llama_index.vector_stores.milvus.base import IndexManagement, _to_milvus_filter
from pymilvus import AsyncMilvusClient, MilvusClient

from knowledge_engine.embedding.contract import (
    ensure_vector_contract,
    is_positive_int,
    resolve_declared_dimension,
)
from knowledge_engine.embedding.errors import EmbeddingResponseFormatError
from knowledge_engine.retrieval.filters import (
    filter_chunk_records,
    parse_metadata_filters,
)
from knowledge_engine.retrieval.search_hints import resolve_search_queries
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_dimension import (
    CollectionSnapshot,
    embedding_model_name,
    raise_on_dimension_mismatch,
    read_collection_snapshot,
)
from shared.models import RetrievalScope

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

        The returned client shares the process-global Milvus alias derived from
        url/token/db_name, so it must never be closed: closing it would drop the
        alias for every other client, including parallel writers.

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
        embed_model: BaseEmbedding,
        **kwargs,
    ) -> Dict:
        """
        Index nodes into Milvus.

        Note: Metadata is already applied to nodes by the indexer layer via
        chunk_metadata.apply_to_nodes() before calling this method.

        This adapter writes nothing until the embedding dimension contract is
        resolved, so the collection it creates or appends to always matches the
        embedding vectors. The first real batch of document vectors is the
        evidence for that decision, and it is reused by the write instead of
        being requested twice. Models that never declared a dimension keep
        working: that same batch decides the dimension of their collection.

        Args:
            nodes: List of nodes to index (metadata already applied)
            chunk_metadata: ChunkMetadata instance containing document metadata
            embed_model: Embedding model (may declare a dimension from Model CRD)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            Indexing result dict
        """
        # Get collection name
        collection_name = self.get_index_name(chunk_metadata.knowledge_id, **kwargs)

        nodes_for_embedding = self.prepare_nodes_for_embedding(nodes)
        embeddable_nodes = self._embeddable_nodes(nodes_for_embedding)
        if not embeddable_nodes:
            # No vector can decide the collection dimension, so this write must
            # not create a collection from the configured default dimension.
            logger.info(
                "[Milvus] index_with_metadata: collection=%s carries no embeddable "
                "content; nothing to write",
                collection_name,
            )
            return {
                "indexed_count": 0,
                "index_name": collection_name,
                "status": "success",
            }

        # Resolve the contract before this adapter writes anything.
        embed_dim = self._resolve_write_dimension(
            embeddable_nodes,
            embed_model,
            collection_name,
        )
        if embed_dim is not None:
            snapshot = self._collection_snapshot(collection_name)
            if snapshot.exists:
                raise_on_dimension_mismatch(
                    stored_dim=snapshot.dimension,
                    expected_dim=embed_dim,
                    model=embedding_model_name(embed_model),
                )

        logger.info(
            f"[Milvus] index_with_metadata: collection={collection_name}, "
            f"dimension={embed_dim}, embeddable_nodes={len(embeddable_nodes)}, "
            f"prepared_nodes={len(nodes_for_embedding)}"
        )

        # Create vector store with the resolved dimension
        vector_store = self.create_vector_store(collection_name, dim=embed_dim)

        # Index nodes using LlamaIndex
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        VectorStoreIndex(
            embeddable_nodes,
            storage_context=storage_context,
            embed_model=embed_model,
            show_progress=True,
        )

        return {
            "indexed_count": len(embeddable_nodes),
            "index_name": collection_name,
            "status": "success",
        }

    def _resolve_write_dimension(
        self,
        nodes: List[BaseNode],
        embed_model: BaseEmbedding,
        collection_name: str,
    ) -> Optional[int]:
        """Resolve the dimension a write must use, embedding the first batch once."""
        declared_dim = resolve_declared_dimension(embed_model)
        batch_dim = self._embed_first_batch(
            nodes,
            embed_model,
            declared_dim=declared_dim,
        )
        if declared_dim is None and batch_dim:
            logger.warning(
                "[Milvus] Compatibility path: embedding model '%s' declares no "
                "dimension; collection %s is created from the first document batch "
                "(%s dimensions)",
                embedding_model_name(embed_model),
                collection_name,
                batch_dim,
            )
        return declared_dim or batch_dim

    def _embed_first_batch(
        self,
        nodes: List[BaseNode],
        embed_model: BaseEmbedding,
        *,
        declared_dim: Optional[int],
    ) -> Optional[int]:
        """
        Embed the first real document batch and reuse it for the write.

        Args:
            nodes: Prepared nodes that are about to be indexed
            embed_model: Embedding model that produces the document vectors
            declared_dim: Dimension the model declares, when it declares one

        Returns:
            Dimension carried by the first batch, or None when there is nothing
            to embed. The vectors are attached to the nodes so the write reuses
            them instead of asking the provider twice.

        Raises:
            EmbeddingResponseFormatError: When the provider does not return one
                usable vector per text.
            EmbeddingDimensionMismatchError: When a returned vector breaks the
                dimension the model declares.
        """
        # Only nodes with content reach the provider; the rest are dropped by the
        # index write anyway, and their placeholder responses must not decide the
        # dimension of the collection.
        embeddable = self._embeddable_nodes(nodes)
        batch = embeddable[: self._first_batch_size(embeddable, embed_model)]
        if not batch:
            return None

        vectors = embed_model.get_text_embedding_batch(
            [node.get_content(metadata_mode=MetadataMode.EMBED) for node in batch]
        )
        model = embedding_model_name(embed_model)
        if len(vectors) != len(batch) or not vectors or not vectors[0]:
            raise EmbeddingResponseFormatError(
                f"Embedding model '{model}' returned {len(vectors)} vectors for "
                f"{len(batch)} texts"
            )

        ensure_vector_contract(
            model=model,
            declared=declared_dim,
            vectors=vectors,
        )
        dimension = len(vectors[0])
        if any(len(vector) != dimension for vector in vectors):
            raise EmbeddingResponseFormatError(
                f"Embedding model '{model}' returned vectors of mixed dimensions"
            )

        for node, vector in zip(batch, vectors):
            node.embedding = vector

        return dimension

    @staticmethod
    def _first_batch_size(nodes: List[BaseNode], embed_model: BaseEmbedding) -> int:
        """Return how many nodes belong to the first provider batch."""
        batch_size = getattr(embed_model, "embed_batch_size", None)
        if is_positive_int(batch_size):
            return batch_size
        return len(nodes)

    @staticmethod
    def _embeddable_nodes(nodes: List[BaseNode]) -> List[BaseNode]:
        """Return the nodes that carry retrieval text and reach the provider.

        Metadata alone never makes a node embeddable: embedding it would send a
        metadata-only text and let the configured default dimension create the
        collection this guard exists to prevent.
        """
        return [
            node
            for node in nodes
            if node.get_content(metadata_mode=MetadataMode.NONE).strip()
        ]

    def _collection_snapshot(self, collection_name: str) -> CollectionSnapshot:
        """Read the collection once through a client on the shared alias."""
        return read_collection_snapshot(self._get_client(), collection_name)

    def _open_query_collection(
        self,
        *,
        collection_name: str,
        declared_dim: Optional[int],
        embed_model: BaseEmbedding,
    ) -> Optional[CollectionSnapshot]:
        """
        Return the snapshot a query may read.

        Returns:
            None when the collection does not exist, because a query must never
            create the collection it reads.

        Raises:
            CollectionDimensionMismatchError: When the collection stores another
                dimension than the one the embedding model declares.
        """
        snapshot = self._collection_snapshot(collection_name)
        if not snapshot.exists:
            logger.info(
                "[Milvus] retrieve: collection %s does not exist; returning no records",
                collection_name,
            )
            return None

        if declared_dim is not None:
            raise_on_dimension_mismatch(
                stored_dim=snapshot.dimension,
                expected_dim=declared_dim,
                model=embedding_model_name(embed_model),
            )
        return snapshot

    @staticmethod
    def _build_parent_node_filter_expr(knowledge_id: str, doc_ref: str) -> str:
        safe_knowledge_id = MilvusBackend._sanitize_filter_value(knowledge_id)
        safe_doc_ref = MilvusBackend._sanitize_filter_value(doc_ref)
        return f'knowledge_id == "{safe_knowledge_id}" and doc_ref == "{safe_doc_ref}"'

    def _delete_parent_nodes_with_client(
        self,
        client: MilvusClient,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
    ) -> int:
        if not client.has_collection(collection_name):
            return 0

        filter_expr = self._build_parent_node_filter_expr(knowledge_id, doc_ref)
        try:
            client.delete(collection_name=collection_name, filter=filter_expr)
        except TypeError:
            client.delete(collection_name=collection_name, expr=filter_expr)
        return 0

    def delete_parent_nodes(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        return self._delete_parent_nodes_with_client(
            self._get_client(),
            collection_name,
            knowledge_id,
            doc_ref,
        )

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model: BaseEmbedding,
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

        # A query never creates the collection it reads, and vector/hybrid
        # queries need vectors matching the dimension the collection stores.
        # Keyword queries never touch the vector field, so they stay available.
        declared_dim = (
            None
            if retrieval_mode == "keyword"
            else resolve_declared_dimension(embed_model)
        )
        snapshot = self._open_query_collection(
            collection_name=collection_name,
            declared_dim=declared_dim,
            embed_model=embed_model,
        )
        if snapshot is None:
            return {"records": []}

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

        if declared_dim is None and query_embedding is not None:
            # A model that never declared a dimension still has to match what the
            # collection stores, so the real query vector is compared before the query.
            query_dimension = len(query_embedding)
            if is_positive_int(query_dimension):
                raise_on_dimension_mismatch(
                    stored_dim=snapshot.dimension,
                    expected_dim=query_dimension,
                    model=embedding_model_name(embed_model),
                )

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

    def delete_document(
        self,
        knowledge_id: str,
        doc_ref: str,
        **kwargs,
    ) -> Dict:
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
        if not self._collection_snapshot(collection_name).exists:
            # Constructing a vector store would create the collection with the
            # configured default dimension, so a missing collection only has
            # parent nodes left to delete.
            self.delete_parent_nodes(knowledge_id, doc_ref, **kwargs)
            return {
                "doc_ref": doc_ref,
                "knowledge_id": knowledge_id,
                "deleted_chunks": 0,
                "status": "deleted",
            }

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

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing collection for a dedicated KB strategy."""
        self._ensure_can_drop_physical_index()
        collection_name = self.get_index_name(knowledge_id, **kwargs)
        parent_collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
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
        if not self._collection_snapshot(collection_name).exists:
            # Constructing a vector store would create the collection with the
            # configured default dimension, so report the document as missing.
            raise ValueError(f"Document {doc_ref} not found")

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
                    "content": self.get_node_display_text(node),
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

    def save_parent_nodes(
        self,
        knowledge_id: str,
        parent_nodes: List[BaseNode],
        **kwargs,
    ) -> Dict[str, Any]:
        if not parent_nodes:
            return {"stored_count": 0}

        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = self._get_client()

        if not client.has_collection(collection_name):
            client.create_collection(
                collection_name=collection_name,
                dimension=1,
                auto_id=True,
                enable_dynamic_field=True,
            )
        else:
            self._delete_parent_nodes_with_client(
                client,
                collection_name,
                knowledge_id,
                parent_nodes[0].metadata.get("doc_ref", ""),
            )

        client.insert(
            collection_name=collection_name,
            data=[
                {
                    "vector": [0.0],
                    "parent_node_id": node.node_id,
                    "knowledge_id": knowledge_id,
                    "doc_ref": node.metadata.get("doc_ref"),
                    "source_file": node.metadata.get("source_file"),
                    "content": self.get_node_display_text(node),
                    "title": node.metadata.get("source_file", ""),
                    "metadata_json": json.dumps(node.metadata),
                }
                for node in parent_nodes
            ],
        )
        return {"stored_count": len(parent_nodes)}

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

    def get_parent_nodes(
        self,
        knowledge_id: str,
        parent_node_ids: List[str],
        **kwargs,
    ) -> Dict[str, Dict[str, Any]]:
        if not parent_node_ids:
            return {}

        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = self._get_client()

        if not client.has_collection(collection_name):
            return {}

        parent_records: Dict[str, Dict[str, Any]] = {}
        safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
        for parent_node_id in parent_node_ids:
            safe_parent_node_id = self._sanitize_filter_value(parent_node_id)
            results = client.query(
                collection_name=collection_name,
                filter=(
                    f'knowledge_id == "{safe_knowledge_id}" and '
                    f'parent_node_id == "{safe_parent_node_id}"'
                ),
                output_fields=[
                    "parent_node_id",
                    "content",
                    "title",
                    "metadata_json",
                ],
                limit=1,
            )
            if not results:
                continue
            record = results[0]
            parent_records[parent_node_id] = {
                "content": record.get("content", ""),
                "title": record.get("title", ""),
                "metadata": json.loads(record.get("metadata_json") or "{}"),
            }
        return parent_records

    def test_connection(self) -> bool:
        """
        Test connection to Milvus.

        Returns:
            True if connection successful, False otherwise
        """
        try:
            # Try to list collections as a connection test
            self._get_client().list_collections()
            return True
        except Exception:
            return False

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = MAX_QUERY_LIMIT,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
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
                    "display_text",
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
                        "content": self.get_display_text_from_metadata(
                            record,
                            fallback=self.extract_chunk_text(raw_content),
                        ),
                        "title": record.get("source_file", ""),
                        "chunk_id": record.get("chunk_index", 0),
                        "doc_ref": record.get("doc_ref", ""),
                        "metadata": record,
                    }
                )

            # Sort by doc_ref and chunk_index
            chunks.sort(key=lambda x: (x.get("doc_ref", ""), x.get("chunk_id", 0)))

            filtered_chunks = filter_chunk_records(chunks, metadata_condition)
            return filtered_chunks[:max_chunks]

        except Exception as e:
            logger.warning(
                f"[Milvus] Failed to get all chunks for KB {knowledge_id}: {e}"
            )
            return []

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Elasticsearch storage backend implementation.

Supported retrieval modes:
- vector: Pure vector similarity search using embeddings
- keyword: Pure BM25 keyword search (full-text search)
- hybrid: Combined vector + BM25 search with configurable weights
"""

import logging
from typing import Any, ClassVar, Dict, List, Optional

from elasticsearch import Elasticsearch, helpers
from elasticsearch.helpers.vectorstore._async.strategies import (
    AsyncBM25Strategy,
    AsyncDenseVectorStrategy,
)
from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.schema import BaseNode
from llama_index.core.vector_stores import ExactMatchFilter, MetadataFilters
from llama_index.core.vector_stores.types import (
    VectorStoreQuery,
    VectorStoreQueryMode,
)
from llama_index.vector_stores.elasticsearch import ElasticsearchStore

from knowledge_engine.retrieval.filters import (
    filter_chunk_records,
    parse_metadata_filters,
)
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from shared.telemetry.decorators import add_span_event

logger = logging.getLogger(__name__)


class ElasticsearchBackend(BaseStorageBackend):
    """
    Elasticsearch storage backend implementation.

    Supported retrieval modes:
    - vector: Pure vector similarity search (default)
    - keyword: Pure BM25 keyword search
    - hybrid: Combined vector + BM25 search

    Class Attributes:
        SUPPORTED_RETRIEVAL_METHODS: List of supported retrieval method names
    """

    # Class-level constant defining supported retrieval methods
    SUPPORTED_RETRIEVAL_METHODS: ClassVar[List[str]] = ["vector", "keyword", "hybrid"]

    # Uses default INDEX_PREFIX = "index" from base class

    def __init__(self, config: Dict):
        """Initialize Elasticsearch backend."""
        super().__init__(config)

        # Build connection kwargs for native Elasticsearch client
        # (used in list_documents and test_connection)
        self.es_kwargs = {}
        if self.username and self.password:
            self.es_kwargs["basic_auth"] = (self.username, self.password)
        elif self.api_key:
            self.es_kwargs["api_key"] = self.api_key

        # Build connection kwargs for LlamaIndex ElasticsearchStore
        # Note: ElasticsearchStore uses different parameter names (es_user, es_password, es_api_key)
        self.llama_es_kwargs = {}
        if self.username and self.password:
            self.llama_es_kwargs["es_user"] = self.username
            self.llama_es_kwargs["es_password"] = self.password
        elif self.api_key:
            self.llama_es_kwargs["es_api_key"] = self.api_key

    def create_vector_store(
        self, index_name: str, retrieval_mode: str = "vector"
    ) -> ElasticsearchStore:
        """
        Create Elasticsearch vector store with appropriate retrieval strategy.

        Args:
            index_name: Index name
            retrieval_mode: Retrieval mode - 'vector', 'keyword', or 'hybrid'
                - 'vector': Pure dense vector search (default)
                - 'keyword': Pure BM25 text search
                - 'hybrid': Combined vector + BM25 search

        Returns:
            ElasticsearchStore instance configured for the specified mode
        """
        # Select retrieval strategy based on mode
        if retrieval_mode == "keyword":
            # Pure BM25 keyword search
            retrieval_strategy = AsyncBM25Strategy()
        elif retrieval_mode == "hybrid":
            # Hybrid search: vector + BM25 with linear combination
            # Note: rrf=False uses linear combination instead of RRF fusion
            # RRF requires Elasticsearch paid license (Platinum/Enterprise)
            retrieval_strategy = AsyncDenseVectorStrategy(
                hybrid=True, rrf=False, text_field="content"
            )
        else:
            # Default: Pure vector search
            retrieval_strategy = AsyncDenseVectorStrategy(hybrid=False)

        return ElasticsearchStore(
            index_name=index_name,
            es_url=self.url,
            retrieval_strategy=retrieval_strategy,
            **self.llama_es_kwargs,
        )

    def index_with_metadata(
        self,
        nodes: List[BaseNode],
        chunk_metadata: ChunkMetadata,
        embed_model,
        **kwargs,
    ) -> Dict:
        """
        Index nodes into Elasticsearch.

        Note: Metadata is already applied to nodes by the indexer layer via
        chunk_metadata.apply_to_nodes() before calling this method.

        Args:
            nodes: List of nodes to index (metadata already applied)
            chunk_metadata: ChunkMetadata instance containing document metadata
            embed_model: Embedding model
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Note:
            We use 'doc_ref' in metadata to store our custom doc_xxx ID.
            LlamaIndex has its own internal 'document_id' field (ref_doc_id UUID).
        """
        add_span_event(
            "elasticsearch.index_with_metadata.started",
            {
                "knowledge_id": chunk_metadata.knowledge_id,
                "doc_ref": chunk_metadata.doc_ref,
                "source_file": chunk_metadata.source_file,
                "node_count": len(nodes),
            },
        )

        # Get index name
        index_name = self.get_index_name(chunk_metadata.knowledge_id, **kwargs)

        add_span_event(
            "elasticsearch.index_name_resolved",
            {
                "index_name": index_name,
                "knowledge_id": chunk_metadata.knowledge_id,
            },
        )

        # Index nodes
        vector_store = self.create_vector_store(index_name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        add_span_event(
            "elasticsearch.vector_store_created",
            {
                "index_name": index_name,
            },
        )

        VectorStoreIndex(
            nodes,
            storage_context=storage_context,
            embed_model=embed_model,
            show_progress=True,
        )

        add_span_event(
            "elasticsearch.index_with_metadata.completed",
            {
                "indexed_count": len(nodes),
                "index_name": index_name,
                "doc_ref": chunk_metadata.doc_ref,
                "status": "success",
            },
        )

        return {
            "indexed_count": len(nodes),
            "index_name": index_name,
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
        Retrieve nodes from Elasticsearch (Dify-style API).

        Uses LlamaIndex's VectorStoreQuery with different modes:
        - DEFAULT: Pure vector similarity search
        - TEXT_SEARCH: Pure BM25 keyword search
        - HYBRID: Combined vector + BM25 search

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1)
                - retrieval_mode: Optional 'vector'/'keyword'/'hybrid' (default: 'vector')
                - alpha: Optional weight for hybrid search (0=keyword only, 1=vector only, default: 0.7)
            metadata_condition: Optional metadata filtering
            **kwargs: Additional parameters

        Returns:
            Retrieval result dict
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        # Increased default top_k from 5 to 20 for better RAG coverage
        top_k = retrieval_setting.get("top_k", 20)
        score_threshold = retrieval_setting.get("score_threshold", 0.7)
        retrieval_mode = retrieval_setting.get("retrieval_mode", "vector")

        # Create vector store with appropriate retrieval strategy
        vector_store = self.create_vector_store(index_name, retrieval_mode)

        # Build metadata filters
        filters = self._build_metadata_filters(knowledge_id, metadata_condition)

        # Determine query mode and parameters
        if retrieval_mode == "keyword":
            # Pure BM25 keyword search - no embedding needed
            query_mode = VectorStoreQueryMode.TEXT_SEARCH
            query_embedding = None
            alpha = None
        elif retrieval_mode == "hybrid":
            # Hybrid search - needs embedding
            # alpha: 0 = pure keyword, 1 = pure vector, default 0.7 (70% vector)
            query_mode = VectorStoreQueryMode.HYBRID
            query_embedding = embed_model.get_query_embedding(query)
            # Convert vector_weight to alpha (they have the same meaning)
            alpha = retrieval_setting.get(
                "alpha", retrieval_setting.get("vector_weight", 0.7)
            )
        else:
            # Default: Pure vector search
            query_mode = VectorStoreQueryMode.DEFAULT
            query_embedding = embed_model.get_query_embedding(query)
            alpha = None

        # Create VectorStoreQuery
        vs_query = VectorStoreQuery(
            query_str=query,
            query_embedding=query_embedding,
            similarity_top_k=top_k,
            mode=query_mode,
            filters=filters,
            alpha=alpha,
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

        # Get max score for normalization (for keyword search scores may not be normalized)
        similarities = result.similarities or []
        if similarities:
            max_score = max((s for s in similarities if s is not None), default=1.0)
            if max_score == 0:
                max_score = 1.0
        else:
            max_score = 1.0

        # Process results (Dify-compatible format)
        results = []
        for i, node in enumerate(result.nodes):
            score = (
                similarities[i]
                if i < len(similarities) and similarities[i] is not None
                else 0.0
            )

            # Normalize score to 0-1 range if needed
            # For vector search, scores are already normalized (cosine similarity)
            # For keyword search, scores may need normalization
            if max_score > 1.0:
                normalized_score = score / max_score
            else:
                normalized_score = score

            if normalized_score >= score_threshold:
                results.append(
                    {
                        "content": node.text,
                        "score": float(normalized_score),
                        "title": node.metadata.get("source_file", ""),
                        "metadata": node.metadata,
                    }
                )

        return {"records": results}

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Delete document from Elasticsearch using LlamaIndex API.

        Uses delete_nodes with metadata filters to remove all chunks
        with matching doc_ref (doc_xxx format).

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Deletion result dict
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(index_name)

        # Build filters to match the document
        filters = self._build_doc_ref_filters(knowledge_id, doc_ref)

        # Get nodes first to count them
        nodes = vector_store.get_nodes(filters=filters)
        deleted_count = len(nodes)

        # Delete nodes using LlamaIndex API
        vector_store.delete_nodes(filters=filters)
        deleted_parent_nodes = self.delete_parent_nodes(knowledge_id, doc_ref, **kwargs)
        logger.info(
            "Deleted Elasticsearch document chunks: knowledge_id=%s doc_ref=%s "
            "index_name=%s user_id=%s deleted_chunks=%s deleted_parent_nodes=%s",
            knowledge_id,
            doc_ref,
            index_name,
            kwargs.get("user_id"),
            deleted_count,
            deleted_parent_nodes,
        )

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "index_name": index_name,
            "deleted_chunks": deleted_count,
            "deleted_parent_nodes": deleted_parent_nodes,
            "status": "deleted",
        }

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete all chunks and parent nodes for a knowledge base."""
        index_name = self.get_index_name(knowledge_id, **kwargs)
        parent_index_name = self.get_parent_store_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        deleted_chunks = 0
        deleted_parent_nodes = 0

        if es_client.indices.exists(index=index_name):
            deleted_chunks = self._delete_by_knowledge_id(
                es_client,
                index_name=index_name,
                knowledge_id=knowledge_id,
                knowledge_field="metadata.knowledge_id.keyword",
            )

        if es_client.indices.exists(index=parent_index_name):
            deleted_parent_nodes = self._delete_by_knowledge_id(
                es_client,
                index_name=parent_index_name,
                knowledge_id=knowledge_id,
                knowledge_field="knowledge_id.keyword",
            )

        return {
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "deleted_parent_nodes": deleted_parent_nodes,
            "status": "deleted",
        }

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing index for a dedicated KB strategy."""
        self._ensure_can_drop_physical_index()
        index_name = self.get_index_name(knowledge_id, **kwargs)
        parent_index_name = self.get_parent_store_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        if es_client.indices.exists(index=index_name):
            es_client.indices.delete(index=index_name)

        dropped_parent_index = False
        if es_client.indices.exists(index=parent_index_name):
            es_client.indices.delete(index=parent_index_name)
            dropped_parent_index = True

        return {
            "knowledge_id": knowledge_id,
            "index_name": index_name,
            "dropped_parent_index": dropped_parent_index,
            "status": "dropped",
        }

    def delete_parent_nodes(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        index_name = self.get_parent_store_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        if not es_client.indices.exists(index=index_name):
            return 0

        response = es_client.delete_by_query(
            index=index_name,
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": knowledge_id}},
                        {"term": {"doc_ref.keyword": doc_ref}},
                    ]
                }
            },
            refresh=True,
        )
        return int(response.get("deleted", 0))

    def _delete_by_knowledge_id(
        self,
        es_client: Elasticsearch,
        *,
        index_name: str,
        knowledge_id: str,
        knowledge_field: str,
    ) -> int:
        response = es_client.search(
            index=index_name,
            body={
                "size": 0,
                "track_total_hits": True,
                "query": {
                    "bool": {
                        "filter": [
                            {"term": {knowledge_field: knowledge_id}},
                        ]
                    }
                },
            },
        )
        total_hits = response.get("hits", {}).get("total", 0)
        deleted_count = (
            total_hits.get("value", 0)
            if isinstance(total_hits, dict)
            else int(total_hits)
        )
        es_client.delete_by_query(
            index=index_name,
            query={
                "bool": {
                    "filter": [
                        {"term": {knowledge_field: knowledge_id}},
                    ]
                }
            },
            refresh=True,
        )
        return int(deleted_count)

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Get document details from Elasticsearch using LlamaIndex API.

        Uses get_nodes with metadata filters to retrieve all chunks
        with matching doc_ref (doc_xxx format).

        Args:
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Document details dict with chunks
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(index_name)

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
        List documents in knowledge base.

        Uses metadata.doc_ref (our custom doc_xxx format) for aggregation
        to match the doc_ref returned in retrieve API metadata.
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        if not es_client.indices.exists(index=index_name):
            return {
                "documents": [],
                "total": 0,
                "page": page,
                "page_size": page_size,
                "knowledge_id": knowledge_id,
            }

        # Aggregate by doc_ref (our custom document ID), filtered by knowledge_id
        search_body = {
            "size": 0,
            "query": {"term": {"metadata.knowledge_id.keyword": knowledge_id}},
            "aggs": {
                "documents": {
                    "terms": {
                        "field": "metadata.doc_ref.keyword",  # Our custom doc_xxx ID
                        "size": 10000,
                    },
                    "aggs": {
                        "source_file": {
                            "terms": {
                                "field": "metadata.source_file.keyword",
                                "size": 1,
                            }
                        },
                        "created_at": {
                            "min": {
                                "field": "metadata.created_at"  # date field, no .keyword
                            }
                        },
                    },
                }
            },
        }

        response = es_client.search(index=index_name, body=search_body)

        # Process results
        all_docs = []
        for bucket in response["aggregations"]["documents"]["buckets"]:
            doc_id = bucket["key"]
            chunk_count = bucket["doc_count"]
            source_file = (
                bucket["source_file"]["buckets"][0]["key"]
                if bucket["source_file"]["buckets"]
                else None
            )
            created_at = bucket.get("created_at", {}).get("value_as_string")

            all_docs.append(
                {
                    "doc_ref": doc_id,
                    "source_file": source_file,
                    "chunk_count": chunk_count,
                    "created_at": created_at,
                }
            )

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
        """Test connection to Elasticsearch."""
        try:
            es_client = Elasticsearch(self.url, **self.es_kwargs)
            return es_client.ping()
        except Exception:
            return False

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = 10000,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base in Elasticsearch.

        Retrieves all chunks for a knowledge base with a single search request.

        Args:
            knowledge_id: Knowledge base ID
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            **kwargs: Additional parameters (e.g., user_id for per_user strategy)

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)
        user_id = kwargs.get("user_id")

        # Query all chunks for this knowledge base
        search_body = {
            "size": min(max_chunks, 10000),  # ES limit per request
            "query": {"term": {"metadata.knowledge_id.keyword": knowledge_id}},
            "sort": [
                {"metadata.doc_ref.keyword": "asc"},
                {"metadata.chunk_index": "asc"},
            ],
        }

        try:
            # Check if index exists
            if not es_client.indices.exists(index=index_name):
                return []

            response = es_client.search(index=index_name, body=search_body)

            chunks = []
            for hit in response["hits"]["hits"]:
                source = hit.get("_source", {})
                metadata = source.get("metadata", {})

                # Normalize content to plain text. In most cases Elasticsearch
                # stores human-readable text in the "content" field. However,
                # for robustness we still pass it through extract_chunk_text
                # to handle potential serialized node payloads.
                raw_content = source.get("content", "")

                chunks.append(
                    {
                        "content": self.extract_chunk_text(raw_content),
                        "title": metadata.get("source_file", ""),
                        "chunk_id": metadata.get("chunk_index", 0),
                        "doc_ref": metadata.get("doc_ref", ""),
                        "metadata": metadata,
                    }
                )

                if len(chunks) >= max_chunks:
                    break

            return filter_chunk_records(chunks, metadata_condition)

        except Exception as e:
            logger.warning(
                "[Elasticsearch] Failed to get all chunks: knowledge_id=%s, "
                "index_name=%s, search_body=%s, error=%s",
                knowledge_id,
                index_name,
                search_body,
                e,
            )
            return []

    def save_parent_nodes(
        self,
        knowledge_id: str,
        parent_nodes: List[BaseNode],
        **kwargs,
    ) -> Dict[str, Any]:
        if not parent_nodes:
            return {"stored_count": 0}

        index_name = self.get_parent_store_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)
        doc_ref = parent_nodes[0].metadata.get("doc_ref")

        if es_client.indices.exists(index=index_name) and doc_ref:
            self.delete_parent_nodes(
                knowledge_id=knowledge_id,
                doc_ref=doc_ref,
                **kwargs,
            )

        actions = [
            {
                "_op_type": "index",
                "_index": index_name,
                "_id": node.node_id,
                "_source": {
                    "parent_node_id": node.node_id,
                    "knowledge_id": knowledge_id,
                    "doc_ref": node.metadata.get("doc_ref"),
                    "source_file": node.metadata.get("source_file"),
                    "content": node.text,
                    "title": node.metadata.get("source_file", ""),
                    "metadata": node.metadata,
                },
            }
            for node in parent_nodes
        ]

        helpers.bulk(es_client, actions, refresh="wait_for")

        return {"stored_count": len(parent_nodes)}

    def get_parent_nodes(
        self,
        knowledge_id: str,
        parent_node_ids: List[str],
        **kwargs,
    ) -> Dict[str, Dict[str, Any]]:
        if not parent_node_ids:
            return {}

        index_name = self.get_parent_store_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)
        if not es_client.indices.exists(index=index_name):
            return {}

        response = es_client.search(
            index=index_name,
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": knowledge_id}},
                        {"terms": {"parent_node_id.keyword": parent_node_ids}},
                    ]
                }
            },
            size=len(parent_node_ids),
        )

        parent_records: Dict[str, Dict[str, Any]] = {}
        for hit in response["hits"]["hits"]:
            source = hit.get("_source", {})
            parent_node_id = source.get("parent_node_id")
            if not parent_node_id:
                continue
            parent_records[parent_node_id] = {
                "content": source.get("content", ""),
                "title": source.get("title", ""),
                "metadata": source.get("metadata", {}),
            }

        return parent_records

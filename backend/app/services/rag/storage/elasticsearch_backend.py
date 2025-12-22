# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Elasticsearch storage backend implementation.
"""

import hashlib
from typing import Any, Dict, List, Optional

from elasticsearch import Elasticsearch
from llama_index.core import StorageContext, VectorStoreIndex
from llama_index.core.schema import BaseNode
from llama_index.vector_stores.elasticsearch import ElasticsearchStore

from app.services.rag.retrieval.filters import (
    build_elasticsearch_filters,
    parse_metadata_filters,
)
from app.services.rag.storage.base import BaseStorageBackend


class ElasticsearchBackend(BaseStorageBackend):
    """Elasticsearch storage backend implementation."""

    def __init__(self, config: Dict):
        """Initialize Elasticsearch backend."""
        super().__init__(config)

        # Build connection kwargs
        self.es_kwargs = {}
        if self.username and self.password:
            self.es_kwargs["basic_auth"] = (self.username, self.password)
        elif self.api_key:
            self.es_kwargs["api_key"] = self.api_key

    def get_index_name(self, knowledge_id: str, **kwargs) -> str:
        """
        Get index name based on strategy.

        Strategies:
        - fixed: Use a single fixed index name (requires fixedName)
        - rolling: Use rolling indices based on knowledge_id hash (uses prefix, default: 'wegent')
        - per_dataset: Use separate index per knowledge base (uses prefix, default: 'wegent')
        - per_user: Use separate index per user (uses prefix, default: 'wegent', requires user_id)
        """
        mode = self.index_strategy.get("mode", "per_dataset")

        if mode == "fixed":
            fixed_name = self.index_strategy.get("fixedName")
            if not fixed_name:
                raise ValueError(
                    "fixedName is required for 'fixed' index strategy mode"
                )
            return fixed_name
        elif mode == "rolling":
            # Use hash-based sharding for rolling strategy
            prefix = self.index_strategy.get("prefix", "wegent")
            step = self.index_strategy.get("rollingStep", 5000)
            # Deterministic hash-based sharding using MD5
            hash_val = int(hashlib.md5(knowledge_id.encode()).hexdigest(), 16) % 10000
            index_base = (hash_val // step) * step
            return f"{prefix}_index_{index_base}"
        elif mode == "per_dataset":
            prefix = self.index_strategy.get("prefix", "wegent")
            return f"{prefix}_kb_{knowledge_id}"
        elif mode == "per_user":
            # Per-user index strategy: separate index for each user
            user_id = kwargs.get("user_id")
            if not user_id:
                raise ValueError(
                    "user_id is required for 'per_user' index strategy mode"
                )
            prefix = self.index_strategy.get("prefix", "wegent")
            return f"{prefix}_user_{user_id}"
        else:
            raise ValueError(f"Unknown index strategy mode: {mode}")

    def create_vector_store(self, index_name: str):
        """Create Elasticsearch vector store."""
        return ElasticsearchStore(
            index_name=index_name, es_url=self.url, **self.es_kwargs
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
        Add metadata to nodes and index them into Elasticsearch.

        Args:
            nodes: List of nodes to index
            knowledge_id: Knowledge base ID
            doc_ref: Document reference ID (doc_xxx format)
            source_file: Source file name
            created_at: Creation timestamp
            embed_model: Embedding model
            **kwargs: Additional parameters (e.g., user_id for per_user index strategy)

        Returns:
            Indexing result dict

        Note:
            We use 'doc_ref' in metadata to store our custom doc_xxx ID.
            LlamaIndex has its own internal 'document_id' field (ref_doc_id UUID).
        """
        # Add metadata to nodes
        for idx, node in enumerate(nodes):
            node.metadata.update(
                {
                    "knowledge_id": knowledge_id,
                    "doc_ref": doc_ref,  # Our custom doc_xxx ID
                    "source_file": source_file,
                    "chunk_index": idx,
                    "created_at": created_at,
                }
            )

        # Get index name
        index_name = self.get_index_name(knowledge_id, **kwargs)

        # Index nodes
        vector_store = self.create_vector_store(index_name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        VectorStoreIndex(
            nodes,
            storage_context=storage_context,
            embed_model=embed_model,
            show_progress=True,
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

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embed_model: Embedding model
            retrieval_setting: Dict with:
                - top_k: Maximum number of results
                - score_threshold: Minimum similarity score (0-1)
                - retrieval_mode: Optional 'vector'/'keyword'/'hybrid' (default: 'vector')
                - vector_weight: Optional weight for vector search (default: 0.7)
                - keyword_weight: Optional weight for keyword search (default: 0.3)
            metadata_condition: Optional metadata filtering
            **kwargs: Additional parameters

        Returns:
            Retrieval result dict
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        top_k = retrieval_setting.get("top_k", 5)
        score_threshold = retrieval_setting.get("score_threshold", 0.7)
        retrieval_mode = retrieval_setting.get("retrieval_mode", "vector")

        if retrieval_mode == "hybrid":
            vector_weight = retrieval_setting.get("vector_weight", 0.7)
            keyword_weight = retrieval_setting.get("keyword_weight", 0.3)
            return self._retrieve_hybrid(
                query=query,
                knowledge_id=knowledge_id,
                index_name=index_name,
                embed_model=embed_model,
                top_k=top_k,
                score_threshold=score_threshold,
                vector_weight=vector_weight,
                keyword_weight=keyword_weight,
                metadata_condition=metadata_condition,
            )
        else:
            return self._retrieve_vector(
                query=query,
                knowledge_id=knowledge_id,
                index_name=index_name,
                embed_model=embed_model,
                top_k=top_k,
                score_threshold=score_threshold,
                metadata_condition=metadata_condition,
            )

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

    def _retrieve_vector(
        self,
        query: str,
        knowledge_id: str,
        index_name: str,
        embed_model,
        top_k: int,
        score_threshold: float,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """Pure vector search."""
        vector_store = self.create_vector_store(index_name)
        index = VectorStoreIndex.from_vector_store(
            vector_store=vector_store, embed_model=embed_model
        )

        # Build metadata filters
        filters = self._build_metadata_filters(knowledge_id, metadata_condition)

        retriever = index.as_retriever(similarity_top_k=top_k, filters=filters)

        # Retrieve
        nodes = retriever.retrieve(query)

        # Filter by threshold and format results (Dify-compatible format)
        results = []
        for node in nodes:
            if node.score >= score_threshold:
                results.append(
                    {
                        "content": node.text,
                        "score": float(node.score),
                        "title": node.metadata.get("source_file", ""),
                        "metadata": node.metadata,
                    }
                )

        return {"records": results}

    def _retrieve_hybrid(
        self,
        query: str,
        knowledge_id: str,
        index_name: str,
        embed_model,
        top_k: int,
        score_threshold: float,
        vector_weight: float,
        keyword_weight: float,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """Hybrid search (vector + BM25)."""
        # Get query embedding
        query_embedding = embed_model.get_query_embedding(query)

        # Create Elasticsearch client
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        # Build filters using the new filter builder
        must_filters = build_elasticsearch_filters(knowledge_id, metadata_condition)

        # Build hybrid search query
        search_body = {
            "size": top_k,
            "query": {
                "bool": {
                    "must": must_filters,
                    "should": [
                        # Vector search component
                        {
                            "script_score": {
                                "query": {"match_all": {}},
                                "script": {
                                    "source": f"cosineSimilarity(params.query_vector, 'embedding') * {vector_weight}",
                                    "params": {"query_vector": query_embedding},
                                },
                            }
                        },
                        # BM25 keyword search component
                        {
                            "multi_match": {
                                "query": query,
                                "fields": ["content^1.0"],
                                "type": "best_fields",
                                "boost": keyword_weight,
                            }
                        },
                    ],
                    "minimum_should_match": 1,
                }
            },
            "_source": ["content", "metadata"],
        }

        # Execute search
        response = es_client.search(index=index_name, body=search_body)

        # Process results (Dify-compatible format)
        results = []
        for hit in response["hits"]["hits"]:
            score = hit["_score"]
            normalized_score = min(score, 1.0)

            if normalized_score >= score_threshold:
                source = hit["_source"]
                metadata = source.get("metadata", {})

                results.append(
                    {
                        "content": source.get("content", ""),
                        "score": float(normalized_score),
                        "title": metadata.get("source_file", ""),
                        "metadata": metadata,
                    }
                )

        return {"records": results}

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Delete document from Elasticsearch using native ES API.

        Uses delete_by_query to remove all chunks with matching doc_ref (doc_xxx format).
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        # Use ES native delete_by_query API with our custom doc_ref field
        delete_query = {
            "query": {
                "bool": {
                    "must": [
                        {"term": {"metadata.knowledge_id.keyword": knowledge_id}},
                        {"term": {"metadata.doc_ref.keyword": doc_ref}},
                    ]
                }
            }
        }

        response = es_client.delete_by_query(index=index_name, body=delete_query)

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": response.get("deleted", 0),
            "status": "deleted",
        }

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """
        Get document details from Elasticsearch using native ES API.

        Uses ES search to retrieve all chunks with matching doc_ref (doc_xxx format).
        """
        index_name = self.get_index_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)

        # Use ES native search API with our custom doc_ref field
        search_body = {
            "size": 1000,  # Max chunks per document
            "query": {
                "bool": {
                    "must": [
                        {"term": {"metadata.knowledge_id.keyword": knowledge_id}},
                        {"term": {"metadata.doc_ref.keyword": doc_ref}},
                    ]
                }
            },
            "sort": [{"metadata.chunk_index": "asc"}],
            "_source": ["content", "metadata"],
        }

        response = es_client.search(index=index_name, body=search_body)

        hits = response["hits"]["hits"]
        if not hits:
            raise ValueError(f"Document {doc_ref} not found")

        # Extract chunks
        chunks = []
        source_file = None
        for hit in hits:
            source = hit["_source"]
            metadata = source.get("metadata", {})

            if source_file is None:
                source_file = metadata.get("source_file")

            chunks.append(
                {
                    "chunk_index": metadata.get("chunk_index"),
                    "content": source.get("content", ""),
                    "metadata": metadata,
                }
            )

        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": source_file,
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

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

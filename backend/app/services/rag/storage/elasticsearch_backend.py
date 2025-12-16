# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Elasticsearch storage backend implementation.
"""

from typing import Dict, List, Optional, Any
from elasticsearch import Elasticsearch
from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.core.schema import BaseNode
from llama_index.vector_stores.elasticsearch import ElasticsearchStore

from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.retrieval.filters import (
    parse_metadata_filters,
    build_elasticsearch_filters
)


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
                raise ValueError("fixedName is required for 'fixed' index strategy mode")
            return fixed_name
        elif mode == "rolling":
            # Use hash-based sharding for rolling strategy
            prefix = self.index_strategy.get("prefix", "wegent")
            step = self.index_strategy.get("rollingStep", 5000)
            # Simple hash-based sharding
            hash_val = hash(knowledge_id) % 10000
            index_base = (hash_val // step) * step
            return f"{prefix}_index_{index_base}"
        elif mode == "per_dataset":
            prefix = self.index_strategy.get("prefix", "wegent")
            return f"{prefix}_kb_{knowledge_id}"
        elif mode == "per_user":
            # Per-user index strategy: separate index for each user
            user_id = kwargs.get("user_id")
            if not user_id:
                raise ValueError("user_id is required for 'per_user' index strategy mode")
            prefix = self.index_strategy.get("prefix", "wegent")
            return f"{prefix}_user_{user_id}"
        else:
            raise ValueError(f"Unknown index strategy mode: {mode}")

    def create_vector_store(self, index_name: str):
        """Create Elasticsearch vector store."""
        return ElasticsearchStore(
            index_name=index_name,
            es_url=self.url,
            **self.es_kwargs
        )

    def index(
        self,
        nodes: List[BaseNode],
        index_name: str,
        embed_model,
    ) -> Dict:
        """Index nodes into Elasticsearch."""
        vector_store = self.create_vector_store(index_name)
        storage_context = StorageContext.from_defaults(vector_store=vector_store)
        
        # Index nodes
        VectorStoreIndex(
            nodes,
            storage_context=storage_context,
            embed_model=embed_model,
            show_progress=True
        )
        
        return {
            "indexed_count": len(nodes),
            "index_name": index_name,
            "status": "success"
        }

    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs
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
                metadata_condition=metadata_condition
            )
        else:
            return self._retrieve_vector(
                query=query,
                knowledge_id=knowledge_id,
                index_name=index_name,
                embed_model=embed_model,
                top_k=top_k,
                score_threshold=score_threshold,
                metadata_condition=metadata_condition
            )

    def _build_metadata_filters(
        self,
        knowledge_id: str,
        metadata_condition: Optional[Dict[str, Any]] = None
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
        metadata_condition: Optional[Dict[str, Any]] = None
    ) -> Dict:
        """Pure vector search."""
        vector_store = self.create_vector_store(index_name)
        index = VectorStoreIndex.from_vector_store(
            vector_store=vector_store,
            embed_model=embed_model
        )
        
        # Build metadata filters
        filters = self._build_metadata_filters(knowledge_id, metadata_condition)
        
        retriever = index.as_retriever(
            similarity_top_k=top_k,
            filters=filters
        )
        
        # Retrieve
        nodes = retriever.retrieve(query)
        
        # Filter by threshold and format results
        results = []
        for node in nodes:
            if node.score >= score_threshold:
                results.append({
                    "document_id": node.metadata.get("document_id"),
                    "chunk_index": node.metadata.get("chunk_index"),
                    "source_file": node.metadata.get("source_file"),
                    "content": node.text,
                    "score": node.score,
                    "metadata": node.metadata
                })
        
        return {
            "records": results,
            "query": query,
            "knowledge_id": knowledge_id,
            "total": len(results),
            "retrieval_mode": "vector"
        }

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
        metadata_condition: Optional[Dict[str, Any]] = None
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
                                    "params": {"query_vector": query_embedding}
                                }
                            }
                        },
                        # BM25 keyword search component
                        {
                            "multi_match": {
                                "query": query,
                                "fields": ["text^1.0"],
                                "type": "best_fields",
                                "boost": keyword_weight
                            }
                        }
                    ],
                    "minimum_should_match": 1
                }
            },
            "_source": ["text", "metadata"]
        }
        
        # Execute search
        response = es_client.search(index=index_name, body=search_body)
        
        # Process results
        results = []
        for hit in response["hits"]["hits"]:
            score = hit["_score"]
            normalized_score = min(score, 1.0)
            
            if normalized_score >= score_threshold:
                source = hit["_source"]
                metadata = source.get("metadata", {})
                
                results.append({
                    "document_id": metadata.get("document_id"),
                    "chunk_index": metadata.get("chunk_index"),
                    "source_file": metadata.get("source_file"),
                    "content": source.get("text", ""),
                    "score": normalized_score,
                    "metadata": metadata
                })
        
        return {
            "records": results,
            "query": query,
            "knowledge_id": knowledge_id,
            "total": len(results),
            "retrieval_mode": "hybrid"
        }

    def delete_document(self, knowledge_id: str, document_id: str, **kwargs) -> Dict:
        """Delete document from Elasticsearch."""
        index_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(index_name)
        
        # Build metadata condition for document_id
        metadata_condition = {
            "operator": "and",
            "conditions": [
                {"key": "document_id", "operator": "eq", "value": document_id}
            ]
        }
        
        # Query nodes with matching document_id using new filter parser
        filters = parse_metadata_filters(knowledge_id, metadata_condition)
        
        index = VectorStoreIndex.from_vector_store(vector_store=vector_store)
        retriever = index.as_retriever(similarity_top_k=1000, filters=filters)
        nodes = retriever.retrieve("dummy query")
        
        # Delete nodes
        deleted_count = 0
        for node in nodes:
            vector_store.delete(node.node_id)
            deleted_count += 1
        
        return {
            "document_id": document_id,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_count,
            "status": "deleted"
        }

    def get_document(self, knowledge_id: str, document_id: str, **kwargs) -> Dict:
        """Get document details from Elasticsearch."""
        index_name = self.get_index_name(knowledge_id, **kwargs)
        vector_store = self.create_vector_store(index_name)
        
        # Build metadata condition for document_id
        metadata_condition = {
            "operator": "and",
            "conditions": [
                {"key": "document_id", "operator": "eq", "value": document_id}
            ]
        }
        
        # Query nodes with matching document_id using new filter parser
        filters = parse_metadata_filters(knowledge_id, metadata_condition)
        
        index = VectorStoreIndex.from_vector_store(vector_store=vector_store)
        retriever = index.as_retriever(similarity_top_k=1000, filters=filters)
        nodes = retriever.retrieve("dummy query")
        
        if not nodes:
            raise ValueError(f"Document {document_id} not found")
        
        chunks = []
        source_file = None
        for node in nodes:
            if source_file is None:
                source_file = node.metadata.get("source_file")
            chunks.append({
                "chunk_index": node.metadata.get("chunk_index"),
                "content": node.text,
                "metadata": node.metadata
            })
        
        return {
            "document_id": document_id,
            "knowledge_id": knowledge_id,
            "source_file": source_file,
            "chunk_count": len(chunks),
            "chunks": chunks
        }

    def list_documents(
        self,
        knowledge_id: str,
        page: int = 1,
        page_size: int = 20,
        **kwargs
    ) -> Dict:
        """List documents in knowledge base."""
        index_name = self.get_index_name(knowledge_id, **kwargs)
        es_client = Elasticsearch(self.url, **self.es_kwargs)
        
        # Aggregate by document_id
        search_body = {
            "size": 0,
            "query": {
                "term": {"metadata.knowledge_id.keyword": knowledge_id}
            },
            "aggs": {
                "documents": {
                    "terms": {
                        "field": "metadata.document_id.keyword",
                        "size": 10000
                    },
                    "aggs": {
                        "source_file": {
                            "terms": {
                                "field": "metadata.source_file.keyword",
                                "size": 1
                            }
                        },
                        "created_at": {
                            "min": {
                                "field": "metadata.created_at.keyword"
                            }
                        }
                    }
                }
            }
        }
        
        response = es_client.search(index=index_name, body=search_body)
        
        # Process results
        all_docs = []
        for bucket in response["aggregations"]["documents"]["buckets"]:
            doc_id = bucket["key"]
            chunk_count = bucket["doc_count"]
            source_file = bucket["source_file"]["buckets"][0]["key"] if bucket["source_file"]["buckets"] else None
            created_at = bucket.get("created_at", {}).get("value_as_string")
            
            all_docs.append({
                "document_id": doc_id,
                "source_file": source_file,
                "chunk_count": chunk_count,
                "created_at": created_at
            })
        
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
            "knowledge_id": knowledge_id
        }

    def test_connection(self) -> bool:
        """Test connection to Elasticsearch."""
        try:
            es_client = Elasticsearch(self.url, **self.es_kwargs)
            return es_client.ping()
        except Exception:
            return False

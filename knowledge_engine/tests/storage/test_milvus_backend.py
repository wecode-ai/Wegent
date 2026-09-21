# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for MilvusBackend storage backend implementation.
"""

from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.embedding.errors import (
    CollectionDimensionMismatchError,
    EmbeddingDimensionMismatchError,
)
from knowledge_engine.retrieval.filters import parse_metadata_filters
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_backend import MilvusBackend
from shared.models import RetrievalScope


class _StubEmbeddingModel:
    """Embedding model with an explicit declared-dimension contract."""

    model_name = "stub-embedding-model"

    def __init__(
        self,
        *,
        declared_dimension: Optional[int],
        vector_dimension: int,
        embed_batch_size: int = 10,
    ) -> None:
        self.embed_batch_size = embed_batch_size
        self.text_batches: List[List[str]] = []
        self.query_requests: List[str] = []
        self._vector_dimension = vector_dimension
        if declared_dimension is not None:
            self._configured_dimension = declared_dimension

    def get_text_embedding_batch(self, texts: List[str], **_: Any) -> List[List[float]]:
        self.text_batches.append(list(texts))
        return [[0.5] * self._vector_dimension for _ in texts]

    def get_query_embedding(self, query: str) -> List[float]:
        self.query_requests.append(query)
        return [0.5] * self._vector_dimension


def _collection_description(dimension: int) -> Dict[str, Any]:
    return {
        "fields": [
            {"name": "pk", "params": {}},
            {"name": "embedding", "params": {"dim": dimension}},
            {"name": "sparse_embedding", "params": {}},
        ]
    }


def _patch_absent_collection() -> Any:
    """Patch the collection lookup the dimension contract reads before queries."""
    return patch(
        "knowledge_engine.storage.milvus_backend.MilvusClient",
        **{"return_value.has_collection.return_value": False},
    )


class TestMilvusBackendInit:
    """Tests for MilvusBackend initialization."""

    def test_init_with_full_config(self):
        """Test initialization with username and password."""
        config = {
            "url": "http://localhost:19530/default",
            "username": "testuser",
            "password": "testpassword",
            "indexStrategy": {"mode": "per_user"},
            "ext": {"dim": 768},
        }
        backend = MilvusBackend(config)

        assert backend.url == "http://localhost:19530/default"
        assert backend.username == "testuser"
        assert backend.password == "testpassword"
        assert backend.token == "testuser:testpassword"
        assert backend.dim == 768

    def test_init_without_auth(self):
        """Test initialization without authentication credentials."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {},
        }
        backend = MilvusBackend(config)

        assert backend.url == "http://localhost:19530/default"
        assert backend.username is None
        assert backend.password is None
        assert backend.token == ""
        assert backend.dim == 1024  # Default dimension (DEFAULT_EMBEDDING_DIM)

    def test_init_with_partial_auth(self):
        """Test initialization with only username (no password)."""
        config = {
            "url": "http://localhost:19530/default",
            "username": "testuser",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.token == ""  # Should be empty if password is missing

    def test_init_default_dim(self):
        """Test that default dimension is 1024 when not specified."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)
        assert backend.dim == 1024

    def test_init_db_name_from_url_path(self):
        """Test that db_name is extracted from URL path."""
        config = {
            "url": "http://localhost:19530/mydb",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.db_name == "mydb"
        assert backend.base_url == "http://localhost:19530"

    def test_init_db_name_default_when_no_path(self):
        """Test that db_name defaults to 'default' when URL has no path."""
        config = {
            "url": "http://localhost:19530",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.db_name == "default"
        assert backend.base_url == "http://localhost:19530"

    def test_init_db_name_from_ext_takes_priority(self):
        """Test that ext.db_name takes priority over URL path."""
        config = {
            "url": "http://localhost:19530/url_db",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {"db_name": "ext_db"},
        }
        backend = MilvusBackend(config)

        # ext.db_name should take priority
        assert backend.db_name == "ext_db"
        # URL should remain unchanged when ext.db_name is used
        assert backend.base_url == "http://localhost:19530/url_db"


class TestMilvusBackendClassAttributes:
    """Tests for class-level attributes."""

    def test_supported_retrieval_methods(self):
        """Test that all three retrieval methods are supported."""
        assert "vector" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert "keyword" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert "hybrid" in MilvusBackend.SUPPORTED_RETRIEVAL_METHODS
        assert len(MilvusBackend.SUPPORTED_RETRIEVAL_METHODS) == 3

    def test_index_prefix(self):
        """Test that INDEX_PREFIX is 'collection'."""
        assert MilvusBackend.INDEX_PREFIX == "collection"

    def test_get_supported_retrieval_methods(self):
        """Test get_supported_retrieval_methods class method."""
        methods = MilvusBackend.get_supported_retrieval_methods()
        assert methods == ["vector", "keyword", "hybrid"]


class TestCreateVectorStore:
    """Tests for create_vector_store method."""

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_basic(self, mock_milvus_vs):
        """Test creating a vector store with basic parameters.

        Verifies that db_name is extracted from URL path and passed as separate parameter.
        """
        config = {
            "url": "http://localhost:19530/mydb",
            "username": "user",
            "password": "pass",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        backend.create_vector_store("test_collection")

        # db_name should be extracted from URL path and passed separately
        mock_milvus_vs.assert_called_once_with(
            uri="http://localhost:19530",  # base URL without db_name path
            token="user:pass",
            db_name="mydb",  # db_name as separate parameter
            collection_name="test_collection",
            dim=1024,  # DEFAULT_EMBEDDING_DIM
            upsert_mode=True,
            overwrite=False,
            enable_sparse=True,
            hybrid_ranker="WeightedRanker",
            hybrid_ranker_params={},
        )

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_defaults_to_weighted_ranker(self, mock_milvus_vs):
        """Test that WeightedRanker is the default hybrid ranker."""
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset"},
            }
        )

        backend.create_vector_store("test_collection")

        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker"] == "WeightedRanker"
        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker_params"] == {}

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_can_opt_out_to_rrf_ranker(self, mock_milvus_vs):
        """Test that an explicit opt-out can request RRFRanker."""
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset"},
                "ext": {"hybrid_ranker": "RRFRanker"},
            }
        )

        backend.create_vector_store("test_collection")

        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker"] == "RRFRanker"
        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker_params"] == {}

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_threads_weighted_ranker_params_from_retrieval_setting(
        self, mock_milvus_vs
    ):
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset"},
                "ext": {"hybrid_ranker": "WeightedRanker"},
            }
        )

        backend.create_vector_store(
            "test_collection",
            retrieval_mode="hybrid",
            retrieval_setting={"vector_weight": 0.8, "keyword_weight": 0.2},
        )

        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker"] == "WeightedRanker"
        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker_params"] == {
            "weights": [0.8, 0.2]
        }

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_create_vector_store_uses_configured_weighted_ranker_params_as_fallback(
        self, mock_milvus_vs
    ):
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset"},
                "ext": {
                    "hybrid_ranker": "WeightedRanker",
                    "hybrid_ranker_params": {"weights": [0.6, 0.4]},
                },
            }
        )

        backend.create_vector_store(
            "test_collection",
            retrieval_mode="hybrid",
            retrieval_setting={},
        )

        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker_params"] == {
            "weights": [0.6, 0.4]
        }


class TestRetrieve:
    """Tests for retrieve method."""

    def test_process_query_results_returns_display_text(self):
        from knowledge_engine.storage.milvus_backend import MilvusBackend

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        node = TextNode(
            text="Question-only retrieval text",
            metadata={"display_text": "Q: question\n\nA: full answer"},
        )

        result = backend._process_query_results(
            MagicMock(nodes=[node], similarities=[0.9]),
            score_threshold=0.1,
        )

        assert result["records"][0]["content"] == "Q: question\n\nA: full answer"

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_vector_mode(self, mock_client_cls, mock_milvus_vs):
        """Test retrieval in vector mode."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "test content"
        mock_node.metadata = {"source_file": "test.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.9]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
        )

        assert "records" in result
        assert len(result["records"]) == 1
        assert result["records"][0]["content"] == "test content"
        assert result["records"][0]["score"] == 0.9

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_vector_mode_adds_native_document_scope_expr(
        self, mock_client_cls, mock_milvus_vs
    ):
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10, 11]),
        )

        assert mock_store.query.call_args.kwargs["string_expr"] == (
            'knowledge_id == \'kb_1\' and doc_ref in ["10", "11"]'
        )
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.filters is None

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_preserves_metadata_filter_expr_with_document_scope(
        self, mock_client_cls, mock_milvus_vs
    ):
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.query.return_value = MagicMock(nodes=[], similarities=[])

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10]),
            metadata_condition={
                "operator": "and",
                "conditions": [
                    {"key": "tags", "operator": "contains", "value": "release"},
                    {
                        "key": "summary",
                        "operator": "text_match",
                        "value": "checklist",
                    },
                ],
            },
        )

        string_expr = mock_store.query.call_args.kwargs["string_expr"]
        assert "knowledge_id == 'kb_1'" in string_expr
        assert "array_contains(tags, 'release')" in string_expr
        assert "summary like 'checklist%'" in string_expr
        assert 'doc_ref in ["10"]' in string_expr
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.filters is None

    def test_scoped_native_filter_expr_keeps_knowledge_id_outside_user_or(self):
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        metadata_filters = parse_metadata_filters(
            "kb_1",
            {
                "operator": "or",
                "conditions": [
                    {"key": "lang", "operator": "==", "value": "zh"},
                    {"key": "source", "operator": "==", "value": "manual"},
                ],
            },
        )

        string_expr = backend._build_scoped_native_filter_expr(
            scope=RetrievalScope(document_ids=[10]),
            metadata_filters=metadata_filters,
        )

        assert string_expr == (
            "(knowledge_id == 'kb_1' and (lang == 'zh' or source == 'manual')) "
            'and doc_ref in ["10"]'
        )

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_rejects_doc_ref_in_metadata_condition_with_scope(
        self, mock_milvus_vs
    ):
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_embed_model = MagicMock()

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match=r"RetrievalScope\.document_ids"):
            backend.retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=mock_embed_model,
                retrieval_setting={
                    "top_k": 10,
                    "score_threshold": 0.5,
                    "retrieval_mode": "vector",
                },
                scope=RetrievalScope(document_ids=[10]),
                metadata_condition={
                    "operator": "and",
                    "conditions": [
                        {"key": "doc_ref", "operator": "in", "value": ["10"]}
                    ],
                },
            )

        mock_store.query.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_keyword_mode(self, mock_milvus_vs):
        """Test retrieval in keyword mode."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "keyword result"
        mock_node.metadata = {"source_file": "doc.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.8]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "keyword",
            },
        )

        assert "records" in result
        mock_embed_model.get_query_embedding.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_hybrid_mode(self, mock_client_cls, mock_milvus_vs):
        """Test retrieval in hybrid mode."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node = MagicMock()
        mock_node.text = "hybrid result"
        mock_node.metadata = {"source_file": "hybrid.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node]
        mock_result.similarities = [0.85]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "hybrid",
                "search_hints": {
                    "semantic_query": "How to verify the test query?",
                    "keywords": ["test"],
                    "phrases": ["test query"],
                },
            },
        )

        assert "records" in result
        mock_embed_model.get_query_embedding.assert_called_once_with(
            "How to verify the test query?"
        )
        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.query_str == "test query test"

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_hybrid_mode_threads_ranker_weights(
        self, mock_client_cls, mock_milvus_vs
    ):
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_result.nodes = []
        mock_result.similarities = []
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset"},
                "ext": {"hybrid_ranker": "WeightedRanker"},
            }
        )

        backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "hybrid",
                "vector_weight": 0.75,
                "keyword_weight": 0.25,
            },
        )

        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker"] == "WeightedRanker"
        assert mock_milvus_vs.call_args.kwargs["hybrid_ranker_params"] == {
            "weights": [0.75, 0.25]
        }

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_keyword_mode_uses_sparse_hints(self, mock_milvus_vs):
        """Test keyword retrieval uses sparse hints when provided."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_result.nodes = []
        mock_result.similarities = []
        mock_store.query.return_value = mock_result

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=MagicMock(),
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "keyword",
                "search_hints": {
                    "keywords": ["test"],
                    "phrases": ["test query"],
                },
            },
        )

        vs_query = mock_store.query.call_args.args[0]
        assert vs_query.query_str == "test query test"

    def test_retrieve_invalid_mode(self):
        """Test that invalid retrieval mode raises ValueError."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        mock_embed_model = MagicMock()

        with pytest.raises(
            ValueError, match="does not support 'invalid' retrieval mode"
        ):
            backend.retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=mock_embed_model,
                retrieval_setting={"retrieval_mode": "invalid"},
            )

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @_patch_absent_collection()
    def test_retrieve_score_threshold_filtering(self, mock_client_cls, mock_milvus_vs):
        """Test that results below score threshold are filtered out."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_result = MagicMock()
        mock_node1 = MagicMock()
        mock_node1.text = "high score"
        mock_node1.metadata = {"source_file": "high.txt", "knowledge_id": "kb_1"}
        mock_node2 = MagicMock()
        mock_node2.text = "low score"
        mock_node2.metadata = {"source_file": "low.txt", "knowledge_id": "kb_1"}
        mock_result.nodes = [mock_node1, mock_node2]
        mock_result.similarities = [0.9, 0.3]
        mock_store.query.return_value = mock_result

        mock_embed_model = MagicMock()
        mock_embed_model.get_query_embedding.return_value = [0.1] * 1536

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=mock_embed_model,
            retrieval_setting={
                "top_k": 10,
                "score_threshold": 0.5,
                "retrieval_mode": "vector",
            },
        )

        assert len(result["records"]) == 1
        assert result["records"][0]["content"] == "high score"


class TestDeleteDocument:
    """Tests for delete_document method."""

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_document(self, mock_client_class, mock_milvus_vs):
        """Test deleting a document."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = True

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_node = MagicMock()
        mock_store.get_nodes.return_value = [mock_node, mock_node]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_123")

        assert result["doc_ref"] == "doc_123"
        assert result["knowledge_id"] == "kb_1"
        assert result["deleted_chunks"] == 2
        assert result["status"] == "deleted"
        mock_store.delete_nodes.assert_called_once()
        mock_client.delete.assert_called_once_with(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1" and doc_ref == "doc_123"',
        )
        mock_client.close.assert_called_once()


class TestDeleteKnowledge:
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_knowledge_removes_all_chunks_for_one_knowledge_id(
        self, mock_client_class
    ):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.side_effect = [True, True]
        mock_client.query.side_effect = [
            [{"doc_ref": "doc_1"}, {"doc_ref": "doc_2"}],
            [{"doc_ref": "doc_1"}],
        ]

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_knowledge(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "deleted_chunks": 2,
            "deleted_parent_nodes": 1,
            "status": "deleted",
        }
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1",
            filter='knowledge_id == "kb_1"',
        )
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1"',
        )
        mock_client.close.assert_called_once()


class TestDropKnowledgeIndex:
    def test_drop_knowledge_index_rejects_shared_index_strategy(self) -> None:
        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "rolling", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match="Physical index drop is only allowed"):
            backend.drop_knowledge_index(knowledge_id="kb_1", user_id=7)

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_drop_knowledge_index_drops_dedicated_kb_collection_and_parent_store(
        self, mock_client_class
    ):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.side_effect = [True, True]

        backend = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.drop_knowledge_index(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "collection_name": "test_kb_kb_1",
            "dropped_parent_collection": True,
            "status": "dropped",
        }
        mock_client.drop_collection.assert_any_call(collection_name="test_kb_kb_1")
        mock_client.drop_collection.assert_any_call(
            collection_name="test_kb_kb_1__parents"
        )
        mock_client.close.assert_called_once()


class TestSaveParentNodes:
    """Tests for parent-node persistence."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_save_parent_nodes_replaces_existing_rows(self, mock_client_class):
        """Test parent-node writes are idempotent for retries."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.has_collection.return_value = True

        parent_node = MagicMock()
        parent_node.node_id = "parent-1"
        parent_node.text = "parent content"
        parent_node.metadata = {
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_strategy": "hierarchical",
        }

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )
        backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )

        assert mock_client.delete.call_count == 2
        assert mock_client.insert.call_count == 2
        mock_client.delete.assert_called_with(
            collection_name="test_kb_kb_1__parents",
            filter='knowledge_id == "kb_1" and doc_ref == "doc_123"',
        )
        assert mock_client.close.call_count == 2


class TestGetDocument:
    """Tests for get_document method."""

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_get_document(self, mock_milvus_vs):
        """Test getting document details."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_node1 = MagicMock()
        mock_node1.text = "chunk 1"
        mock_node1.metadata = {"source_file": "test.txt", "chunk_index": 0}
        mock_node2 = MagicMock()
        mock_node2.text = "chunk 2"
        mock_node2.metadata = {"source_file": "test.txt", "chunk_index": 1}
        mock_store.get_nodes.return_value = [mock_node2, mock_node1]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_document(knowledge_id="kb_1", doc_ref="doc_123")

        assert result["doc_ref"] == "doc_123"
        assert result["knowledge_id"] == "kb_1"
        assert result["source_file"] == "test.txt"
        assert result["chunk_count"] == 2
        assert result["chunks"][0]["chunk_index"] == 0
        assert result["chunks"][1]["chunk_index"] == 1

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_get_document_not_found(self, mock_milvus_vs):
        """Test getting a document that doesn't exist."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.get_nodes.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        with pytest.raises(ValueError, match="not found"):
            backend.get_document(knowledge_id="kb_1", doc_ref="doc_nonexistent")


class TestListDocuments:
    """Tests for list_documents method."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_list_documents(self, mock_client_class):
        """Test listing documents with pagination."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]

        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "created_at": "2024-01-01",
            },
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "created_at": "2024-01-01",
            },
            {
                "doc_ref": "doc_2",
                "source_file": "file2.txt",
                "created_at": "2024-01-02",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.list_documents(knowledge_id="kb_1", page=1, page_size=10)

        assert result["total"] == 2
        assert len(result["documents"]) == 2
        assert result["page"] == 1
        assert result["page_size"] == 10
        assert result["documents"][0]["doc_ref"] == "doc_2"
        assert result["documents"][0]["chunk_count"] == 1
        assert result["documents"][1]["doc_ref"] == "doc_1"
        assert result["documents"][1]["chunk_count"] == 2
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_list_documents_empty_collection(self, mock_client_class):
        """Test listing documents when collection doesn't exist."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.list_documents(knowledge_id="kb_1", page=1, page_size=10)

        assert result["total"] == 0
        assert result["documents"] == []
        mock_client.close.assert_called_once()


class TestTestConnection:
    """Tests for test_connection method."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_connection_success(self, mock_client_class):
        """Test successful connection."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.test_connection() is True
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_connection_failure(self, mock_client_class):
        """Test failed connection."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.side_effect = Exception("Connection refused")

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset"},
        }
        backend = MilvusBackend(config)

        assert backend.test_connection() is False
        mock_client.close.assert_called_once()


class TestGetAllChunks:
    """Tests for get_all_chunks method."""

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks(self, mock_client_class):
        """Test getting all chunks."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]

        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 1,
                "text": "chunk 2 content",
            },
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 0,
                "text": "chunk 1 content",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)

        assert len(result) == 2
        assert result[0]["chunk_id"] == 0
        assert result[1]["chunk_id"] == 1
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks_collection_not_exists(self, mock_client_class):
        """Test getting chunks when collection doesn't exist."""
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = []

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)

        assert result == []
        mock_client.close.assert_called_once()

    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_get_all_chunks_applies_metadata_condition(self, mock_client_class):
        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.list_collections.return_value = ["test_kb_kb_1"]
        mock_client.query.return_value = [
            {
                "doc_ref": "doc_1",
                "source_file": "file1.txt",
                "chunk_index": 0,
                "text": "chunk 1 content",
                "lang": "zh",
            },
            {
                "doc_ref": "doc_2",
                "source_file": "file2.txt",
                "chunk_index": 1,
                "text": "chunk 2 content",
                "lang": "en",
            },
        ]

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        result = backend.get_all_chunks(
            knowledge_id="kb_1",
            max_chunks=100,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "lang", "operator": "eq", "value": "zh"}],
            },
        )

        assert [chunk["doc_ref"] for chunk in result] == ["doc_1"]
        mock_client.close.assert_called_once()


class TestIndexWithMetadata:
    """Tests for index_with_metadata method.

    Note: Metadata is now applied by the indexer layer via chunk_metadata.apply_to_nodes()
    before calling index_with_metadata. The storage backend no longer applies metadata
    to nodes - it only uses ChunkMetadata for index name generation.
    """

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_index_with_metadata(self, mock_milvus_vs, mock_storage_ctx, mock_vs_index):
        """Test indexing nodes with metadata."""
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        mock_ctx = MagicMock()
        mock_storage_ctx.from_defaults.return_value = mock_ctx

        mock_node1 = MagicMock()
        mock_node1.metadata = {
            "knowledge_id": "kb_1",
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_index": 0,
            "created_at": "2024-01-01T00:00:00",
        }
        mock_node2 = MagicMock()
        mock_node2.metadata = {
            "knowledge_id": "kb_1",
            "doc_ref": "doc_123",
            "source_file": "test.txt",
            "chunk_index": 1,
            "created_at": "2024-01-01T00:00:00",
        }

        mock_embed_model = MagicMock()

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        chunk_metadata = ChunkMetadata(
            knowledge_id="kb_1",
            doc_ref="doc_123",
            source_file="test.txt",
            created_at="2024-01-01T00:00:00",
        )

        result = backend.index_with_metadata(
            nodes=[mock_node1, mock_node2],
            chunk_metadata=chunk_metadata,
            embed_model=mock_embed_model,
        )

        assert result["indexed_count"] == 2
        assert result["status"] == "success"
        assert result["index_name"] == "test_kb_kb_1"

        mock_vs_index.assert_called_once()
        call_args = mock_vs_index.call_args
        assert call_args[0][0] == [mock_node1, mock_node2]
        assert call_args[1]["storage_context"] == mock_ctx
        assert call_args[1]["embed_model"] == mock_embed_model
        assert call_args[1]["show_progress"] is True


class TestIndexNameGeneration:
    """Tests for index name generation based on different strategies."""

    def test_per_dataset_index_name(self):
        """Test per_dataset index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "milvus"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123")
        assert index_name == "milvus_kb_kb_123"

    def test_per_user_index_name(self):
        """Test per_user index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_user", "prefix": "milvus"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123", user_id="user_456")
        assert index_name == "milvus_user_user_456"

    def test_fixed_index_name(self):
        """Test fixed index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "fixed", "fixedName": "my_fixed_collection"},
        }
        backend = MilvusBackend(config)

        index_name = backend.get_index_name("kb_123")
        assert index_name == "my_fixed_collection"

    def test_rolling_index_name(self):
        """Test rolling index name generation."""
        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {
                "mode": "rolling",
                "prefix": "milvus",
                "rollingStep": 100,
            },
        }
        backend = MilvusBackend(config)

        assert backend.get_index_name("1") == "milvus_collection_0"
        assert backend.get_index_name("100") == "milvus_collection_0"
        assert backend.get_index_name("101") == "milvus_collection_100"


class TestEmbeddingDimensionContract:
    """Tests for the embedding dimension contract on the Milvus main path."""

    @staticmethod
    def _backend() -> MilvusBackend:
        return MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "username": "milvus-user",
                "password": "milvus-secret-token",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

    @staticmethod
    def _chunk_metadata() -> ChunkMetadata:
        return ChunkMetadata(
            knowledge_id="kb_1",
            doc_ref="doc_1",
            source_file="test.txt",
            created_at="2026-01-01T00:00:00",
        )

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_fails_before_writing_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(5)

        embed_model = _StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=embed_model,
            )

        error = exc_info.value
        assert (error.model, error.expected, error.actual) == (
            "stub-embedding-model",
            3,
            5,
        )
        assert error.code == "embedding_dimension_mismatch"
        assert error.retryable is False
        assert "http://localhost:19530" not in str(error)
        assert "milvus-secret-token" not in str(error)

        client.delete.assert_not_called()
        client.create_collection.assert_not_called()
        mock_milvus_vs.assert_not_called()
        mock_vs_index.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_keeps_stored_vectors_when_the_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(4)

        backend = self._backend()

        with pytest.raises(EmbeddingDimensionMismatchError):
            backend.index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=_StubEmbeddingModel(
                    declared_dimension=8,
                    vector_dimension=8,
                ),
            )

        client.insert.assert_not_called()
        client.upsert.assert_not_called()
        client.delete.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_index_accepts_a_collection_with_the_declared_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(1536)

        result = self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=_StubEmbeddingModel(
                declared_dimension=1536,
                vector_dimension=1536,
            ),
        )

        assert result["status"] == "success"
        assert mock_milvus_vs.call_args.kwargs["dim"] == 1536

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_first_real_batch_decides_the_dimension_of_a_new_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = _StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=8,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one"), TextNode(text="chunk two")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert mock_milvus_vs.call_args.kwargs["dim"] == 8
        assert embed_model.text_batches == [["chunk one", "chunk two"]]

        written_nodes = mock_vs_index.call_args.args[0]
        assert [node.embedding for node in written_nodes] == [
            [0.5] * 8,
            [0.5] * 8,
        ]

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_compatibility_path_does_not_probe_or_persist_the_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = False

        embed_model = _StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=8,
        )

        self._backend().index_with_metadata(
            nodes=[TextNode(text="chunk one")],
            chunk_metadata=self._chunk_metadata(),
            embed_model=embed_model,
        )

        assert embed_model.query_requests == []
        assert len(embed_model.text_batches) == 1
        assert not hasattr(embed_model, "_dimension")

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_compatibility_path_fails_on_a_mismatched_existing_collection(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(8)

        with pytest.raises(CollectionDimensionMismatchError):
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=_StubEmbeddingModel(
                    declared_dimension=None,
                    vector_dimension=4,
                ),
            )

        mock_milvus_vs.assert_not_called()

    @pytest.mark.parametrize("retrieval_mode", ["vector", "hybrid"])
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_vector_queries_fail_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
        retrieval_mode: str,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(5)

        embed_model = _StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        with pytest.raises(CollectionDimensionMismatchError):
            self._backend().retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=embed_model,
                retrieval_setting={"top_k": 10, "retrieval_mode": retrieval_mode},
            )

        assert embed_model.query_requests == []
        mock_milvus_vs.assert_not_called()

    @pytest.mark.parametrize("retrieval_mode", ["vector", "hybrid"])
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_queries_of_a_model_without_declared_dimension_compare_the_real_vector(
        self,
        mock_client_cls,
        mock_milvus_vs,
        retrieval_mode: str,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        embed_model = _StubEmbeddingModel(
            declared_dimension=None,
            vector_dimension=3,
        )

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=embed_model,
                retrieval_setting={"top_k": 10, "retrieval_mode": retrieval_mode},
            )

        assert (exc_info.value.expected, exc_info.value.actual) == (3, 5)
        assert embed_model.query_requests == ["test query"]
        mock_store.query.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.VectorStoreIndex")
    @patch("knowledge_engine.storage.milvus_backend.StorageContext")
    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_existing_collection_without_a_vector_dimension_fails_closed(
        self,
        mock_client_cls,
        mock_milvus_vs,
        mock_storage_ctx,
        mock_vs_index,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = {
            "fields": [{"name": "pk", "params": {}}]
        }

        with pytest.raises(CollectionDimensionMismatchError) as exc_info:
            self._backend().index_with_metadata(
                nodes=[TextNode(text="chunk one")],
                chunk_metadata=self._chunk_metadata(),
                embed_model=_StubEmbeddingModel(
                    declared_dimension=1024,
                    vector_dimension=1024,
                ),
            )

        assert exc_info.value.actual == 0
        assert "dense vector" in str(exc_info.value)
        mock_milvus_vs.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_keyword_queries_ignore_the_stored_dimension(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        node = MagicMock()
        node.text = "keyword result"
        node.metadata = {"source_file": "doc.txt", "knowledge_id": "kb_1"}
        mock_store.query.return_value = MagicMock(nodes=[node], similarities=[0.8])

        embed_model = _StubEmbeddingModel(declared_dimension=3, vector_dimension=3)

        result = self._backend().retrieve(
            knowledge_id="kb_1",
            query="test query",
            embed_model=embed_model,
            retrieval_setting={"top_k": 10, "retrieval_mode": "keyword"},
        )

        assert result["records"][0]["content"] == "keyword result"
        assert embed_model.query_requests == []
        client.describe_collection.assert_not_called()

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    @patch("knowledge_engine.storage.milvus_backend.MilvusClient")
    def test_delete_document_still_runs_when_the_stored_dimension_differs(
        self,
        mock_client_cls,
        mock_milvus_vs,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.has_collection.return_value = True
        client.describe_collection.return_value = _collection_description(5)

        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store
        mock_store.get_nodes.return_value = [MagicMock(), MagicMock()]

        result = self._backend().delete_document(
            knowledge_id="kb_1",
            doc_ref="doc_1",
        )

        assert result["deleted_chunks"] == 2
        mock_store.delete_nodes.assert_called_once()

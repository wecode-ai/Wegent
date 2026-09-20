# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Vector, keyword and hybrid retrieval of the legacy Milvus adapter.

The legacy adapter keeps its own query shape, score handling and document
scope, so these are the tests the online main branch shipped - split by
behaviour domain instead of one oversized module, and importing that module as
they always did.
"""

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.retrieval.filters import parse_metadata_filters
from knowledge_engine.storage.milvus_backend import MilvusBackend
from shared.models import RetrievalScope


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
    def test_retrieve_vector_mode(self, mock_milvus_vs):
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
    def test_retrieve_vector_mode_adds_native_document_scope_expr(self, mock_milvus_vs):
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
    def test_retrieve_preserves_metadata_filter_expr_with_document_scope(
        self, mock_milvus_vs
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
    def test_retrieve_hybrid_mode(self, mock_milvus_vs):
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
    def test_retrieve_hybrid_mode_threads_ranker_weights(self, mock_milvus_vs):
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
    def test_retrieve_score_threshold_filtering(self, mock_milvus_vs):
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

    @patch("knowledge_engine.storage.milvus_backend.LazyAsyncMilvusVectorStore")
    def test_retrieve_refuses_a_malformed_metadata_condition(self, mock_milvus_vs):
        """A condition the shared contract cannot honour never widens a read.

        The adapter compiles its filters through the shared metadata condition
        contract rather than a historical helper of its own, so a malformed
        condition fails the request instead of being dropped into an unfiltered
        read of the whole knowledge base.
        """
        mock_store = MagicMock()
        mock_milvus_vs.return_value = mock_store

        config = {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
        }
        backend = MilvusBackend(config)

        with pytest.raises(ValueError, match="'conditions' must be a list"):
            backend.retrieve(
                knowledge_id="kb_1",
                query="test query",
                embed_model=MagicMock(),
                retrieval_setting={
                    "top_k": 10,
                    "score_threshold": 0.5,
                    "retrieval_mode": "vector",
                },
                metadata_condition={"operator": "and", "conditions": "release"},
            )

        mock_store.query.assert_not_called()

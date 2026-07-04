# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode
from llama_index.vector_stores.qdrant import QdrantVectorStore
from qdrant_client.http import models as qdrant_models

from knowledge_engine.retrieval.filters import parse_metadata_filters
from shared.models import RetrievalScope


class TestProcessQueryResults:
    @patch("knowledge_engine.storage.qdrant_backend.QdrantClient")
    def test_process_query_results_returns_display_text(self, mock_client_class):
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        mock_client_class.return_value = MagicMock()
        backend = QdrantBackend({"url": "http://localhost:6333"})
        node = TextNode(
            text="Question-only retrieval text",
            metadata={"display_text": "Q: question\n\nA: full answer"},
        )

        result = backend._process_query_results(
            MagicMock(nodes=[node], similarities=[0.9]),
            score_threshold=0.1,
        )

        assert result["records"][0]["content"] == "Q: question\n\nA: full answer"


class TestDeleteDocument:
    @patch("knowledge_engine.storage.qdrant_backend.QdrantVectorStore")
    @patch("knowledge_engine.storage.qdrant_backend.QdrantClient")
    def test_delete_document_removes_parent_nodes(
        self, mock_client_class, mock_store_class
    ):
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        mock_store = MagicMock()
        mock_store.get_nodes.return_value = [MagicMock()]
        mock_store_class.return_value = mock_store

        mock_client = MagicMock()
        mock_client.collection_exists.return_value = True
        mock_client_class.return_value = mock_client

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_1")

        assert result["deleted_chunks"] == 1
        mock_store.delete_nodes.assert_called_once()
        mock_client.delete.assert_called_once_with(
            collection_name="test_kb_kb_1__parents",
            points_selector=qdrant_models.FilterSelector(
                filter=qdrant_models.Filter(
                    must=[
                        qdrant_models.FieldCondition(
                            key="knowledge_id",
                            match=qdrant_models.MatchValue(value="kb_1"),
                        ),
                        qdrant_models.FieldCondition(
                            key="doc_ref",
                            match=qdrant_models.MatchValue(value="doc_1"),
                        ),
                    ]
                )
            ),
            wait=True,
        )


class TestDeleteKnowledge:
    @patch("knowledge_engine.storage.qdrant_backend.QdrantVectorStore")
    @patch("knowledge_engine.storage.qdrant_backend.QdrantClient")
    def test_delete_knowledge_removes_all_chunks_for_one_knowledge_id(
        self, mock_client_class, mock_store_class
    ):
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.collection_exists.side_effect = [True, True]
        mock_client.scroll.side_effect = [
            ([MagicMock(), MagicMock()], None),
            ([MagicMock()], None),
        ]

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
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
        assert mock_client.delete.call_count == 2
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1",
            points_selector=qdrant_models.FilterSelector(
                filter=qdrant_models.Filter(
                    must=[
                        qdrant_models.FieldCondition(
                            key="knowledge_id",
                            match=qdrant_models.MatchValue(value="kb_1"),
                        )
                    ]
                )
            ),
            wait=True,
        )
        mock_client.delete.assert_any_call(
            collection_name="test_kb_kb_1__parents",
            points_selector=qdrant_models.FilterSelector(
                filter=qdrant_models.Filter(
                    must=[
                        qdrant_models.FieldCondition(
                            key="knowledge_id",
                            match=qdrant_models.MatchValue(value="kb_1"),
                        )
                    ]
                )
            ),
            wait=True,
        )


class TestSaveParentNodes:
    @patch("knowledge_engine.storage.qdrant_backend.QdrantClient")
    def test_save_parent_nodes_replaces_existing_rows_for_same_document(
        self, mock_client_class
    ):
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.collection_exists.return_value = True

        parent_node = MagicMock()
        parent_node.node_id = "parent-1"
        parent_node.text = "parent content"
        parent_node.metadata = {
            "doc_ref": "doc_123",
            "source_file": "test.md",
            "chunk_strategy": "hierarchical",
        }

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )

        assert result == {"stored_count": 1}
        mock_client.delete.assert_called_once_with(
            collection_name="test_kb_kb_1__parents",
            points_selector=qdrant_models.FilterSelector(
                filter=qdrant_models.Filter(
                    must=[
                        qdrant_models.FieldCondition(
                            key="knowledge_id",
                            match=qdrant_models.MatchValue(value="kb_1"),
                        ),
                        qdrant_models.FieldCondition(
                            key="doc_ref",
                            match=qdrant_models.MatchValue(value="doc_123"),
                        ),
                    ]
                )
            ),
            wait=True,
        )


class TestDropKnowledgeIndex:
    def test_drop_knowledge_index_rejects_shared_index_strategy(self) -> None:
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_user", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match="Physical index drop is only allowed"):
            backend.drop_knowledge_index(knowledge_id="kb_1", user_id=7)

    @patch("knowledge_engine.storage.qdrant_backend.QdrantClient")
    def test_drop_knowledge_index_drops_dedicated_kb_collection_and_parent_store(
        self, mock_client_class
    ):
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.collection_exists.side_effect = [True, True]

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
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
        mock_client.delete_collection.assert_any_call(
            collection_name="test_kb_kb_1",
        )
        mock_client.delete_collection.assert_any_call(
            collection_name="test_kb_kb_1__parents",
        )


class TestRetrieve:
    def test_retrieve_adds_native_document_scope_filter(self) -> None:
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_vector_store = MagicMock()
        base_filter = qdrant_models.Filter(
            must=[
                qdrant_models.FieldCondition(
                    key="knowledge_id",
                    match=qdrant_models.MatchValue(value="kb_1"),
                )
            ]
        )
        mock_vector_store._build_query_filter.return_value = base_filter
        mock_vector_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_vector_store)

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2]

        backend.retrieve(
            knowledge_id="kb_1",
            query="release checklist",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.7,
                "retrieval_mode": "vector",
            },
            scope=RetrievalScope(document_ids=[10, 11]),
        )

        native_filter = mock_vector_store.query.call_args.kwargs["qdrant_filters"]
        assert native_filter.must == [
            base_filter,
            qdrant_models.FieldCondition(
                key="doc_ref",
                match=qdrant_models.MatchAny(any=["10", "11"]),
            ),
        ]

    def test_scoped_native_filter_wraps_existing_metadata_filter(self) -> None:
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        base_filter = qdrant_models.Filter(
            should=[
                qdrant_models.FieldCondition(
                    key="knowledge_id",
                    match=qdrant_models.MatchValue(value="kb_1"),
                ),
                qdrant_models.FieldCondition(
                    key="summary",
                    match=qdrant_models.MatchText(text="release"),
                ),
            ]
        )
        mock_vector_store = MagicMock()
        mock_vector_store._build_query_filter.return_value = base_filter
        query = MagicMock()

        native_filter = backend._build_scoped_native_filter(
            vector_store=mock_vector_store,
            query=query,
            scope=RetrievalScope(document_ids=[10]),
        )

        mock_vector_store._build_query_filter.assert_called_once_with(query)
        assert native_filter is not None
        assert native_filter.must == [
            base_filter,
            qdrant_models.FieldCondition(
                key="doc_ref",
                match=qdrant_models.MatchAny(any=["10"]),
            ),
        ]

    def test_metadata_or_keeps_knowledge_id_outside_user_or(self) -> None:
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

        vector_store = object.__new__(QdrantVectorStore)
        native_filter = QdrantVectorStore._build_subfilter(
            vector_store,
            metadata_filters,
        )

        assert native_filter.must == [
            qdrant_models.FieldCondition(
                key="knowledge_id",
                match=qdrant_models.MatchValue(value="kb_1"),
            ),
            qdrant_models.Filter(
                should=[
                    qdrant_models.FieldCondition(
                        key="lang",
                        match=qdrant_models.MatchValue(value="zh"),
                    ),
                    qdrant_models.FieldCondition(
                        key="source",
                        match=qdrant_models.MatchValue(value="manual"),
                    ),
                ]
            ),
        ]

    def test_retrieve_uses_dense_query_from_search_hints(self) -> None:
        from knowledge_engine.storage.qdrant_backend import QdrantBackend

        backend = QdrantBackend(
            {
                "url": "http://localhost:6333",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )
        mock_vector_store = MagicMock()
        mock_vector_store.query.return_value = MagicMock(nodes=[], similarities=[])
        backend.create_vector_store = MagicMock(return_value=mock_vector_store)
        backend._build_metadata_filters = MagicMock(return_value="filters")

        embed_model = MagicMock()
        embed_model.get_query_embedding.return_value = [0.1, 0.2]

        backend.retrieve(
            knowledge_id="kb_1",
            query="原始 query",
            embed_model=embed_model,
            retrieval_setting={
                "top_k": 5,
                "score_threshold": 0.7,
                "retrieval_mode": "vector",
                "dense_query": "semantic rewrite",
            },
        )

        embed_model.get_query_embedding.assert_called_once_with("semantic rewrite")
        vs_query = mock_vector_store.query.call_args.args[0]
        assert vs_query.query_str == "semantic rewrite"

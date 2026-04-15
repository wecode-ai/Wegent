# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest
from qdrant_client.http import models as qdrant_models


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

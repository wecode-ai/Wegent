# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

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

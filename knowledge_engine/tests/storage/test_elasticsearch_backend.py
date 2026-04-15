# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ElasticsearchBackend get_all_chunks and purge/drop behavior."""

from unittest.mock import MagicMock, patch

import pytest


class TestGetAllChunks:
    """Tests for ElasticsearchBackend.get_all_chunks."""

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_parsed_chunks(self, mock_client_class):
        """Should parse hits into normalized chunk payloads."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {
                "total": {"value": 1, "relation": "eq"},
                "hits": [
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-a.md",
                                "chunk_index": 3,
                                "doc_ref": "doc_1",
                                "knowledge_id": "kb_1",
                            },
                        }
                    }
                ],
            }
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)
        assert len(result) == 1
        assert result[0]["doc_ref"] == "doc_1"
        assert result[0]["chunk_id"] == 3

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_empty_when_no_hits(self, mock_client_class):
        """Should return an empty list when the knowledge_id term query has no hits."""
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {"total": {"value": 0, "relation": "eq"}, "hits": []}
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(knowledge_id="kb_1", max_chunks=100)
        assert result == []

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_applies_metadata_condition(self, mock_client_class):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = True
        mock_client.search.return_value = {
            "hits": {
                "total": {"value": 2, "relation": "eq"},
                "hits": [
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-a.md",
                                "chunk_index": 3,
                                "doc_ref": "doc_1",
                                "knowledge_id": "kb_1",
                                "lang": "zh",
                            },
                        }
                    },
                    {
                        "_source": {
                            "content": "chunk content",
                            "metadata": {
                                "source_file": "doc-b.md",
                                "chunk_index": 4,
                                "doc_ref": "doc_2",
                                "knowledge_id": "kb_1",
                                "lang": "en",
                            },
                        }
                    },
                ],
            }
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.get_all_chunks(
            knowledge_id="kb_1",
            max_chunks=100,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "lang", "operator": "eq", "value": "zh"}],
            },
        )

        assert [chunk["doc_ref"] for chunk in result] == ["doc_1"]


class TestListDocuments:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_list_documents_returns_empty_page_when_index_missing(
        self, mock_client_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_client_class.return_value = mock_client
        mock_client.indices.exists.return_value = False

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.list_documents(knowledge_id="kb_1", page=2, page_size=10)

        assert result == {
            "documents": [],
            "total": 0,
            "page": 2,
            "page_size": 10,
            "knowledge_id": "kb_1",
        }
        mock_client.search.assert_not_called()


class TestDeleteDocument:
    @patch("knowledge_engine.storage.elasticsearch_backend.ElasticsearchStore")
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_delete_document_removes_parent_nodes(
        self, mock_es_class, mock_store_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_store = MagicMock()
        mock_store.get_nodes.return_value = [MagicMock()]
        mock_store_class.return_value = mock_store

        mock_client = MagicMock()
        mock_client.indices.exists.return_value = True
        mock_client.delete_by_query.return_value = {"deleted": 1}
        mock_es_class.return_value = mock_client

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_document(knowledge_id="kb_1", doc_ref="doc_1")

        assert result["deleted_chunks"] == 1
        assert result["deleted_parent_nodes"] == 1
        assert result["index_name"] == "test_kb_kb_1"
        assert result["status"] == "deleted"
        mock_store.delete_nodes.assert_called_once()
        mock_client.delete_by_query.assert_called_once_with(
            index="test_kb_kb_1__parents",
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": "kb_1"}},
                        {"term": {"doc_ref.keyword": "doc_1"}},
                    ]
                }
            },
            refresh=True,
        )


class TestDeleteKnowledge:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_delete_knowledge_removes_all_chunks_for_one_knowledge_id(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.indices.exists.side_effect = [True, True]
        mock_client.search.side_effect = [
            {"hits": {"total": {"value": 3, "relation": "eq"}, "hits": []}},
            {"hits": {"total": {"value": 2, "relation": "eq"}, "hits": []}},
        ]
        mock_client.delete_by_query.side_effect = [
            {"deleted": 3},
            {"deleted": 2},
        ]

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.delete_knowledge(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "deleted_chunks": 3,
            "deleted_parent_nodes": 2,
            "status": "deleted",
        }
        assert mock_client.delete_by_query.call_count == 2
        mock_client.delete_by_query.assert_any_call(
            index="test_kb_kb_1",
            query={
                "bool": {
                    "filter": [{"term": {"metadata.knowledge_id.keyword": "kb_1"}}]
                }
            },
            refresh=True,
        )
        mock_client.delete_by_query.assert_any_call(
            index="test_kb_kb_1__parents",
            query={"bool": {"filter": [{"term": {"knowledge_id.keyword": "kb_1"}}]}},
            refresh=True,
        )


class TestSaveParentNodes:
    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_save_parent_nodes_replaces_existing_rows_for_same_document(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.delete_by_query.return_value = {"deleted": 2}

        parent_node = MagicMock()
        parent_node.node_id = "parent-1"
        parent_node.text = "parent content"
        parent_node.metadata = {
            "doc_ref": "doc_123",
            "source_file": "test.md",
            "chunk_strategy": "hierarchical",
        }

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.save_parent_nodes(
            knowledge_id="kb_1",
            parent_nodes=[parent_node],
        )

        assert result == {"stored_count": 1}
        mock_client.delete_by_query.assert_called_once_with(
            index="test_kb_kb_1__parents",
            query={
                "bool": {
                    "filter": [
                        {"term": {"knowledge_id.keyword": "kb_1"}},
                        {"term": {"doc_ref.keyword": "doc_123"}},
                    ]
                }
            },
            refresh=True,
        )


class TestDropKnowledgeIndex:
    def test_drop_knowledge_index_rejects_shared_index_strategy(self) -> None:
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_user", "prefix": "test"},
            }
        )

        with pytest.raises(ValueError, match="Physical index drop is only allowed"):
            backend.drop_knowledge_index(knowledge_id="kb_1", user_id=7)

    @patch("knowledge_engine.storage.elasticsearch_backend.Elasticsearch")
    def test_drop_knowledge_index_drops_dedicated_kb_index_and_parent_store(
        self, mock_es_class
    ):
        from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend

        mock_client = MagicMock()
        mock_es_class.return_value = mock_client
        mock_client.indices.exists.side_effect = [True, True]

        backend = ElasticsearchBackend(
            {
                "url": "http://localhost:9200",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        )

        result = backend.drop_knowledge_index(knowledge_id="kb_1")

        assert result == {
            "knowledge_id": "kb_1",
            "index_name": "test_kb_kb_1",
            "dropped_parent_index": True,
            "status": "dropped",
        }
        mock_client.indices.delete.assert_any_call(index="test_kb_kb_1")
        mock_client.indices.delete.assert_any_call(index="test_kb_kb_1__parents")

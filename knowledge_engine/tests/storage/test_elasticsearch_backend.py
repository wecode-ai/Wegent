# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ElasticsearchBackend get_all_chunks."""

from unittest.mock import MagicMock, patch


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

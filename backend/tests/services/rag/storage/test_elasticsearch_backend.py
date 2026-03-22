# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ElasticsearchBackend get_all_chunks."""

from unittest.mock import MagicMock, patch


class TestGetAllChunks:
    """Tests for ElasticsearchBackend.get_all_chunks."""

    @patch("app.services.rag.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_parsed_chunks(self, mock_client_class):
        """Should parse hits into normalized chunk payloads."""
        from app.services.rag.storage.elasticsearch_backend import ElasticsearchBackend

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

    @patch("app.services.rag.storage.elasticsearch_backend.Elasticsearch")
    def test_get_all_chunks_returns_empty_when_no_hits(self, mock_client_class):
        """Should return an empty list when the knowledge_id term query has no hits."""
        from app.services.rag.storage.elasticsearch_backend import ElasticsearchBackend

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

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chunk listing preserves the identity needed by the product visibility gate."""

from typing import Any
from unittest.mock import MagicMock, patch

from qdrant_client.http import models as qdrant_models

from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.qdrant_backend import QdrantBackend
from shared.knowledge_contracts import RetrievalScope


def test_qdrant_filters_live_document_refs_before_the_scroll_limit() -> None:
    points = [
        qdrant_models.Record(id=1, payload={"knowledge_id": "1", "doc_ref": "99"}),
        qdrant_models.Record(id=2, payload={"knowledge_id": "2", "doc_ref": "doc_12"}),
        qdrant_models.Record(
            id=3, payload={"knowledge_id": "1", "doc_ref": "doc_12", "text": "live"}
        ),
    ]
    client = MagicMock()

    def scroll(**kwargs: Any) -> tuple[list[qdrant_models.Record], None]:
        conditions = {
            condition.key: condition.match for condition in kwargs["scroll_filter"].must
        }
        assert conditions["knowledge_id"].value == "1"
        assert set(conditions["doc_ref"].any) == {"12", "doc_12"}
        allowed = [point for point in points if point.id == 3]
        return allowed[: kwargs["limit"]], None

    client.scroll.side_effect = scroll
    with patch(
        "knowledge_engine.storage.qdrant_backend.QdrantClient", return_value=client
    ):
        chunks = QdrantBackend({"url": "http://localhost:6333"}).get_all_chunks(
            knowledge_id="1", max_chunks=1, scope=RetrievalScope(document_ids=[12])
        )

    assert [chunk["doc_ref"] for chunk in chunks] == ["doc_12"]


def test_milvus_chunk_listing_returns_knowledge_and_document_identity() -> None:
    stored = {
        "knowledge_id": "1",
        "doc_ref": "11",
        "chunk_index": 0,
        "text": "permitted body",
    }
    client = MagicMock()
    client.list_collections.return_value = ["test_kb_1"]
    client.query.side_effect = lambda **kwargs: [
        {field: stored[field] for field in kwargs["output_fields"] if field in stored}
    ]
    with patch(
        "knowledge_engine.storage.milvus_backend.MilvusClient", return_value=client
    ):
        chunks = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        ).get_all_chunks(knowledge_id="1")

    assert chunks[0]["content"] == "permitted body"
    assert chunks[0]["metadata"]["knowledge_id"] == "1"
    assert chunks[0]["metadata"]["doc_ref"] == "11"


def test_elasticsearch_limits_only_scoped_chunks() -> None:
    client = MagicMock()
    client.indices.exists.return_value = True

    def search(**kwargs: Any) -> dict[str, Any]:
        body = kwargs["body"]
        assert body["size"] == 1
        assert body["query"] == {
            "bool": {
                "filter": [
                    {"term": {"metadata.knowledge_id.keyword": "1"}},
                    {"terms": {"metadata.doc_ref.keyword": ["12", "doc_12"]}},
                ]
            }
        }
        return {
            "hits": {
                "hits": [
                    {
                        "_source": {
                            "content": "live",
                            "metadata": {"knowledge_id": "1", "doc_ref": "12"},
                        }
                    }
                ]
            }
        }

    client.search.side_effect = search
    with patch(
        "knowledge_engine.storage.elasticsearch_backend.Elasticsearch",
        return_value=client,
    ):
        chunks = ElasticsearchBackend({"url": "http://localhost:9200"}).get_all_chunks(
            knowledge_id="1", max_chunks=1, scope=RetrievalScope(document_ids=[12])
        )

    assert [chunk["doc_ref"] for chunk in chunks] == ["12"]


def test_milvus_limits_only_scoped_chunks() -> None:
    client = MagicMock()
    client.list_collections.return_value = ["test_kb_1"]

    def query(**kwargs: Any) -> list[dict[str, Any]]:
        assert kwargs["filter"] == 'knowledge_id == "1" and doc_ref in ["12", "doc_12"]'
        assert kwargs["limit"] == 1
        return [{"knowledge_id": "1", "doc_ref": "doc_12", "text": "live"}]

    client.query.side_effect = query
    with patch(
        "knowledge_engine.storage.milvus_backend.MilvusClient", return_value=client
    ):
        chunks = MilvusBackend(
            {
                "url": "http://localhost:19530",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        ).get_all_chunks(
            knowledge_id="1", max_chunks=1, scope=RetrievalScope(document_ids=[12])
        )

    assert [chunk["doc_ref"] for chunk in chunks] == ["doc_12"]

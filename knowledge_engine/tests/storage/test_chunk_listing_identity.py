# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chunk listing preserves the identity needed by the product visibility gate."""

from typing import Any
from unittest.mock import MagicMock, patch

from knowledge_engine.storage.milvus_backend import MilvusBackend


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


def test_qdrant_filters_deleted_points_before_the_candidate_limit() -> None:
    from qdrant_client.http import models

    from knowledge_engine.storage.qdrant_backend import QdrantBackend
    from shared.knowledge_contracts import RetrievalScope

    client = MagicMock()
    client.scroll.return_value = (
        [
            models.Record(
                id=10002,
                payload={"knowledge_id": "1", "doc_ref": "doc_12", "text": "live"},
            )
        ],
        None,
    )
    with patch(
        "knowledge_engine.storage.qdrant_backend.QdrantClient", return_value=client
    ):
        chunks = QdrantBackend({"url": "http://localhost:6333"}).get_all_chunks(
            knowledge_id="1", max_chunks=1, scope=RetrievalScope(document_ids=[12])
        )

    assert [chunk["doc_ref"] for chunk in chunks] == ["doc_12"]
    query = client.scroll.call_args.kwargs
    assert query["limit"] == 1
    assert query["scroll_filter"] == models.Filter(
        must=[
            models.FieldCondition(
                key="knowledge_id", match=models.MatchValue(value="1")
            ),
            models.FieldCondition(
                key="doc_ref", match=models.MatchAny(any=["12", "doc_12"])
            ),
        ]
    )


def test_elasticsearch_excludes_remnants_before_the_candidate_limit() -> None:
    from knowledge_engine.storage.elasticsearch_backend import ElasticsearchBackend
    from shared.knowledge_contracts import RetrievalScope

    client = MagicMock()
    client.indices.exists.return_value = True

    def search(*, index: str, body: dict[str, Any]) -> dict[str, Any]:
        reference = "doc_12" if "bool" in body["query"] else "11"
        return {
            "hits": {
                "hits": [
                    {
                        "_source": {
                            "content": reference,
                            "metadata": {"knowledge_id": "1", "doc_ref": reference},
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
    assert [chunk["doc_ref"] for chunk in chunks] == ["doc_12"]
    client.search.assert_called_once()
    body = client.search.call_args.kwargs["body"]
    assert body["size"] == 1
    assert body["query"] == {
        "bool": {
            "filter": [
                {"term": {"metadata.knowledge_id.keyword": "1"}},
                {"terms": {"metadata.doc_ref.keyword": ["12", "doc_12"]}},
            ]
        }
    }
    client.close.assert_called_once()


def test_milvus_filters_deleted_points_before_the_candidate_limit() -> None:
    from shared.knowledge_contracts import RetrievalScope

    client = MagicMock()
    client.list_collections.return_value = ["test_kb_1"]

    def query(**kwargs: Any) -> list[dict[str, Any]]:
        reference = "doc_12" if "doc_ref in" in kwargs["filter"] else "11"
        return [{"knowledge_id": "1", "doc_ref": reference, "text": "body"}]

    client.query.side_effect = query
    with patch(
        "knowledge_engine.storage.milvus_backend.MilvusClient", return_value=client
    ):
        chunks = MilvusBackend(
            {
                "url": "http://localhost:19530/default",
                "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            }
        ).get_all_chunks(
            knowledge_id="1", max_chunks=1, scope=RetrievalScope(document_ids=[12])
        )
    assert [chunk["doc_ref"] for chunk in chunks] == ["doc_12"]
    client.query.assert_called_once()
    args = client.query.call_args.kwargs
    assert args["limit"] == 1
    assert args["filter"] == 'knowledge_id == "1" and doc_ref in ["12", "doc_12"]'
    assert chunks[0]["metadata"]["knowledge_id"] == "1"

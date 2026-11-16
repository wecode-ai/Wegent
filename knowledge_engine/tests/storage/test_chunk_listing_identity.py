# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chunk listing preserves the identity needed by the product visibility gate."""

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

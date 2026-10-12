# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document cleanup must load an existing collection before using it."""

from math import isfinite
from typing import Any, Iterator
from unittest.mock import MagicMock, patch

import pytest
from pymilvus.exceptions import MilvusException

from knowledge_engine.storage.milvus_backend import MilvusBackend


@pytest.fixture
def cleanup_client() -> Iterator[MagicMock]:
    """Keep the real vector store, replacing only external Milvus access."""
    client = MagicMock()
    client._using = "isolated-cleanup"
    client.has_collection.side_effect = lambda name: not name.endswith("__parents")
    client.describe_collection.return_value = {
        "fields": [{"name": "embedding", "params": {"dim": 1024}}]
    }
    client.list_collections.return_value = ["test_kb_kb_1"]
    client.list_indexes.return_value = ["embedding", "sparse_embedding"]
    with (
        patch(
            "knowledge_engine.storage.milvus_backend.MilvusClient", return_value=client
        ),
        patch(
            "llama_index.vector_stores.milvus.base.MilvusClient", return_value=client
        ),
        patch("llama_index.vector_stores.milvus.base.Collection"),
        patch(
            "llama_index.vector_stores.milvus.base.get_default_sparse_embedding_function"
        ),
    ):
        yield client


def make_backend() -> MilvusBackend:
    return MilvusBackend(
        {
            "url": "http://isolated.invalid:19530",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            "ext": {"dim": 1024},
        }
    )


@pytest.mark.parametrize("initially_loaded", [False, True])
def test_cleanup_loads_before_query_and_delete(
    cleanup_client: MagicMock, initially_loaded: bool
) -> None:
    """A collection that exists but is not yet loaded must still be cleaned."""
    loaded = initially_loaded
    rows = [{"text": "old content", "embedding": [0.0] * 1024}]
    operations = []

    def load_collection(collection_name: str, *, timeout: float) -> None:
        nonlocal loaded
        assert collection_name == "test_kb_kb_1"
        assert isfinite(timeout) and 0 < timeout < 30
        operations.append("loaded")
        loaded = True

    def query(**kwargs: Any) -> list[dict[str, Any]]:
        operations.append("query")
        if not loaded:
            raise MilvusException(101, "collection not loaded")
        assert "doc_ref == 'doc_123'" in kwargs["filter"]
        assert "knowledge_id == 'kb_1'" in kwargs["filter"]
        return list(rows)

    def delete(**kwargs: Any) -> dict[str, int]:
        operations.append("delete")
        if not loaded:
            raise MilvusException(101, "collection not loaded")
        assert "doc_ref == 'doc_123'" in kwargs["filter"]
        assert "knowledge_id == 'kb_1'" in kwargs["filter"]
        rows.clear()
        return {"delete_count": 1}

    cleanup_client.load_collection.side_effect = load_collection
    cleanup_client.query.side_effect = query
    cleanup_client.delete.side_effect = delete

    result = make_backend().delete_document("kb_1", "doc_123")

    assert result["status"] == "deleted"
    assert result["deleted_chunks"] == 1
    assert rows == []
    assert operations == ["loaded", "query", "delete"]


def test_cleanup_without_collection_does_not_create_or_load(
    cleanup_client: MagicMock,
) -> None:
    """A first upload must not create a collection just to remove old chunks."""
    cleanup_client.has_collection.return_value = False
    cleanup_client.has_collection.side_effect = None

    result = make_backend().delete_document("kb_1", "doc_123")

    assert result["deleted_chunks"] == 0
    assert result["status"] == "deleted"
    cleanup_client.list_collections.assert_not_called()
    cleanup_client.create_collection.assert_not_called()
    cleanup_client.load_collection.assert_not_called()
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()


@pytest.mark.parametrize(
    "error", [TimeoutError("load timed out"), MilvusException(101, "load failed")]
)
def test_cleanup_load_failure_stops_before_query_or_delete(
    cleanup_client: MagicMock, error: Exception
) -> None:
    """Loading failures must propagate, leaving both child and parent data intact."""
    cleanup_client.load_collection.side_effect = error

    with pytest.raises(type(error)) as caught:
        make_backend().delete_document("kb_1", "doc_123")

    assert caught.value is error
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()
    assert cleanup_client.has_collection.call_count == 1


def test_cleanup_delete_failure_is_not_hidden(cleanup_client: MagicMock) -> None:
    """Successful loading does not turn a failed cleanup into a success."""
    cleanup_client.query.return_value = []
    error = MilvusException(1, "delete failed")
    cleanup_client.delete.side_effect = error

    with pytest.raises(MilvusException) as caught:
        make_backend().delete_document("kb_1", "doc_123")

    assert caught.value is error
    cleanup_client.load_collection.assert_called_once()
    assert cleanup_client.has_collection.call_count == 1

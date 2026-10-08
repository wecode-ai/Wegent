"""First writes must resolve the collection schema after concurrent creation."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode
from llama_index.vector_stores.qdrant import QdrantVectorStore
from qdrant_client import QdrantClient
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse

from knowledge_engine.storage.qdrant_backend import QdrantBackend


def response_error(status: int, message: str) -> UnexpectedResponse:
    return UnexpectedResponse(status, message, message.encode(), {})


def vector_store(
    responses: list, *, exists: bool = False
) -> tuple[QdrantVectorStore, MagicMock]:
    client = MagicMock(spec=QdrantClient)
    client.collection_exists.return_value = exists
    client.create_collection.side_effect = response_error(409, "already exists")
    client.get_collection.side_effect = responses
    with patch(
        "knowledge_engine.storage.qdrant_backend.QdrantClient", return_value=client
    ):
        backend = QdrantBackend({"url": "http://localhost:6333"})
    return backend.create_vector_store("parallel-first-index"), client


def collection(size: int = 3, named: bool = False) -> SimpleNamespace:
    vectors = models.VectorParams(size=size, distance=models.Distance.COSINE)
    if named:
        vectors = {"text-dense": vectors}
    return SimpleNamespace(
        config=SimpleNamespace(
            params=SimpleNamespace(vectors=vectors, sparse_vectors={})
        )
    )


def test_first_write_waits_for_schema_after_create_conflict():
    store, client = vector_store(
        [response_error(500, "0 of 0 read operations failed"), collection()]
    )
    store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    points = client.upload_points.call_args.kwargs["points"]
    assert list(points[0].vector) == [""]
    assert client.get_collection.call_count == 2


def test_unreadable_schema_never_uploads_default_named_vectors():
    store, client = vector_store([response_error(500, "not ready")] * 10)
    with pytest.raises(UnexpectedResponse):
        store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    client.upload_points.assert_not_called()


def test_auth_failure_is_not_retried():
    store, client = vector_store([response_error(403, "forbidden")])
    with pytest.raises(UnexpectedResponse):
        store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    assert client.get_collection.call_count == 1
    client.upload_points.assert_not_called()


def test_incompatible_dimensions_are_rejected_before_upload():
    store, client = vector_store([collection(size=4)])
    with pytest.raises(ValueError, match="dimension"):
        store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    client.upload_points.assert_not_called()


def test_existing_named_schema_is_preserved():
    store, client = vector_store([collection(named=True)])
    store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    assert list(client.upload_points.call_args.kwargs["points"][0].vector) == [
        "text-dense"
    ]


def test_existing_collection_resolves_schema_before_first_write():
    store, client = vector_store([collection()], exists=True)
    store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    client.create_collection.assert_not_called()
    assert list(client.upload_points.call_args.kwargs["points"][0].vector) == [""]


@pytest.mark.parametrize("vectors", [None, {}])
def test_unknown_schema_is_rejected_before_upload(vectors):
    info = collection()
    info.config.params.vectors = vectors
    store, client = vector_store([info])
    with pytest.raises(ValueError, match="vector schema"):
        store.add([TextNode(text="document", embedding=[1.0, 0.0, 0.0])])
    client.upload_points.assert_not_called()

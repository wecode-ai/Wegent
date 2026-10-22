# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document cleanup must load an existing collection before using it."""

from math import isfinite
from typing import Any, Iterator
from unittest.mock import MagicMock, call, patch

import pytest
from pymilvus import MilvusClient
from pymilvus.client.grpc_handler import GrpcHandler
from pymilvus.client.types import LoadState
from pymilvus.exceptions import MilvusException
from pymilvus.grpc_gen import common_pb2, milvus_pb2

from knowledge_engine.storage.milvus_backend import MilvusBackend


@pytest.fixture
def cleanup_client() -> Iterator[MagicMock]:
    """Keep the real vector store, replacing only external Milvus access."""
    client = MagicMock()
    client._using = "isolated-cleanup"
    stub = client._get_connection.return_value._stub
    stub.LoadCollection.return_value = common_pb2.Status()
    stub.GetLoadState.return_value = milvus_pb2.GetLoadStateResponse(
        state=LoadState.Loaded
    )
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
        assert isfinite(timeout) and timeout == 20.0
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


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Advance only when a simulated sleep or RPC consumes time."""
    clock = MagicMock()
    clock.now = 0.0

    def advance(seconds: float) -> None:
        assert seconds > 0
        clock.now += seconds

    clock.sleep.side_effect = advance
    clock.monotonic.side_effect = lambda: clock.now
    monkeypatch.setattr("knowledge_engine.storage.milvus_readiness.time", clock)
    return clock


def missing_index(field: str = "sparse_embedding") -> MilvusException:
    return MilvusException(
        65535,
        f"there is no vector index on field: [{field}], please create index firstly",
    )


@pytest.mark.parametrize("field", ["embedding", "sparse_embedding"])
def test_cleanup_waits_for_index_then_cleans_once(
    cleanup_client: MagicMock,
    clock: MagicMock,
    caplog: pytest.LogCaptureFixture,
    field: str,
) -> None:
    cleanup_client.has_collection.side_effect = None
    cleanup_client.has_collection.return_value = True
    cleanup_client.query.return_value = []
    error = missing_index(field)
    cleanup_client.load_collection.side_effect = error
    with caplog.at_level("INFO"):
        result = make_backend().delete_document("kb_1", "doc_123")

    assert result["status"] == "deleted"
    assert cleanup_client.load_collection.call_count == 1
    stub = cleanup_client._get_connection.return_value._stub
    stub.LoadCollection.assert_called_once()
    stub.GetLoadState.assert_called_once()
    assert cleanup_client.load_collection.call_args_list[0] == call(
        "test_kb_kb_1", timeout=20.0
    )
    assert 0 < stub.LoadCollection.call_args.kwargs["timeout"] < 5
    assert cleanup_client.query.call_count == 1
    assert [
        c.kwargs["collection_name"] for c in cleanup_client.delete.call_args_list
    ] == ["test_kb_kb_1", "test_kb_kb_1__parents"]
    assert 0 < clock.now <= 5
    summaries = [r.message for r in caplog.records if "index readiness" in r.message]
    assert len(summaries) == 1
    assert all(
        value in summaries[0]
        for value in ["test_kb_kb_1", "attempts=2", "elapsed=", str(error)]
    )


def test_cleanup_missing_index_exhausts_shared_budget(
    cleanup_client: MagicMock,
    clock: MagicMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    error = missing_index()
    timeouts = []

    def load(request: Any, *, timeout: float) -> common_pb2.Status:
        timeouts.append(timeout)
        assert 0 < timeout <= 5 - clock.now
        clock.now += min(1.0, timeout)
        return common_pb2.Status(code=65535, reason=error.message)

    cleanup_client.load_collection.side_effect = error
    cleanup_client._get_connection.return_value._stub.LoadCollection.side_effect = load
    with caplog.at_level("WARNING"), pytest.raises(MilvusException) as caught:
        make_backend().delete_document("kb_1", "doc_123")

    assert caught.value.message == error.message
    assert clock.now == pytest.approx(5.0)
    assert 1 < len(timeouts) < 10
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()
    assert cleanup_client.has_collection.call_count == 1
    summaries = [r.message for r in caplog.records if "index readiness" in r.message]
    assert len(summaries) == 1
    assert all(
        value in summaries[0]
        for value in [
            "test_kb_kb_1",
            f"attempts={1 + len(timeouts)}",
            "elapsed=",
            str(error),
        ]
    )


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("there is no vector index on field: [sparse_embedding]"),
        MilvusException(101, "there is no vector index on field: [sparse_embedding]"),
        missing_index("unrelated_field"),
        MilvusException(65535, "index sparse_embedding is corrupted"),
        MilvusException(65535, "permission denied"),
    ],
)
@pytest.mark.parametrize("after_missing_index", [False, True])
def test_cleanup_unrelated_errors_never_retry(
    cleanup_client: MagicMock,
    clock: MagicMock,
    error: Exception,
    after_missing_index: bool,
) -> None:
    cleanup_client.load_collection.side_effect = (
        missing_index() if after_missing_index else error
    )
    stub = cleanup_client._get_connection.return_value._stub
    stub.LoadCollection.side_effect = error
    with pytest.raises(type(error)) as caught:
        make_backend().delete_document("kb_1", "doc_123")
    assert caught.value is error
    assert cleanup_client.load_collection.call_count == 1
    assert stub.LoadCollection.call_count == (1 if after_missing_index else 0)
    assert clock.sleep.call_count == (1 if after_missing_index else 0)
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()
    assert cleanup_client.has_collection.call_count == 1


def test_cleanup_rpc_timeout_uses_remaining_budget(
    cleanup_client: MagicMock,
    clock: MagicMock,
    caplog: pytest.LogCaptureFixture,
) -> None:
    error = TimeoutError("load RPC exhausted remaining budget")
    attempts = 0

    def initial_load(collection_name: str, *, timeout: float) -> None:
        clock.now += 19.0
        raise missing_index()

    def load(request: Any, *, timeout: float) -> None:
        nonlocal attempts
        attempts += 1
        assert timeout == pytest.approx(4.8)
        clock.now += timeout
        raise error

    cleanup_client.load_collection.side_effect = initial_load
    cleanup_client._get_connection.return_value._stub.LoadCollection.side_effect = load
    with caplog.at_level("WARNING"), pytest.raises(TimeoutError) as caught:
        make_backend().delete_document("kb_1", "doc_123")
    assert caught.value is error
    assert clock.now == pytest.approx(24.0)
    assert attempts == 1
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()
    summaries = [r.message for r in caplog.records if "index readiness" in r.message]
    assert len(summaries) == 1
    assert "elapsed=5.000s" in summaries[0]
    assert str(error) in summaries[0]


def test_missing_child_collection_still_deletes_parent(
    cleanup_client: MagicMock,
) -> None:
    cleanup_client.has_collection.side_effect = lambda name: name.endswith("__parents")
    result = make_backend().delete_document("kb_1", "doc_123")
    assert result["status"] == "deleted"
    cleanup_client.load_collection.assert_not_called()
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_called_once_with(
        collection_name="test_kb_kb_1__parents",
        filter='knowledge_id == "kb_1" and doc_ref == "doc_123"',
    )


def test_cleanup_does_not_start_rpc_after_sleep_exhausts_budget(
    cleanup_client: MagicMock,
    clock: MagicMock,
) -> None:
    error = missing_index()
    cleanup_client.load_collection.side_effect = error

    def oversleep(seconds: float) -> None:
        clock.now += 5.0

    clock.sleep.side_effect = oversleep
    with pytest.raises(MilvusException) as caught:
        make_backend().delete_document("kb_1", "doc_123")
    assert caught.value is error
    cleanup_client.load_collection.assert_called_once_with("test_kb_kb_1", timeout=20.0)
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()


@pytest.mark.parametrize("final_state", [LoadState.Loaded, LoadState.Loading])
def test_cleanup_single_rpcs_share_budget_with_real_sdk(
    cleanup_client: MagicMock,
    clock: MagicMock,
    final_state: LoadState,
) -> None:
    """Keep SDK request/status handling real; replace only the gRPC transport."""
    handler = GrpcHandler.__new__(GrpcHandler)
    stub = MagicMock()
    handler._stub = stub
    cleanup_client._get_connection.return_value = handler
    cleanup_client.load_collection.side_effect = lambda name, timeout: (
        MilvusClient.load_collection(cleanup_client, name, timeout=timeout)
    )
    load_calls = 0

    def load(request: Any, *, timeout: float, **kwargs: Any) -> common_pb2.Status:
        nonlocal load_calls
        load_calls += 1
        assert request.collection_name == "test_kb_kb_1"
        if load_calls == 1:
            assert timeout == 20.0
            return common_pb2.Status(code=65535, reason=missing_index().message)
        assert timeout == pytest.approx(4.8)
        clock.now += 4.0
        return common_pb2.Status()

    def state(request: Any, *, timeout: float) -> milvus_pb2.GetLoadStateResponse:
        assert timeout == pytest.approx(0.8)
        clock.now += 0.4
        return milvus_pb2.GetLoadStateResponse(state=final_state)

    stub.LoadCollection.side_effect = load
    stub.GetLoadState.side_effect = state
    cleanup_client.query.return_value = []
    if final_state == LoadState.Loaded:
        result = make_backend().delete_document("kb_1", "doc_123")
        assert result["status"] == "deleted"
        assert clock.now == pytest.approx(4.6)
        cleanup_client.delete.assert_called_once()
    else:
        # First poll uses 0.4s; the next sleep leaves only 0.2s for the next RPC.
        def loading_state(
            request: Any, *, timeout: float
        ) -> milvus_pb2.GetLoadStateResponse:
            assert timeout <= 5.0 - clock.now + 1e-9
            clock.now += min(0.4, timeout)
            return milvus_pb2.GetLoadStateResponse(state=LoadState.Loading)

        stub.GetLoadState.side_effect = loading_state
        with pytest.raises(MilvusException):
            make_backend().delete_document("kb_1", "doc_123")
        assert clock.now == pytest.approx(5.0)
        cleanup_client.query.assert_not_called()
        cleanup_client.delete.assert_not_called()
    assert load_calls == 2
    stub.GetLoadingProgress.assert_not_called()


def test_cleanup_rejects_loaded_reply_after_deadline(
    cleanup_client: MagicMock,
    clock: MagicMock,
) -> None:
    error = missing_index()
    cleanup_client.load_collection.side_effect = error
    stub = cleanup_client._get_connection.return_value._stub

    def late_state(request: Any, *, timeout: float) -> milvus_pb2.GetLoadStateResponse:
        clock.now += 6.0
        return milvus_pb2.GetLoadStateResponse(state=LoadState.Loaded)

    stub.GetLoadState.side_effect = late_state
    with pytest.raises(MilvusException) as caught:
        make_backend().delete_document("kb_1", "doc_123")
    assert caught.value is error
    cleanup_client.query.assert_not_called()
    cleanup_client.delete.assert_not_called()

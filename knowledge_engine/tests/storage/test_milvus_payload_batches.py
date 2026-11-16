# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise native node serialization with a bounded Milvus RPC boundary."""

import json
from copy import deepcopy
from unittest.mock import MagicMock

import pytest
from llama_index.core.schema import TextNode
from llama_index.vector_stores.milvus import base as sdk
from milvus_contract_stubs import parent_insert_request
from pymilvus import DataType
from pymilvus.client.prepare import Prepare
from pymilvus.exceptions import DataNotMatchException, MilvusException

from knowledge_engine.storage.milvus_backend import (
    LazyAsyncMilvusVectorStore,
    MilvusBackend,
)
from knowledge_engine.storage.milvus_batching import MilvusRowTooLargeError


class MilvusBoundary:
    def __init__(self):
        self._using = "fixture-only"
        self.records = {}
        self.calls = []
        self.max_bytes = 1024 * 1024
        self.fail_call = None
        self.failure = ConnectionError("fixture: acknowledgement lost after write")
        self.client_initializations = 0
        self.schema_dynamic = True
        self.schema_refreshes = 0
        self.fields = [
            {
                "name": "id",
                "type": DataType.VARCHAR,
                "is_primary": True,
                "auto_id": False,
                "params": {"max_length": 65535},
            },
            {"name": "text", "type": DataType.VARCHAR, "params": {"max_length": 65535}},
            {
                "name": "embedding",
                "type": DataType.FLOAT_VECTOR,
                "params": {"dim": 1024},
            },
        ]

    def list_collections(self):
        return ["chunks"]

    def list_indexes(self, collection_name):
        return ["dense", "sparse"]

    def _get_connection(self):
        return self

    def _prepare_row_upsert_request(
        self, collection_name, rows, partition_name=None, timeout=None, **kwargs
    ):
        return Prepare.row_upsert_param(
            collection_name,
            rows,
            partition_name,
            self.fields,
            [],
            enable_dynamic=self.schema_dynamic,
            schema_timestamp=12345,
        )

    def update_schema(self, collection_name, timeout=None, **kwargs):
        self.schema_dynamic = True
        self.schema_refreshes += 1

    def upsert(
        self, collection_name, data, timeout=None, partition_name=None, **kwargs
    ):
        request = self._prepare_row_upsert_request(
            collection_name, data, partition_name, timeout, **kwargs
        )
        self.calls.append((request.ByteSize(), deepcopy(data), partition_name))
        if request.ByteSize() > self.max_bytes:
            raise MilvusException(code=65535, message="Broker: Message size too large")
        for row in data:
            self.records[row["id"]] = deepcopy(row)
        if len(self.calls) == self.fail_call:
            raise self.failure
        return {
            "upsert_count": len(data),
            "ids": [row["id"] for row in data],
            "cost": len(data),
        }


@pytest.fixture
def vector_store(monkeypatch):
    boundary = MilvusBoundary()

    def client(**kwargs):
        boundary.client_initializations += 1
        return boundary

    monkeypatch.setattr(sdk, "MilvusClient", client)
    collection = MagicMock()
    collection.schema.functions = [object()]
    monkeypatch.setattr(sdk, "Collection", lambda *a, **kw: collection)

    def create(**kwargs):
        return LazyAsyncMilvusVectorStore(
            uri="http://fixture.invalid",
            collection_name="chunks",
            dim=1024,
            upsert_mode=True,
            enable_sparse=False,
            index_management=sdk.IndexManagement.NO_VALIDATION,
            **kwargs,
        )

    return create, boundary


def nodes(count, text="表格内容" * 250, metadata=None):
    return [
        TextNode(
            id_=f"node-{i:04d}",
            text=text,
            metadata=metadata or {"display_text": text, "retrieval_text": text},
            embedding=[0.25] * 1024,
        )
        for i in range(count)
    ]


def test_native_add_splits_complete_payload_with_default_headroom(vector_store):
    create, boundary = vector_store
    store = create()
    chunks = nodes(135)

    result = store.add(chunks)

    assert result == [node.node_id for node in chunks]
    assert len(boundary.calls) > 2
    assert all(size <= 1024 * 1024 - 64 * 1024 for size, _, _ in boundary.calls)
    assert len(boundary.records) == 135
    for node in chunks:
        assert boundary.records[node.node_id]["text"] == node.text
        assert boundary.records[node.node_id]["embedding"] == node.embedding
        assert (
            boundary.records[node.node_id]["display_text"]
            == node.metadata["display_text"]
        )
        assert (
            json.loads(boundary.records[node.node_id]["_node_content"])["metadata"]
            == node.metadata
        )


def test_empty_add_does_not_prepare_or_write_a_request(vector_store):
    create, boundary = vector_store
    assert create().add([]) == []
    assert not boundary.calls


def test_configured_row_limit_is_retained(vector_store):
    create, boundary = vector_store
    store = create(batch_size=3)
    chunks = nodes(8, text="short")

    assert store.add(chunks) == [node.node_id for node in chunks]
    assert [len(rows) for _, rows, _ in boundary.calls] == [3, 3, 2]


def test_headroom_reduces_the_effective_message_budget(vector_store):
    create, boundary = vector_store
    chunks = nodes(2, text="short")
    create().add(chunks)
    size = boundary.calls[0][0]
    boundary.calls.clear()

    create(max_batch_bytes=size + 32, batch_headroom_bytes=64).add(chunks)

    assert [len(rows) for _, rows, _ in boundary.calls] == [1, 1]
    assert all(measured <= size - 32 for measured, _, _ in boundary.calls)


@pytest.mark.parametrize("component", ["text", "metadata", "vector"])
def test_single_oversized_row_is_reported_without_truncation(vector_store, component):
    create, boundary = vector_store
    text = "x" * 9000 if component == "text" else "small"
    metadata = (
        {"custom": "m" * 9000} if component == "metadata" else {"kind": "fixture"}
    )
    chunks = nodes(1, text=text, metadata=metadata)
    budget = 3000 if component == "vector" else 8000

    with pytest.raises(
        MilvusRowTooLargeError, match="node_id=node-0000.*serialized_bytes="
    ):
        create(max_batch_bytes=budget, batch_headroom_bytes=0).add(chunks)

    assert not boundary.calls
    assert chunks[0].text == text
    assert chunks[0].metadata == metadata


def test_single_oversized_row_prevents_partial_send_of_its_sdk_batch(vector_store):
    create, boundary = vector_store
    chunks = nodes(3, text="small")
    chunks[-1].text = "x" * 20000

    with pytest.raises(MilvusRowTooLargeError):
        create(max_batch_bytes=16000, batch_headroom_bytes=0).add(chunks)

    assert not boundary.calls


def test_broker_limit_lower_than_budget_shrinks_only_message_size_failures(
    vector_store,
):
    create, boundary = vector_store
    boundary.max_bytes = 40000
    chunks = nodes(8)

    assert create().add(chunks) == [node.node_id for node in chunks]
    assert any(size > boundary.max_bytes for size, _, _ in boundary.calls)
    assert len(boundary.records) == 8


def test_single_row_rejected_by_broker_is_an_explicit_error(vector_store):
    create, boundary = vector_store
    boundary.max_bytes = 1000

    with pytest.raises(MilvusRowTooLargeError, match="broker message-size limit"):
        create().add(nodes(1, text="small"))

    assert len(boundary.calls) == 1
    assert not boundary.records


def test_upsert_result_aggregates_native_counts_ids_and_cost(vector_store):
    create, boundary = vector_store
    store = create(batch_size=2)
    store.add(nodes(5, text="short"))
    rows = list(boundary.records.values())
    boundary.calls.clear()

    result = store.client.upsert("chunks", rows)

    assert result == {"upsert_count": 5, "ids": [row["id"] for row in rows], "cost": 5}
    assert [len(batch) for _, batch, _ in boundary.calls] == [2, 2, 1]


def test_partial_success_and_lost_acknowledgement_retry_upserts_same_ids(vector_store):
    create, boundary = vector_store
    chunks = nodes(5, text="unchanged body")
    store = create(batch_size=2)
    boundary.fail_call = 2

    with pytest.raises(ConnectionError, match="acknowledgement lost"):
        store.add(chunks, milvus_partition_name="partition-a")
    assert len(boundary.calls) == 2
    assert len(boundary.records) == 4

    boundary.fail_call = None
    assert store.add(chunks, milvus_partition_name="partition-a") == [
        node.node_id for node in chunks
    ]
    assert set(boundary.records) == {node.node_id for node in chunks}
    assert all(partition == "partition-a" for _, _, partition in boundary.calls)


def test_message_size_error_after_write_reuses_ids_when_splitting(vector_store):
    create, boundary = vector_store
    boundary.fail_call = 1
    boundary.failure = MilvusException(
        code=65535, message="Broker: Message size too large"
    )
    chunks = nodes(4, text="short")

    assert create().add(chunks) == [node.node_id for node in chunks]
    assert [len(batch) for _, batch, _ in boundary.calls] == [4, 2, 2]
    assert len(boundary.records) == 4


def test_other_milvus_errors_are_not_retried_or_split(vector_store):
    create, boundary = vector_store
    boundary.fail_call = 1
    boundary.failure = MilvusException(code=5, message="permission denied")

    with pytest.raises(MilvusException, match="permission denied"):
        create().add(nodes(4, text="short"))
    assert len(boundary.calls) == 1


@pytest.mark.parametrize(
    "options",
    [
        {"max_batch_bytes": 0},
        {"max_batch_bytes": True},
        {"batch_headroom_bytes": -1},
        {"batch_headroom_bytes": 1024 * 1024},
        {"batch_size": 0},
        {"batch_size": False},
    ],
)
def test_invalid_budget_is_rejected_before_client_initialization(vector_store, options):
    create, boundary = vector_store
    with pytest.raises(ValueError):
        create(**options)
    assert boundary.client_initializations == 0


def test_shared_backend_passes_explicit_limits_without_leaking_client_options(
    vector_store,
):
    _, boundary = vector_store
    backend = MilvusBackend(
        {
            "url": "http://fixture.invalid",
            "ext": {
                "batch_size": 3,
                "max_batch_bytes": 24000,
                "batch_headroom_bytes": 2000,
            },
        }
    )
    store = backend.create_vector_store("chunks", dim=1024)
    chunks = nodes(8, text="short")

    assert store.add(chunks) == [node.node_id for node in chunks]
    assert all(size <= 22000 and len(rows) <= 3 for size, rows, _ in boundary.calls)
    assert "max_batch_bytes" not in store._milvusclient_config["kwargs"]
    assert "batch_headroom_bytes" not in store._milvusclient_config["kwargs"]


class ParentMilvusBoundary(MilvusBoundary):
    def __init__(self):
        super().__init__()
        self.next_id = 0
        self.deletions = 0

    def has_collection(self, collection_name):
        return True

    def delete(self, **kwargs):
        self.deletions += 1
        self.records.clear()

    def _prepare_row_insert_request(
        self, collection_name, rows, partition_name=None, timeout=None, **kwargs
    ):
        return parent_insert_request(collection_name, rows, partition_name)

    def insert(
        self, collection_name, data, timeout=None, partition_name=None, **kwargs
    ):
        request = self._prepare_row_insert_request(
            collection_name, data, partition_name, timeout
        )
        self.calls.append((request.ByteSize(), deepcopy(data), partition_name))
        if request.ByteSize() > self.max_bytes:
            raise MilvusException(code=65535, message="Broker: Message size too large")
        ids = []
        for row in data:
            self.next_id += 1
            self.records[self.next_id] = deepcopy(row)
            ids.append(self.next_id)
        if len(self.calls) == self.fail_call:
            raise self.failure
        return {"insert_count": len(data), "ids": ids}


@pytest.mark.parametrize("lost_ack", [False, True])
def test_parent_writes_share_limits_and_replace_partial_previous_attempt(
    monkeypatch, lost_ack
):
    from knowledge_engine.storage import milvus_backend

    boundary = ParentMilvusBoundary()
    boundary.max_bytes = 12000
    monkeypatch.setattr(milvus_backend, "MilvusClient", lambda **kw: boundary)
    backend = MilvusBackend(
        {
            "url": "http://fixture.invalid",
            "ext": {
                "batch_size": 2,
                "max_batch_bytes": 12000,
                "batch_headroom_bytes": 1000,
            },
        }
    )
    chunks = nodes(
        5,
        text="parent body" * 100,
        metadata={"doc_ref": "doc-1", "source_file": "input.xlsx"},
    )
    if lost_ack:
        boundary.fail_call = 2
        with pytest.raises(ConnectionError):
            backend.save_parent_nodes("kb-1", chunks)
        assert len(boundary.records) == 4
        boundary.fail_call = None

    result = backend.save_parent_nodes("kb-1", chunks)

    assert result == {"stored_count": 5}
    assert all(size <= 11000 and len(rows) <= 2 for size, rows, _ in boundary.calls)
    assert len(boundary.records) == 5
    assert {row["parent_node_id"] for row in boundary.records.values()} == {
        node.node_id for node in chunks
    }


def test_stale_schema_refreshes_before_sizing_without_bypassing_native_encoding(
    vector_store,
):
    create, boundary = vector_store
    boundary.schema_dynamic = False
    chunks = nodes(2, text="short")

    assert create().add(chunks) == [node.node_id for node in chunks]
    assert boundary.schema_refreshes == 1
    assert len(boundary.records) == 2


def test_schema_error_remaining_after_refresh_is_not_hidden_or_retried(
    vector_store, monkeypatch
):
    create, boundary = vector_store
    boundary.schema_dynamic = False

    def unchanged_schema(*args, **kwargs):
        boundary.schema_refreshes += 1

    monkeypatch.setattr(boundary, "update_schema", unchanged_schema)
    with pytest.raises(DataNotMatchException):
        create().add(nodes(1, text="short"))
    assert boundary.schema_refreshes == 1
    assert not boundary.calls


def test_single_oversized_parent_does_not_delete_previous_parent_set(monkeypatch):
    from knowledge_engine.storage import milvus_backend

    boundary = ParentMilvusBoundary()
    boundary.records[1] = {"parent_node_id": "previous-parent"}
    monkeypatch.setattr(milvus_backend, "MilvusClient", lambda **kw: boundary)
    backend = MilvusBackend(
        {
            "url": "http://fixture.invalid",
            "ext": {
                "max_batch_bytes": 12000,
                "batch_headroom_bytes": 1000,
            },
        }
    )
    chunks = nodes(1, text="x" * 15000, metadata={"doc_ref": "doc-1"})

    with pytest.raises(MilvusRowTooLargeError, match="node_id=node-0000"):
        backend.save_parent_nodes("kb-1", chunks)
    assert boundary.deletions == 0
    assert boundary.records == {1: {"parent_node_id": "previous-parent"}}


@pytest.mark.parametrize("acknowledgement_lost", [False, True])
def test_auto_id_parent_broker_rejection_is_not_replayed(
    monkeypatch, acknowledgement_lost
):
    from knowledge_engine.storage import milvus_backend

    boundary = ParentMilvusBoundary()
    if acknowledgement_lost:
        boundary.fail_call = 1
        boundary.failure = MilvusException(
            code=65535, message="Broker: Message size too large"
        )
    else:
        boundary.max_bytes = 1
    monkeypatch.setattr(milvus_backend, "MilvusClient", lambda **kw: boundary)
    backend = MilvusBackend({"url": "http://fixture.invalid"})
    chunks = nodes(3, text="unchanged parent", metadata={"doc_ref": "doc-1"})

    with pytest.raises(MilvusException, match="Message size too large"):
        backend.save_parent_nodes("kb-1", chunks)

    # Both outcomes have the same error at the client. Replaying smaller inserts
    # would duplicate the already-written auto-ID rows in the second outcome.
    assert len(boundary.calls) == 1
    assert len(boundary.calls[0][1]) == 3
    assert len(boundary.records) == (3 if acknowledgement_lost else 0)

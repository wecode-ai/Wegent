# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the physical drop of a knowledge base's Milvus storage.

A dedicated knowledge base owns two collections: the retrieval index and the
parent sidecar. Dropping them is destructive, so the order is the whole
promise: the contract the index collection declares about itself is what
confirms both names belong to this knowledge base, and a drop that fails
halfway must leave the next attempt able to finish the job instead of being
refused forever by the collection the first step already removed.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator, Set

import pytest

from knowledge_engine.storage.milvus.cleanup import MilvusCleanup
from knowledge_engine.storage.milvus.errors import IndexMissingError
from knowledge_engine.storage.milvus.native import SCHEMA_VERSION, MilvusIndexBinding

COLLECTION_NAME = "wegent_kb_1"
PARENT_COLLECTION_NAME = "wegent_kb_1__parents"
CONTRACT = MilvusIndexBinding(
    schema_version=SCHEMA_VERSION,
    dimension=1536,
    embedding_space_id="sha256:abc",
)


class _DropClient:
    """The server's collection registry, with drops that can be made to fail."""

    def __init__(self, collections: Set[str], *, failing: Set[str] | None = None):
        self.collections = set(collections)
        self.failing = set(failing or ())
        self.dropped: list[str] = []

    def has_collection(self, collection_name: str, **kwargs: Any) -> bool:
        return collection_name in self.collections

    def drop_collection(self, collection_name: str, **kwargs: Any) -> None:
        if collection_name in self.failing:
            raise RuntimeError(f"the drop RPC of {collection_name} failed")
        self.dropped.append(collection_name)
        self.collections.discard(collection_name)


class _FakeStore:
    """The ``MilvusDocumentStore`` surface a physical drop reaches for."""

    def __init__(self, client: _DropClient) -> None:
        self.client_instance = client
        self.rpc_timeout = 5.0
        self.contract_reads: list[str] = []

    @contextmanager
    def client(self) -> Iterator[_DropClient]:
        yield self.client_instance

    def read_contract(self, client: _DropClient, collection_name: str):
        self.contract_reads.append(collection_name)
        return CONTRACT if collection_name in client.collections else None

    def has_collection(self, client: _DropClient, collection_name: str) -> bool:
        return client.has_collection(collection_name)


def _cleanup(store: _FakeStore) -> MilvusCleanup:
    return MilvusCleanup(
        store_for=lambda: store,
        collection_name_for=lambda knowledge_id, **kwargs: COLLECTION_NAME,
        parent_collection_name_for=lambda knowledge_id, **kwargs: (
            PARENT_COLLECTION_NAME
        ),
        parent_scope_filter=lambda knowledge_id, doc_ref=None: "",
        ensure_can_drop_physical_index=lambda: None,
    )


def test_a_drop_removes_both_collections_sidecar_first() -> None:
    """The sidecar goes before the index that confirms these names are ours."""
    client = _DropClient({COLLECTION_NAME, PARENT_COLLECTION_NAME})
    store = _FakeStore(client)

    result = _cleanup(store).drop_knowledge_index("1")

    assert result == {
        "knowledge_id": "1",
        "collection_name": COLLECTION_NAME,
        "dropped_parent_collection": True,
        "status": "dropped",
    }
    assert store.contract_reads == [COLLECTION_NAME]
    assert client.dropped == [PARENT_COLLECTION_NAME, COLLECTION_NAME]
    assert client.collections == set()


def test_a_knowledge_base_without_a_sidecar_still_drops_its_index() -> None:
    """A retrieval index that never stored a parent node is still dropped."""
    client = _DropClient({COLLECTION_NAME})

    result = _cleanup(_FakeStore(client)).drop_knowledge_index("1")

    assert result["dropped_parent_collection"] is False
    assert client.dropped == [COLLECTION_NAME]
    assert client.collections == set()


def test_a_failed_sidecar_drop_leaves_the_index_for_the_retry() -> None:
    """The index survives a half-finished drop, so the retry can still confirm it.

    The contract lives in the index collection, so dropping it first would make
    the sidecar unidentifiable and the retry impossible: the step that can fail
    must be the one that can be repeated.
    """
    client = _DropClient(
        {COLLECTION_NAME, PARENT_COLLECTION_NAME},
        failing={PARENT_COLLECTION_NAME},
    )
    cleanup = _cleanup(_FakeStore(client))

    with pytest.raises(RuntimeError):
        cleanup.drop_knowledge_index("1")

    assert client.collections == {COLLECTION_NAME, PARENT_COLLECTION_NAME}

    client.failing = set()
    result = cleanup.drop_knowledge_index("1")

    assert result["dropped_parent_collection"] is True
    assert client.dropped == [PARENT_COLLECTION_NAME, COLLECTION_NAME]
    assert client.collections == set()


def test_a_failed_index_drop_is_finished_by_the_retry() -> None:
    """A retry finishes the drop the sidecar-only step already completed."""
    client = _DropClient(
        {COLLECTION_NAME, PARENT_COLLECTION_NAME},
        failing={COLLECTION_NAME},
    )
    cleanup = _cleanup(_FakeStore(client))

    with pytest.raises(RuntimeError):
        cleanup.drop_knowledge_index("1")

    assert client.collections == {COLLECTION_NAME}

    client.failing = set()
    result = cleanup.drop_knowledge_index("1")

    assert result["dropped_parent_collection"] is False
    # The sidecar went in the first attempt, so the retry only finishes the
    # index.
    assert client.dropped == [PARENT_COLLECTION_NAME, COLLECTION_NAME]
    assert client.collections == set()


def test_a_sidecar_without_its_index_is_never_dropped() -> None:
    """Nothing but the index contract identifies a collection as this one's."""
    client = _DropClient({PARENT_COLLECTION_NAME})

    with pytest.raises(IndexMissingError):
        _cleanup(_FakeStore(client)).drop_knowledge_index("1")

    assert client.dropped == []
    assert client.collections == {PARENT_COLLECTION_NAME}


def test_a_knowledge_base_with_no_collection_is_dropped_idempotently() -> None:
    """Dropping what is already gone answers the same way, and touches nothing."""
    client = _DropClient(set())

    result = _cleanup(_FakeStore(client)).drop_knowledge_index("1")

    assert result["status"] == "dropped"
    assert result["dropped_parent_collection"] is False
    assert client.dropped == []

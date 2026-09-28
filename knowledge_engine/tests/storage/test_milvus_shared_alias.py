# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Contract: temporary MilvusClient handles keep the process-shared alias alive.

pymilvus derives one process-global connection alias per ``(uri, token,
db_name)`` and ``MilvusClient.close()`` removes that alias for every holder.
A short-lived client closed by a backend operation therefore disconnects the
vector-store writer that shares the alias from a parallel task, which then
fails with "should create connection first".
"""

import hashlib
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import patch

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.storage.milvus_backend import MilvusBackend


class SharedAliasRegistry:
    """Mirror of the process-global alias registry pymilvus keeps in memory."""

    def __init__(self) -> None:
        self._aliases: List[str] = []

    def acquire(self, uri: str, token: str, db_name: str) -> str:
        alias = self._alias_for(uri, token, db_name)
        if alias not in self._aliases:
            self._aliases.append(alias)
        return alias

    def release(self, alias: str) -> None:
        # pymilvus' remove_connection drops the alias for every holder at once.
        if alias in self._aliases:
            self._aliases.remove(alias)

    def is_connected(self, alias: str) -> bool:
        return alias in self._aliases

    @staticmethod
    def _alias_for(uri: str, token: str, db_name: str) -> str:
        auth = hashlib.md5(token.encode(), usedforsecurity=False).hexdigest()
        return "-".join(part for part in (uri, db_name, auth if token else "") if part)


class ConnectionLostError(RuntimeError):
    """Stands in for pymilvus' ConnectionNotExistException."""


class SharedAliasMilvusClient:
    """MilvusClient double that preserves the shared-alias lifecycle."""

    registry: Optional[SharedAliasRegistry] = None

    def __init__(
        self, uri: str, token: str = "", db_name: str = "", **kwargs: Any
    ) -> None:
        self._using = self._registry().acquire(uri, token, db_name)

    def close(self) -> None:
        self._registry().release(self._using)

    def has_collection(self, collection_name: str) -> bool:
        self._check_connection()
        return False

    def list_collections(self) -> List[str]:
        self._check_connection()
        return []

    def describe_collection(self, **kwargs: Any) -> Dict[str, Any]:
        self._check_connection()
        return {"fields": []}

    def query(self, **kwargs: Any) -> List[Dict[str, Any]]:
        self._check_connection()
        return []

    def delete(self, **kwargs: Any) -> None:
        self._check_connection()

    def drop_collection(self, **kwargs: Any) -> None:
        self._check_connection()

    def create_collection(self, **kwargs: Any) -> None:
        self._check_connection()

    def insert(self, **kwargs: Any) -> None:
        self._check_connection()

    def _check_connection(self) -> None:
        if not self._registry().is_connected(self._using):
            raise ConnectionLostError("should create connection first")

    @classmethod
    def _registry(cls) -> SharedAliasRegistry:
        if cls.registry is None:
            raise AssertionError("SharedAliasMilvusClient.registry is not configured")
        return cls.registry


CONFIG: Dict[str, Any] = {
    "url": "http://milvus:19530/knowledge",
    "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
}


def _backend() -> MilvusBackend:
    return MilvusBackend(dict(CONFIG))


def _parallel_writer(backend: MilvusBackend) -> SharedAliasMilvusClient:
    """The writer another task holds on the very same alias."""
    return SharedAliasMilvusClient(
        uri=backend.base_url, token=backend.token, db_name=backend.db_name
    )


def _list_documents(backend: MilvusBackend) -> None:
    backend.list_documents(knowledge_id="kb_1")


def _get_all_chunks(backend: MilvusBackend) -> None:
    backend.get_all_chunks(knowledge_id="kb_1", max_chunks=5)


def _retrieve(backend: MilvusBackend) -> None:
    backend.retrieve(
        knowledge_id="kb_1",
        query="hello",
        embed_model=None,
        retrieval_setting={"retrieval_mode": "keyword", "top_k": 3},
    )


def _delete_knowledge(backend: MilvusBackend) -> None:
    backend.delete_knowledge(knowledge_id="kb_1")


def _delete_document(backend: MilvusBackend) -> None:
    backend.delete_document(knowledge_id="kb_1", doc_ref="doc_1")


def _delete_parent_nodes(backend: MilvusBackend) -> None:
    backend.delete_parent_nodes(knowledge_id="kb_1", doc_ref="doc_1")


def _drop_knowledge_index(backend: MilvusBackend) -> None:
    backend.drop_knowledge_index(knowledge_id="kb_1")


def _get_parent_nodes(backend: MilvusBackend) -> None:
    backend.get_parent_nodes(knowledge_id="kb_1", parent_node_ids=["node_1"])


def _save_parent_nodes(backend: MilvusBackend) -> None:
    backend.save_parent_nodes(knowledge_id="kb_1", parent_nodes=[TextNode(text="p")])


def _test_connection(backend: MilvusBackend) -> None:
    backend.test_connection()


OPERATIONS: List[Callable[[MilvusBackend], None]] = [
    _list_documents,
    _get_all_chunks,
    _retrieve,
    _delete_knowledge,
    _delete_document,
    _delete_parent_nodes,
    _drop_knowledge_index,
    _get_parent_nodes,
    _save_parent_nodes,
    _test_connection,
]


@pytest.mark.parametrize(
    "operation", OPERATIONS, ids=[op.__name__ for op in OPERATIONS]
)
def test_backend_operation_keeps_the_shared_alias_connected(
    operation: Callable[[MilvusBackend], None],
) -> None:
    """A parallel writer sharing the alias keeps its connection."""
    registry = SharedAliasRegistry()
    with (
        patch.object(SharedAliasMilvusClient, "registry", registry),
        patch(
            "knowledge_engine.storage.milvus_backend.MilvusClient",
            SharedAliasMilvusClient,
        ),
    ):
        backend = _backend()
        writer = _parallel_writer(backend)

        operation(backend)

        assert writer.list_collections() == []

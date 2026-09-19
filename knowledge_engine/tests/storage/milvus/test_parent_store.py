# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document-scoped reads of the Milvus parent sidecar.

The sidecar keeps one row per parent node, and a parent node id is only unique
inside the document that stored it. These tests drive the read seam directly to
pin the two promises that follow: one query serves the whole expansion, and a
parent id the request cannot attribute to exactly one document is never
answered from whichever document happened to match.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Dict, List

from llama_index.core.schema import TextNode

from knowledge_engine.storage.milvus.parent_store import MilvusParentStore


class FakeParentClient:
    """Records the one query a parent read is allowed to issue."""

    def __init__(self, records: List[Dict[str, Any]]) -> None:
        self.records = list(records)
        self.queries: List[Dict[str, Any]] = []
        self.inserted: List[Dict[str, Any]] = []

    def has_collection(
        self, collection_name: str, timeout: float | None = None
    ) -> bool:
        del collection_name, timeout
        return True

    def query(self, **kwargs: Any) -> List[Dict[str, Any]]:
        self.queries.append(kwargs)
        return list(self.records)

    def insert(self, **kwargs: Any) -> Dict[str, Any]:
        self.inserted.extend(kwargs["data"])
        return {"insert_count": len(kwargs["data"])}


class FakeParentStore:
    def __init__(self, client: FakeParentClient) -> None:
        self.client_instance = client
        self.rpc_timeout = 10.0
        self.deletes: List[Dict[str, Any]] = []

    def has_collection(self, client: FakeParentClient, collection_name: str) -> bool:
        return True

    def delete_rows(
        self,
        client: FakeParentClient,
        collection_name: str,
        filter_expr: str,
        *,
        flush: bool = True,
    ) -> int:
        self.deletes.append(
            {
                "collection_name": collection_name,
                "filter": filter_expr,
                "flush": flush,
            }
        )
        return 0

    @contextmanager
    def client(self):
        yield self.client_instance


def _parent_store_with_backing(
    client: FakeParentClient,
) -> tuple[MilvusParentStore, FakeParentStore]:
    backing = FakeParentStore(client)
    return (
        MilvusParentStore(
            store=backing,
            collection_name_for=lambda knowledge_id, **kwargs: "wegent_kb_1__parents",
            display_text_for=lambda node: node.get_content(),
        ),
        backing,
    )


def _parent_store(client: FakeParentClient) -> MilvusParentStore:
    parent_store, _ = _parent_store_with_backing(client)
    return parent_store


def _parent_node(node_id: str, *, doc_ref: str | None = None) -> TextNode:
    metadata = {} if doc_ref is None else {"doc_ref": doc_ref}
    return TextNode(id_=node_id, text=f"body of {node_id}", metadata=metadata)


def test_a_parent_write_replaces_the_document_it_was_given() -> None:
    """The removal scope is the indexed document, not the first node's field."""
    parent_store, backing = _parent_store_with_backing(FakeParentClient([]))
    nodes = [_parent_node("parent-a"), _parent_node("parent-b", doc_ref="doc_1")]

    parent_store.save("1", nodes, doc_ref="doc_1")

    [deleted] = backing.deletes
    assert deleted["collection_name"] == "wegent_kb_1__parents"
    assert 'knowledge_id == "1"' in deleted["filter"]
    assert 'doc_ref in ["doc_1"]' in deleted["filter"]


def test_a_parent_write_without_an_explicit_document_uses_every_node() -> None:
    """An older call site still replaces every document the nodes name."""
    parent_store, backing = _parent_store_with_backing(FakeParentClient([]))
    nodes = [_parent_node("parent-a"), _parent_node("parent-b", doc_ref="doc_2")]

    parent_store.save("1", nodes)

    [deleted] = backing.deletes
    assert 'doc_ref in ["doc_2"]' in deleted["filter"]


def test_a_parent_write_ignores_nodes_that_name_no_document() -> None:
    """A node without a document never widens the removal to an empty scope."""
    parent_store, backing = _parent_store_with_backing(FakeParentClient([]))

    result = parent_store.save("1", [_parent_node("parent-a")])

    assert result == {"stored_count": 1}
    assert backing.deletes == []


def _record(doc_ref: str, parent_node_id: str, content: str) -> Dict[str, Any]:
    return {
        "doc_ref": doc_ref,
        "parent_node_id": parent_node_id,
        "content": content,
        "title": "doc.txt",
        "metadata_json": '{"doc_ref": "'
        + doc_ref
        + '", "parent_node_id": "'
        + parent_node_id
        + '"}',
    }


def test_parent_reads_use_one_query_for_all_document_scoped_pairs() -> None:
    """Every declared pair is matched by one query, not one query per id."""
    client = FakeParentClient(
        [
            _record("doc_1", "p1", "first parent"),
            _record("doc_2", "p2", "second parent"),
        ]
    )
    store = _parent_store(client)

    records = store.get(
        "1",
        ["p1", "p2"],
        parent_refs=[("doc_1", "p1"), ("doc_2", "p2")],
    )

    assert set(records) == {"p1", "p2"}
    assert records["p1"]["content"] == "first parent"
    assert records["p2"]["metadata"] == {"doc_ref": "doc_2", "parent_node_id": "p2"}
    [query] = client.queries
    assert query["collection_name"] == "wegent_kb_1__parents"
    assert query["limit"] == 2
    assert query["timeout"] == 10.0
    assert 'knowledge_id == "1"' in query["filter"]
    assert '(doc_ref == "doc_1" and parent_node_id == "p1")' in query["filter"]
    assert '(doc_ref == "doc_2" and parent_node_id == "p2")' in query["filter"]
    assert " or " in query["filter"]


def test_a_parent_id_mapped_to_two_documents_is_not_expanded() -> None:
    """An ambiguous parent id is left out instead of answered from one document."""
    client = FakeParentClient([_record("doc_1", "p1", "first parent")])
    store = _parent_store(client)

    records = store.get(
        "1",
        ["p1"],
        parent_refs=[("doc_1", "p1"), ("doc_2", "p1")],
    )

    assert records == {}
    assert client.queries == []


def test_a_parent_read_without_document_pairs_expands_nothing() -> None:
    """A read that declares no document scope cannot be proven safe, so it is empty."""
    client = FakeParentClient([_record("doc_1", "p1", "first parent")])
    store = _parent_store(client)

    assert store.get("1", ["p1"]) == {}
    assert client.queries == []


def test_a_row_outside_the_declared_pairs_is_never_returned() -> None:
    """The document half is matched in the adapter, not only in the filter."""
    client = FakeParentClient(
        [
            _record("doc_1", "p1", "wanted"),
            _record("doc_9", "p1", "other document"),
        ]
    )
    store = _parent_store(client)

    records = store.get("1", ["p1"], parent_refs=[("doc_1", "p1")])

    assert records == {
        "p1": {
            "content": "wanted",
            "title": "doc.txt",
            "metadata": {"doc_ref": "doc_1", "parent_node_id": "p1"},
        }
    }

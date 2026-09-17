# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus contract tests for the task 03 content reading paths.

These tests drive ``get_document``, ``list_documents`` and ``get_all_chunks``
against a real Milvus service and prove the three reading promises the spec
makes: the metadata condition narrows the read before the limit, static data
pages without gaps or repeats, and a complete answer is never a truncated one.
"""

from __future__ import annotations

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus_backend import MilvusBackend

from .conftest import MilvusContractEnv, index_nodes

pytestmark = pytest.mark.milvus


def _nodes(count: int, *, category: str | None = None) -> list[TextNode]:
    metadata = {"category": category} if category is not None else {}
    return [
        TextNode(text=f"chunk {index} content", metadata=dict(metadata))
        for index in range(count)
    ]


def test_chunk_listing_keeps_a_match_behind_the_read_limit(
    milvus_env: MilvusContractEnv,
) -> None:
    """250 non-matching rows written first never hide the matches."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8101",
        nodes=_nodes(250, category="filler"),
    )
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8102",
        nodes=_nodes(20, category="target"),
    )

    chunks = backend.get_all_chunks(
        knowledge_id,
        max_chunks=20,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "category", "operator": "eq", "value": "target"}],
        },
    )

    assert len(chunks) == 20
    assert {chunk["doc_ref"] for chunk in chunks} == {"8102"}
    assert all(chunk["metadata"]["category"] == "target" for chunk in chunks)


def test_chunk_listing_applies_a_text_condition_before_the_read_limit(
    milvus_env: MilvusContractEnv,
) -> None:
    """The reading path reuses the compiled substring contract."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8201",
        nodes=_nodes(60, category="filler"),
    )
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8202",
        nodes=_nodes(5, category="release-2026-candidate"),
    )

    chunks = backend.get_all_chunks(
        knowledge_id,
        max_chunks=5,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "category", "operator": "contains", "value": "2026"}
            ],
        },
    )

    assert len(chunks) == 5
    assert {chunk["doc_ref"] for chunk in chunks} == {"8202"}


def test_chunk_listing_keeps_the_partial_result_semantics(
    milvus_env: MilvusContractEnv,
) -> None:
    """At, under and over the cap: a caller asking for at most N gets at most N."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8301",
        nodes=_nodes(30),
    )

    capped = backend.get_all_chunks(knowledge_id, max_chunks=10)
    capped_again = backend.get_all_chunks(knowledge_id, max_chunks=10)
    exactly_the_cap = backend.get_all_chunks(knowledge_id, max_chunks=30)
    above_the_cap = backend.get_all_chunks(knowledge_id, max_chunks=100)
    numeric_condition = backend.get_all_chunks(
        knowledge_id,
        max_chunks=5,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "chunk_index", "operator": "gte", "value": 25}],
        },
    )

    assert len(capped) == 10
    assert [chunk["chunk_id"] for chunk in capped_again] == [
        chunk["chunk_id"] for chunk in capped
    ], "repeating the same read over static data must not drift"
    assert [chunk["chunk_id"] for chunk in exactly_the_cap] == list(range(30))
    assert len(above_the_cap) == 30
    assert [chunk["chunk_id"] for chunk in numeric_condition] == [25, 26, 27, 28, 29]


def test_chunk_listing_still_accepts_a_doc_ref_condition(
    milvus_env: MilvusContractEnv,
) -> None:
    """The listing path keeps the document condition the other engines serve."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8351",
        nodes=_nodes(2),
    )
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8352",
        nodes=_nodes(3),
    )

    chunks = backend.get_all_chunks(
        knowledge_id,
        max_chunks=10,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "doc_ref", "operator": "eq", "value": "8352"}],
        },
    )

    assert [chunk["doc_ref"] for chunk in chunks] == ["8352"] * 3


def test_document_listing_pages_static_data_without_gaps_or_repeats(
    milvus_env: MilvusContractEnv,
) -> None:
    """Every document appears on exactly one page, with the true total."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    doc_refs = [f"84{index:02d}" for index in range(1, 6)]
    for doc_ref in reversed(doc_refs):
        index_nodes(
            backend,
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            nodes=_nodes(2),
        )

    pages = [
        backend.list_documents(knowledge_id, page=page, page_size=2)
        for page in (1, 2, 3)
    ]
    collected = [doc["doc_ref"] for page in pages for doc in page["documents"]]

    assert collected == sorted(doc_refs)
    assert sorted(collected) == sorted(set(collected)), "no document repeats"
    assert [page["total"] for page in pages] == [len(doc_refs)] * 3
    assert all(doc["chunk_count"] == 2 for page in pages for doc in page["documents"])


def test_reading_more_rows_than_one_internal_page_stays_complete(
    milvus_env: MilvusContractEnv,
) -> None:
    """A complete read walks the server's pages instead of stopping at one."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    long_document_chunks = 1200
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8451",
        nodes=_nodes(long_document_chunks),
    )
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8452",
        nodes=_nodes(3),
    )

    document = backend.get_document(knowledge_id, "8451")
    listing = backend.list_documents(knowledge_id, page=1, page_size=10)

    assert document["chunk_count"] == long_document_chunks
    assert [chunk["chunk_index"] for chunk in document["chunks"]] == list(
        range(long_document_chunks)
    )
    assert listing["total"] == 2
    assert {doc["doc_ref"]: doc["chunk_count"] for doc in listing["documents"]} == {
        "8451": long_document_chunks,
        "8452": 3,
    }


def test_get_document_returns_only_its_own_chunks_in_order(
    milvus_env: MilvusContractEnv,
) -> None:
    """One document's chunks come back complete and in chunk order."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8501",
        nodes=_nodes(12),
    )
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8502",
        nodes=_nodes(5),
    )

    document = backend.get_document(knowledge_id, "8501")

    assert document["doc_ref"] == "8501"
    assert document["chunk_count"] == 12
    assert document["source_file"] == "document-8501.txt"
    assert [chunk["chunk_index"] for chunk in document["chunks"]] == list(range(12))
    assert [chunk["content"] for chunk in document["chunks"]] == [
        f"chunk {index} content" for index in range(12)
    ]
    assert {chunk["metadata"]["doc_ref"] for chunk in document["chunks"]} == {"8501"}


def test_reads_of_an_unindexed_knowledge_base_create_nothing(
    milvus_env: MilvusContractEnv,
) -> None:
    """Reading a knowledge base that was never indexed invents no resource."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()

    with pytest.raises(ValueError):
        backend.get_document(knowledge_id, "8601")
    assert backend.get_all_chunks(knowledge_id) == []
    listing = backend.list_documents(knowledge_id)
    assert listing == {
        "documents": [],
        "total": 0,
        "page": 1,
        "page_size": 20,
        "knowledge_id": knowledge_id,
    }
    assert milvus_env.has_collection(knowledge_id) is False


def test_reads_never_adopt_a_collection_that_replaced_the_index(
    milvus_env: MilvusContractEnv,
) -> None:
    """A foreign collection under the index name is refused, not read.

    The contract lives in the collection (ticket 12), so an index that was
    dropped outside the product leaves nothing to detect. What stays
    detectable - and must stay loud - is the replacement: a collection that
    answers under the index name while declaring no contract of ours is never
    read, so its rows can never be reported as this knowledge base's content.
    """
    from pymilvus import MilvusClient

    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="8651",
        nodes=_nodes(2),
    )

    client = MilvusClient(uri=milvus_env.uri)
    try:
        client.drop_collection(backend.get_index_name(knowledge_id))
        client.create_collection(
            collection_name=backend.get_index_name(knowledge_id),
            dimension=1536,
        )
    finally:
        client.close()

    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks(knowledge_id)
    with pytest.raises(IndexContractIncompatibleError):
        backend.get_document(knowledge_id, "8651")
    with pytest.raises(IndexContractIncompatibleError):
        backend.list_documents(knowledge_id)

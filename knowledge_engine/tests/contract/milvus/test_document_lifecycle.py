# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus contract tests for rewriting, parents and deleting documents.

Every case drives the entries the business services use - ``DocumentService``
for the write and the delete, ``QueryExecutor`` for the read - so the
assertions describe the content, the parent expansion and the scope a user
ends up with instead of the SDK calls the adapter happens to make.

The rewrite cases index the same document twice through the write entry: the
seam the indexing task calls while it holds the document lock
(``knowledge:index_document:{document_id}``), one write per document. Clearing
the previous version is MilvusBackend's own step inside that write, so this
seam performs no pre-delete at all. A rewrite may be temporarily unsearchable,
but it must never report success while the previous version is still readable
next to the new one.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest

from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.milvus.backend import MilvusBackend

from .conftest import (
    CONTRACT_DIMENSION,
    DeterministicEmbedding,
    MilvusContractEnv,
    await_document_visibility,
    await_parent_removal,
    drop_collection_with_contract,
)

pytestmark = pytest.mark.milvus

CONTRACT_USER_ID = 1
SHARED_USER_ID = 7

FLAT_SPLITTER = {
    "chunk_strategy": "flat",
    "format_enhancement": "none",
    "flat_config": {"chunk_size": 128, "chunk_overlap": 0, "separator": "\n\n"},
}
HIERARCHICAL_SPLITTER = {
    "chunk_strategy": "hierarchical",
    "format_enhancement": "none",
    "hierarchical_config": {
        "parent_chunk_size": 256,
        "child_chunk_size": 128,
        "child_chunk_overlap": 0,
        "parent_separator": "\n\n",
        "child_separator": "\n",
    },
}


def _paragraph(key: str, index: int) -> str:
    return f"{key} paragraph {index} " + "topic filler sentence " * 3


def _document_text(*, key: str, tail_marker: str, paragraphs: int = 7) -> str:
    body = [_paragraph(key, index) for index in range(paragraphs)]
    body.append(f"{tail_marker} closing paragraph " + "topic filler sentence " * 3)
    return "\n\n".join(body)


def _hierarchical_text(*, marker: str, key: str, paragraphs: int = 3) -> str:
    opening = f"{marker} opening paragraph " + "topic filler sentence " * 3
    return "\n\n".join(
        [opening] + [_paragraph(key, index) for index in range(paragraphs)]
    )


def _index_document(
    env: MilvusContractEnv,
    *,
    knowledge_id: str,
    document_id: int,
    text: str,
    splitter_config: dict,
    backend: MilvusBackend | None = None,
    model: DeterministicEmbedding | None = None,
    user_id: int = CONTRACT_USER_ID,
) -> tuple[MilvusBackend, DeterministicEmbedding, dict]:
    """Write one document through the entry the document service uses."""
    backend = backend or env.backend()
    model = model or DeterministicEmbedding(CONTRACT_DIMENSION)
    service = DocumentService(storage_backend=backend)
    result = asyncio.run(
        service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=text.encode("utf-8"),
            source_file=f"document-{document_id}.txt",
            file_extension=".txt",
            embed_model=model,
            user_id=user_id,
            splitter_config=splitter_config,
            document_id=document_id,
        )
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=str(document_id),
        expected_chunks=result["chunk_count"],
        user_id=user_id,
    )
    return backend, model, result


def _query(
    *,
    knowledge_id: str,
    query: str,
    backend: MilvusBackend,
    model: DeterministicEmbedding,
    user_id: int = CONTRACT_USER_ID,
    top_k: int = 5,
) -> dict:
    executor = QueryExecutor(storage_backend=backend, embed_model=model)
    return asyncio.run(
        executor.execute(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_config={
                "top_k": top_k,
                "score_threshold": 0.0,
                "retrieval_mode": "vector",
            },
            user_id=user_id,
        )
    )


def _doc_refs(records: list[dict]) -> set[str]:
    return {record["metadata"]["doc_ref"] for record in records}


def _mentioning(records: list[dict], marker: str) -> list[dict]:
    """Keep the records whose readable body carries the marker.

    A zero threshold keeps every candidate the index holds, including rows
    whose cosine score is exactly zero, so a marker assertion has to look at
    the returned body instead of the result set size.
    """
    return [record for record in records if marker in record["content"]]


def test_a_shorter_rewrite_keeps_only_the_new_chunks(
    milvus_env: MilvusContractEnv,
) -> None:
    """A rewrite replaces the document, its old tail included."""
    knowledge_id = milvus_env.new_knowledge_id()
    long_text = _document_text(key="alpha", tail_marker="legacytailmarker")
    backend, model, long_result = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=901,
        text=long_text,
        splitter_config=FLAT_SPLITTER,
    )
    assert long_result["chunk_count"] >= 2, "the long version must be multi-chunk"

    _, _, sibling_result = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=902,
        text="siblingonlymarker untouched document",
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
    )

    # No pre-delete here: the write itself replaces the previous version.
    _, _, short_result = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=901,
        text="freshstartmarker short replacement document",
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
    )

    document = backend.get_document(knowledge_id, "901", user_id=CONTRACT_USER_ID)
    assert document["chunk_count"] == short_result["chunk_count"]
    assert "legacytailmarker" not in json.dumps(document["chunks"])
    assert all("freshstartmarker" in chunk["content"] for chunk in document["chunks"])

    stale = _query(
        knowledge_id=knowledge_id,
        query="legacytailmarker",
        backend=backend,
        model=model,
    )["records"]
    assert _mentioning(stale, "legacytailmarker") == []

    sibling = backend.get_document(knowledge_id, "902", user_id=CONTRACT_USER_ID)
    assert sibling["chunk_count"] == sibling_result["chunk_count"]
    sibling_hits = _mentioning(
        _query(
            knowledge_id=knowledge_id,
            query="siblingonlymarker",
            backend=backend,
            model=model,
        )["records"],
        "siblingonlymarker",
    )
    assert _doc_refs(sibling_hits) == {"902"}


def test_repeated_rebuild_keeps_one_copy_of_every_chunk(
    milvus_env: MilvusContractEnv,
) -> None:
    """Rebuilding the same document twice never doubles its chunks."""
    knowledge_id = milvus_env.new_knowledge_id()
    text = _document_text(key="beta", tail_marker="repeatmarker")
    backend, model, first = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=903,
        text=text,
        splitter_config=FLAT_SPLITTER,
    )
    _, _, second = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=903,
        text=text,
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
    )

    assert second["chunk_count"] == first["chunk_count"]
    document = backend.get_document(knowledge_id, "903", user_id=CONTRACT_USER_ID)
    assert [chunk["chunk_index"] for chunk in document["chunks"]] == list(
        range(first["chunk_count"])
    )

    hits = _query(
        knowledge_id=knowledge_id,
        query="repeatmarker",
        backend=backend,
        model=model,
        top_k=first["chunk_count"] + 5,
    )
    assert len(hits["records"]) == first["chunk_count"]


def test_child_hit_expands_to_the_parent_body_of_the_same_document(
    milvus_env: MilvusContractEnv,
) -> None:
    """A child hit answers with its own parent body and never a sibling's."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=910,
        text=_hierarchical_text(marker="parentonlymarker", key="gamma"),
        splitter_config=HIERARCHICAL_SPLITTER,
    )
    _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=911,
        text=_hierarchical_text(marker="siblingonlymarker", key="gamma"),
        splitter_config=HIERARCHICAL_SPLITTER,
        backend=backend,
        model=model,
    )

    records = _query(
        knowledge_id=knowledge_id,
        query="parentonlymarker",
        backend=backend,
        model=model,
    )["records"]

    marker_records = _mentioning(records, "parentonlymarker")
    assert marker_records, "the marker must be readable in the expanded body"
    assert _doc_refs(marker_records) == {"910"}
    marker_record = marker_records[0]
    parent_node_id = marker_record["metadata"]["parent_node_id"]
    parents = backend.get_parent_nodes(
        knowledge_id, [parent_node_id], user_id=CONTRACT_USER_ID
    )
    assert marker_record["content"] == parents[parent_node_id]["content"]
    # The parent body spans several child chunks, so it carries a paragraph
    # that no single child chunk of the marker holds.
    assert "gamma paragraph 1" in marker_record["content"]

    sibling_hits = _mentioning(
        _query(
            knowledge_id=knowledge_id,
            query="siblingonlymarker",
            backend=backend,
            model=model,
        )["records"],
        "siblingonlymarker",
    )
    assert _doc_refs(sibling_hits) == {"911"}


def test_rewrite_to_flat_hides_the_previous_parent_body(
    milvus_env: MilvusContractEnv,
) -> None:
    """A document that stops being hierarchical leaves no readable parent body."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=912,
        text=_hierarchical_text(marker="parentonlymarker", key="delta"),
        splitter_config=HIERARCHICAL_SPLITTER,
    )

    _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=912,
        text="freshstartmarker short replacement document",
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
    )

    document = backend.get_document(knowledge_id, "912", user_id=CONTRACT_USER_ID)
    assert "parentonlymarker" not in json.dumps(document["chunks"])
    assert all(
        chunk["metadata"].get("parent_node_id") is None for chunk in document["chunks"]
    )

    stale = _query(
        knowledge_id=knowledge_id,
        query="parentonlymarker",
        backend=backend,
        model=model,
    )["records"]
    assert _mentioning(stale, "parentonlymarker") == []


def test_hierarchical_rebuild_keeps_only_the_new_parent_body(
    milvus_env: MilvusContractEnv,
) -> None:
    """A rebuild replaces the parent body it is about to be read through."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=913,
        text=_hierarchical_text(marker="oldparentmarker", key="eta"),
        splitter_config=HIERARCHICAL_SPLITTER,
    )

    _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=913,
        text=_hierarchical_text(marker="newparentmarker", key="theta"),
        splitter_config=HIERARCHICAL_SPLITTER,
        backend=backend,
        model=model,
    )

    document = backend.get_document(knowledge_id, "913", user_id=CONTRACT_USER_ID)
    assert "oldparentmarker" not in json.dumps(document["chunks"])
    parent_node_ids = sorted(
        {
            chunk["metadata"]["parent_node_id"]
            for chunk in document["chunks"]
            if chunk["metadata"].get("parent_node_id")
        }
    )
    assert parent_node_ids, "the rebuilt document is still hierarchical"

    records = _mentioning(
        _query(
            knowledge_id=knowledge_id,
            query="newparentmarker",
            backend=backend,
            model=model,
        )["records"],
        "newparentmarker",
    )
    assert records, "the newly saved parent body must stay readable"
    assert _doc_refs(records) == {"913"}
    assert records[0]["metadata"]["parent_node_id"] in parent_node_ids
    assert "theta paragraph 1" in records[0]["content"]

    stale = _query(
        knowledge_id=knowledge_id,
        query="oldparentmarker",
        backend=backend,
        model=model,
    )["records"]
    assert _mentioning(stale, "oldparentmarker") == []


def test_child_hit_without_its_parent_answers_with_the_child_body(
    milvus_env: MilvusContractEnv,
) -> None:
    """A missing parent falls back to the child body instead of a guess."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=914,
        text=_hierarchical_text(marker="orphanmarker", key="iota", paragraphs=10),
        splitter_config=HIERARCHICAL_SPLITTER,
    )
    document = backend.get_document(knowledge_id, "914", user_id=CONTRACT_USER_ID)
    stored_chunks = document["chunks"]
    child_texts = {chunk["content"] for chunk in stored_chunks}
    parent_node_ids = sorted(
        {chunk["metadata"]["parent_node_id"] for chunk in stored_chunks}
    )
    assert parent_node_ids and all(parent_node_ids)
    marker_children = [
        chunk for chunk in stored_chunks if "orphanmarker" in chunk["content"]
    ]
    assert marker_children, "the child that carries the marker is stored"
    marker_parent_id = marker_children[0]["metadata"]["parent_node_id"]
    parent_bodies = backend.get_parent_nodes(
        knowledge_id, [marker_parent_id], user_id=CONTRACT_USER_ID
    )
    assert marker_parent_id in parent_bodies, "the marker parent is stored"
    # A child that already carried its whole parent body could not tell the two
    # apart, so the sample only proves the fallback while that body stays longer
    # than the child hit.
    assert len(parent_bodies[marker_parent_id]["content"]) > len(
        marker_children[0]["content"]
    )

    # The sidecar of that document is gone while its chunks stay stored.
    deleted_parent_nodes = backend.delete_parent_nodes(
        knowledge_id, "914", user_id=CONTRACT_USER_ID
    )
    assert deleted_parent_nodes == len(parent_node_ids)
    await_parent_removal(
        backend,
        knowledge_id=knowledge_id,
        parent_node_ids=parent_node_ids,
        user_id=CONTRACT_USER_ID,
    )

    records = _mentioning(
        _query(
            knowledge_id=knowledge_id,
            query="orphanmarker",
            backend=backend,
            model=model,
        )["records"],
        "orphanmarker",
    )
    assert records, "the child stays readable when its parent is missing"
    assert _doc_refs(records) == {"914"}
    # The answer is one stored child body, and it is not the parent body this
    # child used to be expanded to, so the missing parent was not invented back.
    assert records[0]["content"] in child_texts
    returned_parent_id = records[0]["metadata"]["parent_node_id"]
    assert returned_parent_id in parent_bodies
    assert records[0]["content"] != parent_bodies[returned_parent_id]["content"]


def test_delete_removes_one_document_with_its_parents(
    milvus_env: MilvusContractEnv,
) -> None:
    """The delete entry clears the target document and leaves siblings alone."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=920,
        text=_hierarchical_text(marker="deletememarker", key="epsilon"),
        splitter_config=HIERARCHICAL_SPLITTER,
    )
    _, _, sibling_result = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=921,
        text="siblingonlymarker untouched document",
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
    )
    parent_node_ids = sorted(
        {
            chunk["metadata"]["parent_node_id"]
            for chunk in backend.get_document(
                knowledge_id, "920", user_id=CONTRACT_USER_ID
            )["chunks"]
        }
    )
    assert parent_node_ids and all(parent_node_ids)

    service = DocumentService(storage_backend=backend)
    deleted = asyncio.run(
        service.delete_document(
            knowledge_id=knowledge_id, doc_ref="920", user_id=CONTRACT_USER_ID
        )
    )
    assert deleted["deleted_chunks"] >= 1

    with pytest.raises(ValueError):
        backend.get_document(knowledge_id, "920", user_id=CONTRACT_USER_ID)
    assert (
        backend.get_parent_nodes(
            knowledge_id, parent_node_ids, user_id=CONTRACT_USER_ID
        )
        == {}
    )
    assert (
        _mentioning(
            _query(
                knowledge_id=knowledge_id,
                query="deletememarker",
                backend=backend,
                model=model,
            )["records"],
            "deletememarker",
        )
        == []
    )

    sibling = backend.get_document(knowledge_id, "921", user_id=CONTRACT_USER_ID)
    assert sibling["chunk_count"] == sibling_result["chunk_count"]
    assert _doc_refs(
        _mentioning(
            _query(
                knowledge_id=knowledge_id,
                query="siblingonlymarker",
                backend=backend,
                model=model,
            )["records"],
            "siblingonlymarker",
        )
    ) == {"921"}

    repeated = asyncio.run(
        service.delete_document(
            knowledge_id=knowledge_id, doc_ref="920", user_id=CONTRACT_USER_ID
        )
    )
    assert repeated["deleted_chunks"] == 0


@pytest.fixture
def shared_collection_backend(milvus_uri: str):
    """A backend whose strategy shares one physical collection across KBs."""
    prefix = f"contract_shared_{uuid.uuid4().hex[:8]}"
    backend = MilvusBackend(
        {
            "url": milvus_uri,
            "indexStrategy": {"mode": "per_user", "prefix": prefix},
            "ext": {"timeout": 30.0},
        }
    )
    collection_name = backend.get_index_name("1", user_id=SHARED_USER_ID)
    try:
        yield backend
    finally:
        drop_collection_with_contract(milvus_uri, collection_name)


def test_shared_collection_rewrite_and_clear_stay_inside_one_knowledge_base(
    milvus_env: MilvusContractEnv,
    shared_collection_backend: MilvusBackend,
) -> None:
    """Cleaning one knowledge base never reaches another in the same collection."""
    backend = shared_collection_backend
    model = DeterministicEmbedding(CONTRACT_DIMENSION)
    knowledge_a = milvus_env.new_knowledge_id()
    knowledge_b = milvus_env.new_knowledge_id()
    assert backend.get_index_name(knowledge_a, user_id=SHARED_USER_ID) == (
        backend.get_index_name(knowledge_b, user_id=SHARED_USER_ID)
    )
    assert backend.get_parent_store_name(knowledge_a, user_id=SHARED_USER_ID) == (
        backend.get_parent_store_name(knowledge_b, user_id=SHARED_USER_ID)
    )

    _, _, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_a,
        document_id=930,
        text=_hierarchical_text(marker="sharedamarker", key="alpha"),
        splitter_config=HIERARCHICAL_SPLITTER,
        backend=backend,
        model=model,
        user_id=SHARED_USER_ID,
    )
    _, _, neighbour_result = _index_document(
        milvus_env,
        knowledge_id=knowledge_b,
        document_id=931,
        # Similar parents in a sibling knowledge base share one sidecar.
        text=_hierarchical_text(marker="sharedbmarker", key="alpha"),
        splitter_config=HIERARCHICAL_SPLITTER,
        backend=backend,
        model=model,
        user_id=SHARED_USER_ID,
    )
    for knowledge_id, marker, doc_ref in (
        (knowledge_a, "sharedamarker", "930"),
        (knowledge_b, "sharedbmarker", "931"),
    ):
        expanded = _mentioning(
            _query(
                knowledge_id=knowledge_id,
                query=marker,
                backend=backend,
                model=model,
                user_id=SHARED_USER_ID,
            )["records"],
            marker,
        )
        assert expanded, f"{marker} must expand inside its own knowledge base"
        assert _doc_refs(expanded) == {doc_ref}

    _index_document(
        milvus_env,
        knowledge_id=knowledge_a,
        document_id=930,
        text="freshstartmarker short replacement document",
        splitter_config=FLAT_SPLITTER,
        backend=backend,
        model=model,
        user_id=SHARED_USER_ID,
    )
    assert (
        _mentioning(
            _query(
                knowledge_id=knowledge_a,
                query="sharedamarker",
                backend=backend,
                model=model,
                user_id=SHARED_USER_ID,
            )["records"],
            "sharedamarker",
        )
        == []
    )
    neighbour = backend.get_document(knowledge_b, "931", user_id=SHARED_USER_ID)
    assert neighbour["chunk_count"] == neighbour_result["chunk_count"]
    assert "sharedbmarker" in json.dumps(neighbour["chunks"])

    cleared = backend.delete_knowledge(knowledge_id=knowledge_a, user_id=SHARED_USER_ID)
    assert cleared["deleted_chunks"] >= 1
    assert cleared["deleted_parent_nodes"] >= 1
    with pytest.raises(ValueError):
        backend.get_document(knowledge_a, "930", user_id=SHARED_USER_ID)
    survivor = backend.get_document(knowledge_b, "931", user_id=SHARED_USER_ID)
    assert survivor["chunk_count"] == neighbour_result["chunk_count"]
    assert _mentioning(
        _query(
            knowledge_id=knowledge_b,
            query="sharedbmarker",
            backend=backend,
            model=model,
            user_id=SHARED_USER_ID,
        )["records"],
        "sharedbmarker",
    ), "the neighbour keeps its parent expansion"

    with pytest.raises(ValueError):
        backend.drop_knowledge_index(knowledge_id=knowledge_a, user_id=SHARED_USER_ID)

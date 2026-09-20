# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reading an existing legacy parent sidecar, and the parent write it cannot do.

A legacy knowledge base keeps its child chunks in the index collection and
their parent bodies in a sidecar next to it. These cases cover an existing
sidecar's read side: ``get_parent_nodes`` serves the stored bodies,
``QueryExecutor`` expands a child hit to its parent, and a deleted parent
leaves the child-only answer behind. The fixture reproduces those rows in the
legacy layout, because the frozen adapter cannot create the sidecar on the
pinned server (the package docstring holds the reason and the rows it
reproduces).

The last case pins that limitation as an explicit negative contract instead of
describing the write as compatible: it drives the adapter's own
``save_parent_nodes`` against the real server and asserts the refusal. Nothing
in this module is skipped, expected to fail or mocked.
"""

from __future__ import annotations

from typing import Any

import pytest
from pymilvus.exceptions import MilvusException

from knowledge_engine.splitter.hierarchical import HierarchicalNodes
from knowledge_engine.storage.milvus_backend import MilvusBackend as LegacyMilvusBackend

from ..milvus.conftest import await_parent_removal
from .conftest import (
    CONTRACT_USER_ID,
    DeterministicEmbedding,
    LegacyContractEnv,
    doc_refs,
    hierarchical_nodes,
    mentioning,
    retrieve,
    write_chunk_nodes,
)

pytestmark = pytest.mark.milvus

PARENT_MARKER = "legacyparentmarker"
DOC_REF = "760"


def _hierarchical_document_text() -> str:
    """A hierarchical document whose first paragraph carries the marker."""
    return "\n\n".join(
        [f"{PARENT_MARKER} opening paragraph " + "filler sentence " * 8]
        + [
            f"theta paragraph {index} " + "topic filler sentence " * 8
            for index in range(5)
        ]
    )


def _store_existing_sidecar_document(
    env: LegacyContractEnv,
    *,
    knowledge_id: str,
    model: DeterministicEmbedding,
) -> tuple[LegacyMilvusBackend, HierarchicalNodes]:
    """Store a document that already has its parent bodies in a sidecar.

    The child rows go through the same storage seam ``DocumentIndexer`` writes
    them with; the parent bodies are reproduced in the legacy sidecar layout,
    which is the state a legacy knowledge base reaches on a server that accepts
    its placeholder dimension.
    """
    nodes = hierarchical_nodes(_hierarchical_document_text())
    backend = env.legacy_backend()
    write_chunk_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=DOC_REF,
        nodes=nodes.child_nodes,
        model=model,
    )
    env.write_parent_sidecar(
        knowledge_id,
        doc_ref=DOC_REF,
        parent_nodes=nodes.parent_nodes,
    )
    # The reproduced rows carry the legacy layout only while the adapter's own
    # read path binds them: every parent body must come back.
    stored = backend.get_parent_nodes(
        knowledge_id,
        [node.node_id for node in nodes.parent_nodes],
        parent_refs=[(DOC_REF, node.node_id) for node in nodes.parent_nodes],
        user_id=CONTRACT_USER_ID,
    )
    assert len(stored) == len(nodes.parent_nodes)
    assert all(row["content"] for row in stored.values())
    return backend, nodes


def _stored_parent_refs(
    document: dict[str, Any],
) -> tuple[list[str], list[tuple[str, str]]]:
    """The parent ids and the document-scoped references a document names."""
    parent_node_ids = sorted(
        {
            chunk["metadata"]["parent_node_id"]
            for chunk in document["chunks"]
            if chunk["metadata"].get("parent_node_id")
        }
    )
    return parent_node_ids, [(DOC_REF, node_id) for node_id in parent_node_ids]


def test_an_existing_sidecar_expands_a_child_hit_to_its_parent_body(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The read chain serves both halves of a stored hierarchical document."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    model = DeterministicEmbedding()
    backend, nodes = _store_existing_sidecar_document(
        legacy_milvus_env,
        knowledge_id=knowledge_id,
        model=model,
    )

    document = backend.get_document(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    assert document["chunk_count"] == len(nodes.child_nodes)
    child_texts = {chunk["content"] for chunk in document["chunks"]}
    parent_node_ids, parent_refs = _stored_parent_refs(document)
    assert parent_node_ids, "the stored children name their parent"

    parent_bodies = backend.get_parent_nodes(
        knowledge_id,
        parent_node_ids,
        parent_refs=parent_refs,
        user_id=CONTRACT_USER_ID,
    )
    assert set(parent_bodies) == set(parent_node_ids)
    assert all(row["content"] for row in parent_bodies.values())

    expanded = mentioning(
        retrieve(
            backend,
            knowledge_id=knowledge_id,
            query=PARENT_MARKER,
            model=model,
        )["records"],
        PARENT_MARKER,
    )
    assert expanded, "the child carrying the marker must be found"
    assert doc_refs(expanded) == {DOC_REF}
    assert expanded[0]["content"] in {row["content"] for row in parent_bodies.values()}
    assert expanded[0]["content"] not in child_texts


def test_deleting_the_parents_of_an_existing_sidecar_answers_from_the_child_body(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """A missing parent body falls back to the child instead of a guess."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    model = DeterministicEmbedding()
    backend, _ = _store_existing_sidecar_document(
        legacy_milvus_env,
        knowledge_id=knowledge_id,
        model=model,
    )
    document = backend.get_document(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    child_texts = {chunk["content"] for chunk in document["chunks"]}
    parent_node_ids, parent_refs = _stored_parent_refs(document)
    parent_bodies = backend.get_parent_nodes(
        knowledge_id,
        parent_node_ids,
        parent_refs=parent_refs,
        user_id=CONTRACT_USER_ID,
    )

    # The frozen entry reports no count, so the removal is proven where a
    # caller observes it: the expansion stops finding the parent bodies.
    backend.delete_parent_nodes(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    await_parent_removal(
        backend,
        knowledge_id=knowledge_id,
        parent_node_ids=parent_node_ids,
        user_id=CONTRACT_USER_ID,
    )

    answered = mentioning(
        retrieve(
            backend,
            knowledge_id=knowledge_id,
            query=PARENT_MARKER,
            model=model,
        )["records"],
        PARENT_MARKER,
    )
    assert answered, "the child stays readable without its parent"
    assert answered[0]["content"] in child_texts
    assert answered[0]["content"] not in {
        row["content"] for row in parent_bodies.values()
    }


def test_creating_a_parent_sidecar_on_the_pinned_server_is_refused(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The frozen parent write is refused by the pinned server.

    Removing this limitation means changing the frozen production file, which
    the transition does not do, so the smoke reports the write as unsupported:
    the server refuses the 1-dimensional placeholder the adapter builds the
    sidecar with, and a refused create leaves no collection behind.
    """
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    parent_nodes = hierarchical_nodes(_hierarchical_document_text()).parent_nodes
    assert parent_nodes, "the probe needs at least one parent body to store"

    with pytest.raises(MilvusException, match="invalid dimension"):
        backend.save_parent_nodes(
            knowledge_id,
            parent_nodes,
            doc_ref=DOC_REF,
        )

    sidecar = legacy_milvus_env.parent_sidecar_name(knowledge_id)
    client = legacy_milvus_env.inspector(legacy_milvus_env.legacy_database)
    try:
        assert not client.has_collection(sidecar), "a refused create leaves none"
    finally:
        client.close()

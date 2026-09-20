# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Document bodies and parent expansion of the legacy adapter on a real sidecar.

A legacy knowledge base stores its child chunks in the index collection and
their parent bodies in a sidecar next to it. The child rows here are written
through the same storage seam ``DocumentIndexer`` writes them with, and the
sidecar rows are the legacy implementation's own layout - see the package
docstring for why the pinned server cannot let the adapter create that sidecar
itself. What these cases verify is the restored read chain: the document read
serves the child bodies, the parent read serves the parent bodies, and the
query executor expands a child hit to its parent.
"""

from __future__ import annotations

import pytest

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


def _store_hierarchical_document(
    env: LegacyContractEnv,
    *,
    knowledge_id: str,
    model: DeterministicEmbedding,
):
    """Store one hierarchical document: child rows plus its parent bodies."""
    nodes = hierarchical_nodes(
        "\n\n".join(
            [f"{PARENT_MARKER} opening paragraph " + "filler sentence " * 8]
            + [
                f"theta paragraph {index} " + "topic filler sentence " * 8
                for index in range(5)
            ]
        )
    )
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


def _stored_parent_refs(document: dict) -> tuple[list[str], list[tuple[str, str]]]:
    """The parent ids and the document-scoped references a document names."""
    parent_node_ids = sorted(
        {
            chunk["metadata"]["parent_node_id"]
            for chunk in document["chunks"]
            if chunk["metadata"].get("parent_node_id")
        }
    )
    return parent_node_ids, [(DOC_REF, node_id) for node_id in parent_node_ids]


def test_a_child_hit_expands_to_the_parent_body_of_the_sidecar(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The restored read chain serves both halves of a hierarchical document."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    model = DeterministicEmbedding()
    backend, nodes = _store_hierarchical_document(
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


def test_deleting_the_parents_answers_from_the_child_body(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """A missing parent body falls back to the child instead of a guess."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    model = DeterministicEmbedding()
    backend, _ = _store_hierarchical_document(
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

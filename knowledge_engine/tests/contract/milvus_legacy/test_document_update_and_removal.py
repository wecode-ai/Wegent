# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Update, delete, purge and drop of the legacy adapter on a real collection.

The legacy adapter does not replace a document inside its own write, so the
indexing caller deletes the previous version first. These cases keep that
order and prove the rewritten document converges; they also prove the three
removal entries keep their own scope: one document, the rows of one knowledge
base, and the dedicated collections of one knowledge base.
"""

from __future__ import annotations

import json

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.storage.factory import storage_backend_owns_document_replacement

from .conftest import (
    CONTRACT_USER_ID,
    DeterministicEmbedding,
    LegacyContractEnv,
    delete_document,
    doc_refs,
    document_text,
    mentioning,
    retrieve,
    wait_for_document_removal,
    write_document,
)

pytestmark = pytest.mark.milvus

STALE_MARKER = "legacystalemarker"
FRESH_MARKER = "legacyfreshmarker"
SIBLING_MARKER = "legacysiblingmarker"


def test_delete_then_write_converges_on_real_milvus(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The delete-then-write order leaves exactly one version of a document.

    What this case proves is that order's storage result on the real service:
    the previous version's chunks are gone and the new one is readable and
    searchable. Which storage configs the indexing caller deletes before a write
    is that caller's decision: the backend indexing tests cover the branch that
    builds the pre-delete, around the capability read below. This smoke reads
    the same capability and then performs the two storage calls it implies.
    """
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()

    # The capability the indexing caller reads before it decides the order.
    assert (
        storage_backend_owns_document_replacement(
            legacy_milvus_env.legacy_storage_config()
        )
        is False
    )

    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=720,
        text=document_text(marker=STALE_MARKER, key="alpha"),
        model=model,
    )
    stale_document = backend.get_document(knowledge_id, "720", user_id=CONTRACT_USER_ID)
    assert stale_document["chunk_count"] > 1, "the first version must split"
    assert STALE_MARKER in json.dumps(stale_document["chunks"])

    # The order that capability implies for this type: delete the previous
    # rows, then write the new ones. The backend indexing service is the caller
    # that builds the pre-delete spec and the runtime performs it; the two
    # calls below are the storage side of that order.
    delete_document(backend, knowledge_id=knowledge_id, doc_ref="720")
    rewritten = write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=720,
        text=f"{FRESH_MARKER} short replacement document",
        model=model,
    )

    stored = backend.get_document(knowledge_id, "720", user_id=CONTRACT_USER_ID)
    assert stored["chunk_count"] == rewritten["chunk_count"]
    assert FRESH_MARKER in json.dumps(stored["chunks"])
    assert STALE_MARKER not in json.dumps(stored["chunks"])
    assert (
        mentioning(
            retrieve(
                backend,
                knowledge_id=knowledge_id,
                query=STALE_MARKER,
                model=model,
                mode="keyword",
            )["records"],
            STALE_MARKER,
        )
        == []
    )
    assert doc_refs(
        mentioning(
            retrieve(
                backend,
                knowledge_id=knowledge_id,
                query=FRESH_MARKER,
                model=model,
                mode="keyword",
            )["records"],
            FRESH_MARKER,
        )
    ) == {"720"}


def test_deleting_one_document_leaves_its_sibling_readable(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """A document delete keeps its own scope inside one knowledge base."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=730,
        text=document_text(marker=STALE_MARKER, key="alpha"),
        model=model,
    )
    sibling = write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=731,
        text=document_text(marker=SIBLING_MARKER, key="beta"),
        model=model,
    )

    deleted = delete_document(backend, knowledge_id=knowledge_id, doc_ref="730")

    assert deleted["status"] == "deleted"
    wait_for_document_removal(backend, knowledge_id=knowledge_id, doc_ref="730")
    survivor = backend.get_document(knowledge_id, "731", user_id=CONTRACT_USER_ID)
    assert survivor["chunk_count"] == sibling["chunk_count"]
    assert doc_refs(
        mentioning(
            retrieve(
                backend,
                knowledge_id=knowledge_id,
                query=SIBLING_MARKER,
                model=model,
            )["records"],
            SIBLING_MARKER,
        )
    ) == {"731"}


def test_purging_a_knowledge_base_clears_its_rows_but_keeps_the_collection(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The purge empties one knowledge base and leaves its collection stored."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=740,
        text=document_text(marker=STALE_MARKER, key="alpha"),
        model=model,
    )
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=741,
        text=document_text(marker=SIBLING_MARKER, key="beta"),
        model=model,
    )

    purged = backend.delete_knowledge(
        knowledge_id=knowledge_id, user_id=CONTRACT_USER_ID
    )

    assert purged["status"] == "deleted"
    for doc_ref in ("740", "741"):
        wait_for_document_removal(backend, knowledge_id=knowledge_id, doc_ref=doc_ref)
    for marker in (STALE_MARKER, SIBLING_MARKER):
        assert (
            mentioning(
                retrieve(
                    backend,
                    knowledge_id=knowledge_id,
                    query=marker,
                    model=model,
                )["records"],
                marker,
            )
            == []
        )
    client = legacy_milvus_env.inspector(legacy_milvus_env.legacy_database)
    try:
        assert client.has_collection(backend.get_index_name(knowledge_id))
    finally:
        client.close()


def test_dropping_a_knowledge_base_removes_only_its_own_collections(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The dedicated-index drop clears both collections of one knowledge base."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    neighbour_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=750,
        text=document_text(marker=STALE_MARKER, key="alpha"),
        model=model,
    )
    write_document(
        backend,
        knowledge_id=neighbour_id,
        document_id=751,
        text=document_text(marker=SIBLING_MARKER, key="beta"),
        model=model,
    )
    legacy_milvus_env.write_parent_sidecar(
        knowledge_id,
        doc_ref="750",
        parent_nodes=[
            TextNode(
                id_="drop-parent",
                text="parent body of the dropped knowledge base",
                metadata={"doc_ref": "750", "source_file": "document-750.txt"},
            )
        ],
    )
    client = legacy_milvus_env.inspector(legacy_milvus_env.legacy_database)
    try:
        assert client.has_collection(backend.get_index_name(knowledge_id))
        assert client.has_collection(backend.get_parent_store_name(knowledge_id))

        dropped = backend.drop_knowledge_index(
            knowledge_id=knowledge_id, user_id=CONTRACT_USER_ID
        )

        assert dropped["status"] == "dropped"
        assert dropped["collection_name"] == backend.get_index_name(knowledge_id)
        assert not client.has_collection(backend.get_index_name(knowledge_id))
        assert not client.has_collection(backend.get_parent_store_name(knowledge_id))
        assert client.has_collection(backend.get_index_name(neighbour_id))
    finally:
        client.close()

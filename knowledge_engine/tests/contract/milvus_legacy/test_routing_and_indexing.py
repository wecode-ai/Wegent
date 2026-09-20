# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Routing, the stored physical shape and the document read of the legacy adapter.

``type: milvus`` is the persistent identity of the frozen adapter, and these
cases pin that the factory resolves it there, that a document written through
the product's write seam lands in the collection the legacy implementation
shaped, and that the very same adapter reads that document back.
"""

from __future__ import annotations

import json

import pytest

from knowledge_engine.storage.milvus.backend import MilvusBackend as MilvusV2Backend
from knowledge_engine.storage.milvus_backend import MilvusBackend as LegacyMilvusBackend

from .conftest import (
    CONTRACT_USER_ID,
    DeterministicEmbedding,
    LegacyContractEnv,
    collection_fields,
    document_text,
    write_document,
)

pytestmark = pytest.mark.milvus

# The fields the LlamaIndex-backed legacy store declares. A collection created
# through the legacy write carries this layout, which is what makes it the old
# physical format rather than any other generation's.
LEGACY_STORED_FIELDS = {"doc_id", "text", "embedding", "sparse_embedding"}


def test_type_milvus_resolves_to_the_frozen_legacy_adapter(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The factory picks the legacy generation for the legacy type."""
    backend = legacy_milvus_env.legacy_backend()

    assert type(backend) is LegacyMilvusBackend
    assert not isinstance(backend, MilvusV2Backend)
    assert backend.db_name == legacy_milvus_env.shared_database


def test_a_written_document_is_stored_in_a_legacy_shaped_collection(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The legacy collection is the one the frozen implementation wrote."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()

    result = write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=701,
        text=document_text(marker="legacyshape"),
        model=model,
    )

    collection_name = backend.get_index_name(knowledge_id)
    client = legacy_milvus_env.inspector(legacy_milvus_env.shared_database)
    try:
        assert client.has_collection(collection_name)
        fields = collection_fields(client, collection_name)
    finally:
        client.close()
    assert LEGACY_STORED_FIELDS <= fields

    stored = backend.get_document(knowledge_id, "701", user_id=CONTRACT_USER_ID)
    assert stored["chunk_count"] == result["chunk_count"]
    assert stored["source_file"] == "document-701.txt"
    assert "legacyshape" in json.dumps(stored["chunks"])


def test_the_stored_document_is_listed_by_the_legacy_adapter(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The document listing serves the collection the write just created."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    result = write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=702,
        text=document_text(marker="legacylisting"),
        model=model,
    )

    listed = backend.list_documents(
        knowledge_id=knowledge_id,
        page=1,
        page_size=20,
        user_id=CONTRACT_USER_ID,
    )

    assert listed["total"] == 1
    assert listed["documents"][0]["doc_ref"] == "702"
    assert listed["documents"][0]["chunk_count"] == result["chunk_count"]

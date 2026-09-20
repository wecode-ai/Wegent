# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Physical isolation of the two generations, and no fallback between them.

Both generations name collections identically, so the deployment rule that
gives each its own Milvus database is what keeps them apart. These cases hold
the same knowledge id in both databases at once, and then point each adapter
at the other generation's physical format: neither one adopts, rewrites or
reads the other's rows, and neither falls back to the other adapter.
"""

from __future__ import annotations

import json

import pytest
from pymilvus.exceptions import MilvusException

from knowledge_engine.storage.milvus.errors import IndexContractIncompatibleError

from ..milvus.conftest import await_document_visibility
from .conftest import (
    CONTRACT_USER_ID,
    DeterministicEmbedding,
    LegacyContractEnv,
    document_text,
    mentioning,
    retrieve,
    write_document,
)

pytestmark = pytest.mark.milvus

LEGACY_MARKER = "legacyisolationmarker"
V2_MARKER = "v2isolationmarker"
DOC_REF = "770"


def test_both_generations_store_the_same_collection_name_in_their_own_database(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The two types share one naming rule and never one physical space."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    legacy = legacy_milvus_env.legacy_backend()
    v2 = legacy_milvus_env.v2_backend()

    assert legacy.db_name != v2.db_name
    assert legacy.db_name == legacy_milvus_env.legacy_database
    assert v2.db_name == legacy_milvus_env.v2_database
    assert legacy.get_index_name(knowledge_id) == v2.get_index_name(knowledge_id)
    assert legacy.get_parent_store_name(knowledge_id) == v2.get_parent_store_name(
        knowledge_id
    )


def test_the_same_knowledge_id_keeps_both_generations_apart(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """One knowledge id, two databases, two documents, no shared rows."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    legacy = legacy_milvus_env.legacy_backend()
    v2 = legacy_milvus_env.v2_backend()
    model = DeterministicEmbedding()
    write_document(
        legacy,
        knowledge_id=knowledge_id,
        document_id=int(DOC_REF),
        text=document_text(marker=LEGACY_MARKER, key="alpha"),
        model=model,
    )
    written_to_v2 = write_document(
        v2,
        knowledge_id=knowledge_id,
        document_id=int(DOC_REF),
        text=f"{V2_MARKER} v2 document body",
        model=model,
    )

    legacy_client = legacy_milvus_env.inspector(legacy_milvus_env.legacy_database)
    v2_client = legacy_milvus_env.inspector(legacy_milvus_env.v2_database)
    try:
        assert legacy_client.has_collection(legacy.get_index_name(knowledge_id))
        assert v2_client.has_collection(v2.get_index_name(knowledge_id))
    finally:
        legacy_client.close()
        v2_client.close()

    legacy_document = legacy.get_document(
        knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID
    )
    # The V2 write returns before its rows are readable at Bounded, so its
    # document is waited for through the V2 read path the way its own contract
    # tests do; the legacy write needs no such wait.
    v2_document = await_document_visibility(
        v2,
        knowledge_id=knowledge_id,
        doc_ref=DOC_REF,
        expected_chunks=written_to_v2["chunk_count"],
        user_id=CONTRACT_USER_ID,
    )
    assert LEGACY_MARKER in json.dumps(legacy_document["chunks"])
    assert V2_MARKER not in json.dumps(legacy_document["chunks"])
    assert v2_document["chunk_count"] == written_to_v2["chunk_count"]
    assert V2_MARKER in json.dumps(v2_document["chunks"])
    assert LEGACY_MARKER not in json.dumps(v2_document["chunks"])

    # Neither read path doubles as a second read of the other generation.
    assert (
        mentioning(
            retrieve(
                legacy,
                knowledge_id=knowledge_id,
                query=V2_MARKER,
                model=model,
            )["records"],
            V2_MARKER,
        )
        == []
    )
    assert (
        mentioning(
            retrieve(
                legacy,
                knowledge_id=knowledge_id,
                query=LEGACY_MARKER,
                model=model,
            )["records"],
            LEGACY_MARKER,
        )
        != []
    )


def test_v2_refuses_a_legacy_collection_instead_of_adopting_it(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The V2 adapter names the legacy format incompatible and stops there."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    legacy = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    write_document(
        legacy,
        knowledge_id=knowledge_id,
        document_id=int(DOC_REF),
        text=document_text(marker=LEGACY_MARKER, key="alpha"),
        model=model,
    )
    v2_on_legacy = legacy_milvus_env.v2_backend(url=legacy_milvus_env.legacy_url)

    with pytest.raises(IndexContractIncompatibleError):
        v2_on_legacy.get_document(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    with pytest.raises(IndexContractIncompatibleError):
        v2_on_legacy.get_all_chunks(knowledge_id, user_id=CONTRACT_USER_ID)
    with pytest.raises(IndexContractIncompatibleError):
        v2_on_legacy.delete_document(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    with pytest.raises(IndexContractIncompatibleError):
        write_document(
            v2_on_legacy,
            knowledge_id=knowledge_id,
            document_id=771,
            text=f"{V2_MARKER} v2 document body",
            model=model,
        )


def test_legacy_refuses_a_v2_collection_instead_of_reading_it(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """The legacy adapter serves no V2 rows and calls no other adapter."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    v2 = legacy_milvus_env.v2_backend()
    model = DeterministicEmbedding()
    write_document(
        v2,
        knowledge_id=knowledge_id,
        document_id=int(DOC_REF),
        text=f"{V2_MARKER} v2 document body",
        model=model,
    )
    legacy_on_v2 = legacy_milvus_env.legacy_backend(url=legacy_milvus_env.v2_url)

    # The V2 collection carries none of the fields the legacy read path binds,
    # so the server refuses the read instead of answering with foreign rows.
    with pytest.raises(MilvusException):
        legacy_on_v2.get_document(knowledge_id, DOC_REF, user_id=CONTRACT_USER_ID)
    with pytest.raises(MilvusException):
        retrieve(
            legacy_on_v2,
            knowledge_id=knowledge_id,
            query=V2_MARKER,
            model=model,
        )

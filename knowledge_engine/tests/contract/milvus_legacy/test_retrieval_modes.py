# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The three retrieval modes of the legacy adapter on a real collection.

Vector, keyword and hybrid search each answer a question about the collection
the legacy implementation wrote. The cases assert that the document a query
names comes back with its own body; they do not compare scores or ranking with
the V2 adapter, which makes no promise to agree with it.
"""

from __future__ import annotations

import pytest

from .conftest import (
    DeterministicEmbedding,
    LegacyContractEnv,
    doc_refs,
    document_text,
    mentioning,
    retrieve,
    write_document,
)

pytestmark = pytest.mark.milvus

FIRST_DOC_REF = "710"
SECOND_DOC_REF = "711"
FIRST_MARKER = "legacyvectormarker"
SECOND_MARKER = "legacykeywordmarker"


def _store_two_documents(
    env: LegacyContractEnv,
    knowledge_id: str,
    model: DeterministicEmbedding,
) -> None:
    """Store two documents whose bodies are told apart by their markers."""
    backend = env.legacy_backend()
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=int(FIRST_DOC_REF),
        text=document_text(marker=FIRST_MARKER, key="alpha"),
        model=model,
    )
    write_document(
        backend,
        knowledge_id=knowledge_id,
        document_id=int(SECOND_DOC_REF),
        text=document_text(marker=SECOND_MARKER, key="beta"),
        model=model,
    )


@pytest.mark.parametrize(
    ("mode", "marker", "doc_ref"),
    [
        ("vector", FIRST_MARKER, FIRST_DOC_REF),
        ("keyword", SECOND_MARKER, SECOND_DOC_REF),
        ("hybrid", FIRST_MARKER, FIRST_DOC_REF),
    ],
)
def test_each_retrieval_mode_answers_with_its_own_document(
    legacy_milvus_env: LegacyContractEnv,
    mode: str,
    marker: str,
    doc_ref: str,
) -> None:
    """A representative hit of each mode still carries the stored body."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    _store_two_documents(legacy_milvus_env, knowledge_id, model)

    result = retrieve(
        backend,
        knowledge_id=knowledge_id,
        query=marker,
        model=model,
        mode=mode,
    )

    answered = mentioning(result["records"], marker)
    assert answered, f"{mode} search returned no body carrying {marker}"
    assert doc_refs(answered) == {doc_ref}


def test_keyword_and_vector_searches_read_the_same_collection(
    legacy_milvus_env: LegacyContractEnv,
) -> None:
    """Both the dense and the sparse half of one collection are searchable."""
    knowledge_id = legacy_milvus_env.new_knowledge_id()
    backend = legacy_milvus_env.legacy_backend()
    model = DeterministicEmbedding()
    _store_two_documents(legacy_milvus_env, knowledge_id, model)

    sparse = retrieve(
        backend,
        knowledge_id=knowledge_id,
        query=FIRST_MARKER,
        model=model,
        mode="keyword",
    )
    dense = retrieve(
        backend,
        knowledge_id=knowledge_id,
        query=SECOND_MARKER,
        model=model,
        mode="vector",
    )

    assert doc_refs(mentioning(sparse["records"], FIRST_MARKER)) == {FIRST_DOC_REF}
    assert doc_refs(mentioning(dense["records"], SECOND_MARKER)) == {SECOND_DOC_REF}

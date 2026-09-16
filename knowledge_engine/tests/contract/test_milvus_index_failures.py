# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real Milvus index failures stay distinguishable from an empty result.

These run against the pinned standalone service: the contract binding is
written, then the physical index state is changed underneath it, and the
adapter must report a stable code instead of answering with no matches.
"""

from __future__ import annotations

import pytest
from llama_index.core.schema import TextNode
from pymilvus import MilvusClient

from knowledge_engine.storage.errors import (
    IndexMissingError,
    StorageBackendError,
)
from knowledge_engine.storage.milvus_native import INDEX_BINDING_COLLECTION
from tests.contract.conftest import (
    CONTRACT_DIMENSION,
    DeterministicEmbedding,
    index_nodes,
)

pytestmark = pytest.mark.milvus


def _nodes(count: int = 2) -> list[TextNode]:
    return [
        TextNode(
            text=f"failure contract chunk {index}",
            metadata={"chunk_index": index},
        )
        for index in range(count)
    ]


def _drop_physical_collection(uri: str, collection_name: str) -> None:
    client = MilvusClient(uri=uri)
    try:
        if client.has_collection(collection_name):
            client.drop_collection(collection_name)
    finally:
        client.close()


def test_a_deleted_index_reports_every_read_path_as_missing(milvus_env) -> None:
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="1",
        nodes=_nodes(),
    )
    _drop_physical_collection(milvus_env.uri, collection_name)

    read_calls = (
        lambda: backend.get_document(knowledge_id, "1"),
        lambda: backend.list_documents(knowledge_id),
        lambda: backend.get_all_chunks(knowledge_id, max_chunks=5),
        lambda: backend.retrieve(
            knowledge_id=knowledge_id,
            query="failure contract",
            embed_model=DeterministicEmbedding(CONTRACT_DIMENSION),
            retrieval_setting={
                "retrieval_mode": "vector",
                "top_k": 5,
                "score_threshold": 0.0,
            },
        ),
    )
    for call in read_calls:
        with pytest.raises(IndexMissingError) as failure:
            call()
        assert failure.value.code == "index_missing"
        assert failure.value.retryable is False
        assert collection_name in str(failure.value)


def test_a_deleted_index_never_degrades_into_an_empty_result(milvus_env) -> None:
    """A confirmed binding without its collection is a failure, not no matches."""
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="1",
        nodes=_nodes(),
    )
    _drop_physical_collection(milvus_env.uri, collection_name)

    with pytest.raises(StorageBackendError):
        backend.get_all_chunks(knowledge_id, max_chunks=5)


def test_a_collection_without_a_contract_is_not_adopted(milvus_env) -> None:
    """A foreign collection is rejected, never claimed or overwritten."""
    from knowledge_engine.storage.errors import IndexContractIncompatibleError

    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)

    client = MilvusClient(uri=milvus_env.uri)
    try:
        if client.has_collection(collection_name):
            client.drop_collection(collection_name)
        client.create_collection(
            collection_name=collection_name,
            dimension=CONTRACT_DIMENSION,
        )
        if client.has_collection(INDEX_BINDING_COLLECTION):
            client.delete(
                collection_name=INDEX_BINDING_COLLECTION,
                filter=f'collection_name == "{collection_name}"',
            )
    finally:
        client.close()

    with pytest.raises(IndexContractIncompatibleError) as failure:
        backend.get_all_chunks(knowledge_id, max_chunks=5)

    assert failure.value.code == "index_contract_incompatible"
    assert failure.value.retryable is False


def test_a_stable_failure_does_not_expose_the_connection(milvus_env) -> None:
    """The safe message carries the code, not the Milvus target."""
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    index_nodes(backend, knowledge_id=knowledge_id, doc_ref="1", nodes=_nodes())
    _drop_physical_collection(milvus_env.uri, collection_name)

    with pytest.raises(IndexMissingError) as failure:
        backend.get_all_chunks(knowledge_id, max_chunks=5)

    assert milvus_env.uri not in str(failure.value)
    assert milvus_env.uri not in repr(failure.value.details)

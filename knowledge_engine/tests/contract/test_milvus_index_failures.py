# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real Milvus index failures stay distinguishable from an empty result.

These run against the pinned standalone service: the physical index state is
changed underneath the knowledge base and the adapter must report a stable code
instead of answering with no matches.

The index contract lives in the description of the collection it describes
(ticket 12), so the failures worth reporting here are the ones that are still
observable: a collection whose contract this code cannot read, and a contract
that does not match the collection it is stored with. A collection dropped
outside the product leaves nothing behind, which is the observation limitation
the parity spec retains - no second record of the index exists to detect it,
and this file asserts that reading such a knowledge base answers as unindexed
instead of inventing a failure.
"""

from __future__ import annotations

import pytest
from llama_index.core.schema import TextNode
from pymilvus import DataType, Function, FunctionType, MilvusClient

from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
)
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    BM25_FUNCTION_NAME,
    DENSE_VECTOR_FIELD,
    INDEX_TYPE,
    METRIC_TYPE,
    SCHEMA_VERSION,
    SPARSE_INDEX_TYPE,
    SPARSE_METRIC_TYPE,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    index_contract_description,
    index_contract_from_description,
)
from tests.contract.conftest import (
    CONTRACT_DIMENSION,
    LEGACY_INDEX_REGISTRY_COLLECTION,
    DeterministicEmbedding,
    index_nodes,
)

pytestmark = pytest.mark.milvus

INDEX_REGISTRY_COLLECTION = LEGACY_INDEX_REGISTRY_COLLECTION


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


def _create_foreign_collection(uri: str, collection_name: str) -> None:
    """Create a collection of the same dimension that declares no contract."""
    client = MilvusClient(uri=uri)
    try:
        if client.has_collection(collection_name):
            client.drop_collection(collection_name)
        client.create_collection(
            collection_name=collection_name,
            dimension=CONTRACT_DIMENSION,
        )
    finally:
        client.close()


def _create_collection_written_by_the_previous_schema(
    uri: str, collection_name: str
) -> None:
    """Create a collection with the row layout and contract this code replaced.

    The layout is the one schema version ``SCHEMA_VERSION - 1`` wrote: the
    chunk fields as their own columns next to the metadata JSON column. This is
    what an operator meets after an upgrade that did not rebuild every index,
    and the contract the collection declares is what refuses it.
    """
    binding = MilvusIndexBinding(
        collection_name=collection_name,
        connection=uri,
        database="default",
        schema_version=SCHEMA_VERSION - 1,
        embedding_space="sha256:older-schema",
        dimension=CONTRACT_DIMENSION,
        metric_type=METRIC_TYPE,
        index_type=INDEX_TYPE,
        analyzer=ANALYZER_TYPE,
    )
    client = MilvusClient(uri=uri)
    try:
        if client.has_collection(collection_name):
            client.drop_collection(collection_name)
        schema = client.create_schema(
            auto_id=False,
            enable_dynamic_field=False,
            description=index_contract_description(binding),
        )
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=128)
        schema.add_field("knowledge_id", DataType.VARCHAR, max_length=512)
        schema.add_field("doc_ref", DataType.VARCHAR, max_length=512)
        schema.add_field("source_file", DataType.VARCHAR, max_length=65535)
        schema.add_field("chunk_index", DataType.INT64)
        schema.add_field(
            "retrieval_text",
            DataType.VARCHAR,
            max_length=65535,
            enable_analyzer=True,
            analyzer_params={"type": ANALYZER_TYPE},
        )
        schema.add_field("display_text", DataType.VARCHAR, max_length=65535)
        schema.add_field("metadata", DataType.JSON, nullable=True)
        schema.add_field("created_at", DataType.VARCHAR, max_length=65535)
        schema.add_field("dense_vector", DataType.FLOAT_VECTOR, dim=CONTRACT_DIMENSION)
        schema.add_field("sparse_vector", DataType.SPARSE_FLOAT_VECTOR)
        schema.add_function(
            Function(
                name=BM25_FUNCTION_NAME,
                function_type=FunctionType.BM25,
                input_field_names=["retrieval_text"],
                output_field_names=["sparse_vector"],
                params={},
            )
        )
        index_params = client.prepare_index_params()
        index_params.add_index(
            field_name=DENSE_VECTOR_FIELD,
            index_type=INDEX_TYPE,
            metric_type=METRIC_TYPE,
        )
        index_params.add_index(
            field_name=SPARSE_VECTOR_FIELD,
            index_type=SPARSE_INDEX_TYPE,
            metric_type=SPARSE_METRIC_TYPE,
        )
        client.create_collection(
            collection_name=collection_name,
            schema=schema,
            index_params=index_params,
            consistency_level="Strong",
        )
    finally:
        client.close()


def _read_paths(backend, knowledge_id: str):
    return {
        "retrieve": lambda: backend.retrieve(
            knowledge_id=knowledge_id,
            query="failure contract",
            embed_model=DeterministicEmbedding(CONTRACT_DIMENSION),
            retrieval_setting={
                "retrieval_mode": "vector",
                "top_k": 5,
                "score_threshold": 0.0,
            },
        ),
        "get_document": lambda: backend.get_document(knowledge_id, "1"),
        "list_documents": lambda: backend.list_documents(knowledge_id),
        "get_all_chunks": lambda: backend.get_all_chunks(knowledge_id, max_chunks=5),
    }


def test_a_dropped_index_reads_as_a_never_indexed_knowledge_base(milvus_env) -> None:
    """A collection dropped outside the product leaves no contract behind.

    The contract travels with the collection, so an external drop takes it with
    it and the knowledge base reads exactly like one that was never indexed.
    That is the observation limitation the parity spec retains; nothing in the
    product records a second copy of the index that could tell them apart.
    """
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

    assert backend.retrieve(
        knowledge_id=knowledge_id,
        query="failure contract",
        embed_model=DeterministicEmbedding(CONTRACT_DIMENSION),
        retrieval_setting={
            "retrieval_mode": "vector",
            "top_k": 5,
            "score_threshold": 0.0,
        },
    ) == {"records": []}
    assert backend.get_all_chunks(knowledge_id, max_chunks=5) == []
    assert backend.list_documents(knowledge_id)["documents"] == []
    with pytest.raises(ValueError):
        backend.get_document(knowledge_id, "1")
    # Deleting stays idempotent, and reading created no resource again.
    assert backend.delete_document(knowledge_id, "1")["deleted_chunks"] == 0
    assert milvus_env.has_collection(knowledge_id) is False


def test_a_replaced_index_fails_every_read_path_loudly(milvus_env) -> None:
    """A foreign collection that took the index's name is never adopted.

    This is the half of "the index was deleted outside the product" that stays
    observable: whatever answers under the collection name afterwards declares
    no contract of ours, so every reading path reports a stable code instead of
    answering with no matches.
    """
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="1",
        nodes=_nodes(),
    )
    _create_foreign_collection(milvus_env.uri, collection_name)

    for name, call in _read_paths(backend, knowledge_id).items():
        with pytest.raises(IndexContractIncompatibleError) as failure:
            call()
        assert failure.value.code == "index_contract_incompatible", name
        assert failure.value.retryable is False, name
        assert collection_name in str(failure.value), name


def test_a_collection_without_a_contract_is_not_adopted(milvus_env) -> None:
    """A foreign collection is rejected on the write path, never claimed."""
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    _create_foreign_collection(milvus_env.uri, collection_name)

    with pytest.raises(IndexContractIncompatibleError) as failure:
        backend.get_all_chunks(knowledge_id, max_chunks=5)

    assert failure.value.code == "index_contract_incompatible"
    assert failure.value.retryable is False

    # The foreign collection is still there and still exactly as it was.
    client = MilvusClient(uri=milvus_env.uri)
    try:
        assert client.has_collection(collection_name)
    finally:
        client.close()


def test_a_collection_written_by_an_older_schema_is_refused(milvus_env) -> None:
    """A row layout this code no longer writes is refused, not read.

    The physical schema converged to the fields retrieval needs, so a
    collection that still carries the chunk columns and declares the schema
    version before this one is a collection this code cannot read rows out of
    and must not write rows into. Every reading path and the write path report
    that version mismatch, and the collection is left exactly as it was:
    nothing is upgraded, rebuilt or adopted, because the operator rebuilds it.
    """
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    _create_collection_written_by_the_previous_schema(milvus_env.uri, collection_name)

    client = MilvusClient(uri=milvus_env.uri)
    try:
        described = client.describe_collection(collection_name)
    finally:
        client.close()
    field_names = {field["name"] for field in described["fields"]}
    assert {"knowledge_id", "doc_ref", "chunk_index", "created_at"} <= field_names
    assert index_contract_from_description(described["description"]).schema_version == (
        SCHEMA_VERSION - 1
    )

    for name, call in _read_paths(backend, knowledge_id).items():
        with pytest.raises(IndexContractIncompatibleError) as failure:
            call()
        assert failure.value.code == "index_contract_incompatible", name
        assert failure.value.details["bound_schema_version"] == SCHEMA_VERSION - 1
        assert failure.value.details["schema_version"] == SCHEMA_VERSION

    with pytest.raises(IndexContractIncompatibleError):
        backend.index_with_metadata(
            nodes=_nodes(1),
            chunk_metadata=ChunkMetadata(
                knowledge_id=knowledge_id,
                doc_ref="1",
                source_file="older-schema.txt",
                created_at="2026-01-01T00:00:00Z",
            ),
            embed_model=DeterministicEmbedding(CONTRACT_DIMENSION),
        )

    client = MilvusClient(uri=milvus_env.uri)
    try:
        assert client.has_collection(collection_name)
    finally:
        client.close()


def test_a_stable_failure_does_not_expose_the_connection(milvus_env) -> None:
    """The safe message carries the code, not the Milvus target."""
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    _create_foreign_collection(milvus_env.uri, collection_name)

    with pytest.raises(IndexContractIncompatibleError) as failure:
        backend.get_all_chunks(knowledge_id, max_chunks=5)

    assert milvus_env.uri not in str(failure.value)
    assert milvus_env.uri not in repr(failure.value.details)


def test_the_index_contract_needs_no_registry_collection(milvus_env) -> None:
    """The contract is stored in the collection, so no registry collection is made.

    A knowledge base written and read through the product keeps its contract in
    its own collection, and the product creates no registry collection next to
    it. The session fixture already refused a service that still holds the
    registry the previous mechanism created, so absence is asserted outright
    here and the fixture, not this test, reports that environment.
    """
    client = MilvusClient(uri=milvus_env.uri)
    try:
        before = set(client.list_collections())
    finally:
        client.close()

    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    index_nodes(
        backend,
        knowledge_id=knowledge_id,
        doc_ref="1",
        nodes=_nodes(),
    )
    assert backend.get_all_chunks(knowledge_id, max_chunks=5)

    client = MilvusClient(uri=milvus_env.uri)
    try:
        after = set(client.list_collections())
    finally:
        client.close()
    created = after - before
    assert INDEX_REGISTRY_COLLECTION not in created, "this code never creates it"
    assert INDEX_REGISTRY_COLLECTION not in after
    assert collection_name in created


def test_a_physical_drop_needs_the_contract_the_index_declares(milvus_env) -> None:
    """The physical drop is refused when the index it must confirm is gone.

    Dropping the knowledge base's storage drops its parent sidecar, and that is
    only allowed behind the contract the index collection declares. With the
    index collection gone nothing confirms that those names were ours, so the
    drop fails loudly and leaves the sidecar where it is. An intact knowledge
    base still drops both collections.
    """
    backend = milvus_env.backend()
    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    parent_collection_name = f"{collection_name}__parents"
    backend.save_parent_nodes(
        knowledge_id=knowledge_id,
        parent_nodes=[TextNode(text="parent body", metadata={"doc_ref": "1"})],
    )
    index_nodes(backend, knowledge_id=knowledge_id, doc_ref="1", nodes=_nodes())

    _drop_physical_collection(milvus_env.uri, collection_name)

    with pytest.raises(IndexMissingError) as failure:
        backend.drop_knowledge_index(knowledge_id)
    assert failure.value.code == "index_missing"
    assert failure.value.retryable is False

    client = MilvusClient(uri=milvus_env.uri)
    try:
        assert client.has_collection(parent_collection_name), "refused means intact"
    finally:
        client.close()

    # Once the index is back, the contract confirms the drop and both go.
    index_nodes(backend, knowledge_id=knowledge_id, doc_ref="1", nodes=_nodes())
    dropped = backend.drop_knowledge_index(knowledge_id)
    assert dropped["status"] == "dropped"
    assert dropped["dropped_parent_collection"] is True

    client = MilvusClient(uri=milvus_env.uri)
    try:
        assert not client.has_collection(collection_name)
        assert not client.has_collection(parent_collection_name)
    finally:
        client.close()

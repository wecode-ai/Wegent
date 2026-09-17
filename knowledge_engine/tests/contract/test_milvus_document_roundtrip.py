# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus contract tests for the task 01 document round trip.

These tests drive the public document/query entry points against a real Milvus
service (Milvus Lite locally, a version-pinned standalone service in CI). They
verify stored rows, real dense retrieval and real deletes - not SDK call
shapes - and they never skip when the service is unavailable.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError
from knowledge_engine.embedding.vectors import (
    EmptyIndexableContentError,
    InvalidEmbeddingVectorError,
)
from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
)
from shared.models import RetrievalScope

from .conftest import (
    DeterministicEmbedding,
    MilvusContractEnv,
    await_document_visibility,
)

pytestmark = pytest.mark.milvus


def _index_document(
    env: MilvusContractEnv,
    *,
    knowledge_id: str,
    document_id: int,
    text: str,
    dimension: int,
    model_name: str = "contract-model",
    backend=None,
):
    backend = backend or env.backend()
    model = DeterministicEmbedding(dimension, model_name=model_name)
    service = DocumentService(storage_backend=backend)
    result = asyncio.run(
        service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=text.encode("utf-8"),
            source_file=f"document-{document_id}.txt",
            file_extension=".txt",
            embed_model=model,
            user_id=1,
            document_id=document_id,
        )
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=str(document_id),
        expected_chunks=result["chunk_count"],
        user_id=1,
    )
    return backend, model, result


def _query(
    env: MilvusContractEnv,
    *,
    knowledge_id: str,
    query: str,
    dimension: int,
    model_name: str = "contract-model",
    top_k: int = 5,
    score_threshold: float = 0.0,
    scope: RetrievalScope | None = None,
    backend=None,
    model=None,
):
    backend = backend or env.backend()
    model = model or DeterministicEmbedding(dimension, model_name=model_name)
    executor = QueryExecutor(storage_backend=backend, embed_model=model)
    return asyncio.run(
        executor.execute(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_config={
                "top_k": top_k,
                "score_threshold": score_threshold,
                "retrieval_mode": "vector",
            },
            scope=scope,
            user_id=1,
        )
    )


def test_two_knowledge_bases_keep_independent_dimensions(
    milvus_env: MilvusContractEnv,
) -> None:
    """1536d and 4096d knowledge bases are written, searched and scoped apart."""
    small_kb = milvus_env.new_knowledge_id()
    large_kb = milvus_env.new_knowledge_id()

    small_backend, small_model, small_result = _index_document(
        milvus_env,
        knowledge_id=small_kb,
        document_id=101,
        text="alpha beta gamma delta epsilon zeta eta theta",
        dimension=1536,
    )
    large_backend, large_model, large_result = _index_document(
        milvus_env,
        knowledge_id=large_kb,
        document_id=202,
        text="omicron pi rho sigma tau upsilon phi chi",
        dimension=4096,
    )

    assert small_result["dimension"] == 1536
    assert large_result["dimension"] == 4096

    small_hits = _query(
        milvus_env,
        knowledge_id=small_kb,
        query="alpha beta",
        dimension=1536,
        backend=small_backend,
        model=small_model,
    )
    large_hits = _query(
        milvus_env,
        knowledge_id=large_kb,
        query="omicron pi",
        dimension=4096,
        backend=large_backend,
        model=large_model,
    )

    assert small_hits["records"], "expected real dense hits in the 1536d index"
    assert large_hits["records"], "expected real dense hits in the 4096d index"
    assert {record["metadata"]["doc_ref"] for record in small_hits["records"]} == {
        "101"
    }
    assert {record["metadata"]["doc_ref"] for record in large_hits["records"]} == {
        "202"
    }
    assert all(record["score"] > 0 for record in small_hits["records"])


def test_delete_removes_document_and_query_returns_empty(
    milvus_env: MilvusContractEnv,
) -> None:
    """Deleting through the document entry point removes real stored rows."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=303,
        text="delete me please before the assertion runs",
        dimension=1536,
    )

    service = DocumentService(storage_backend=backend)
    delete_result = asyncio.run(
        service.delete_document(knowledge_id=knowledge_id, doc_ref="303", user_id=1)
    )

    assert delete_result["deleted_chunks"] >= 1
    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="delete me please",
        dimension=1536,
        backend=backend,
        model=model,
    )
    assert hits["records"] == []

    # Deleting again stays idempotent and does not recreate anything.
    repeated = asyncio.run(
        service.delete_document(knowledge_id=knowledge_id, doc_ref="303", user_id=1)
    )
    assert repeated["deleted_chunks"] == 0


def test_same_dimension_different_model_space_is_rejected(
    milvus_env: MilvusContractEnv,
) -> None:
    """A same-dimension model swap fails instead of silently degrading."""
    knowledge_id = milvus_env.new_knowledge_id()
    _, _, result = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=404,
        text="space contract text for the first model",
        dimension=1536,
        model_name="model-a",
    )
    assert result["dimension"] == 1536

    with pytest.raises(IndexContractIncompatibleError):
        _index_document(
            milvus_env,
            knowledge_id=knowledge_id,
            document_id=405,
            text="another document with the same dimension",
            dimension=1536,
            model_name="model-b",
        )

    with pytest.raises(IndexContractIncompatibleError):
        _query(
            milvus_env,
            knowledge_id=knowledge_id,
            query="another document",
            dimension=1536,
            model_name="model-b",
        )


def test_query_and_delete_of_missing_index_create_nothing(
    milvus_env: MilvusContractEnv,
) -> None:
    """Empty knowledge bases answer empty without creating a collection."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()

    class ExplodingEmbedding(DeterministicEmbedding):
        def get_query_embedding(self, query):
            raise AssertionError("embedding provider must not be called")

    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="nothing here",
        dimension=1536,
        backend=backend,
        model=ExplodingEmbedding(1536),
    )
    assert hits["records"] == []

    service = DocumentService(storage_backend=backend)
    deleted = asyncio.run(
        service.delete_document(knowledge_id=knowledge_id, doc_ref="nope", user_id=1)
    )
    assert deleted["deleted_chunks"] == 0
    deleted_again = asyncio.run(
        service.delete_document(knowledge_id=knowledge_id, doc_ref="nope", user_id=1)
    )
    assert deleted_again["deleted_chunks"] == 0

    assert milvus_env.has_collection(knowledge_id) is False


def test_partial_write_is_not_queryable(
    milvus_env: MilvusContractEnv, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed write never leaves retrievable content behind."""
    from knowledge_engine.storage.milvus_store import MilvusDocumentStore

    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    write_rows = MilvusDocumentStore.upsert_rows

    def partial_write_then_fail(self, client, collection_name, rows):
        # The server accepted part of the batch before its RPC failed.
        write_rows(self, client, collection_name, list(rows)[:1])
        raise StorageBackendError("simulated write failure")

    monkeypatch.setattr(MilvusDocumentStore, "upsert_rows", partial_write_then_fail)

    with pytest.raises(StorageBackendError):
        _index_document(
            milvus_env,
            knowledge_id=knowledge_id,
            document_id=505,
            text="half written content must never be visible",
            dimension=1536,
            backend=backend,
        )

    monkeypatch.undo()
    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="half written content",
        dimension=1536,
        backend=backend,
    )
    assert hits["records"] == [], "content stayed visible after a failed write"
    assert backend.get_all_chunks(knowledge_id) == []
    with pytest.raises(ValueError):
        backend.get_document(knowledge_id, "505")


def test_confirmed_index_loss_is_not_reported_as_an_empty_knowledge_base(
    milvus_env: MilvusContractEnv,
) -> None:
    """A confirmed index that disappears must fail, not return empty."""
    from pymilvus import MilvusClient

    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=1101,
        text="content whose physical index will be dropped",
        dimension=1536,
    )

    client = MilvusClient(uri=milvus_env.uri)
    try:
        client.drop_collection(backend.get_index_name(knowledge_id))
    finally:
        client.close()

    with pytest.raises(IndexMissingError):
        _query(
            milvus_env,
            knowledge_id=knowledge_id,
            query="content whose physical index",
            dimension=1536,
            backend=backend,
            model=model,
        )
    with pytest.raises(IndexMissingError):
        backend.get_all_chunks(knowledge_id)
    # Deleting a document stays idempotent even when the physical index is gone.
    assert backend.delete_document(knowledge_id, "1101")["deleted_chunks"] == 0


def test_invalid_vectors_never_create_an_index(
    milvus_env: MilvusContractEnv,
) -> None:
    """Empty batches and invalid vectors fail before creating an index."""
    empty_kb = milvus_env.new_knowledge_id()
    whitespace_kb = milvus_env.new_knowledge_id()
    nan_kb = milvus_env.new_knowledge_id()

    service = DocumentService(storage_backend=milvus_env.backend())
    for knowledge_id, payload, document_id in (
        (empty_kb, b"", 606),
        (whitespace_kb, b"   \n  ", 608),
    ):
        with pytest.raises(EmptyIndexableContentError):
            asyncio.run(
                service.index_document_from_binary(
                    knowledge_id=knowledge_id,
                    binary_data=payload,
                    source_file="empty.txt",
                    file_extension=".txt",
                    embed_model=DeterministicEmbedding(1536),
                    user_id=1,
                    document_id=document_id,
                )
            )

    class NaNEmbedding(DeterministicEmbedding):
        def get_text_embedding_batch(self, texts, **kwargs):
            return [[float("nan")] + [0.0] * 1535 for _ in texts]

    with pytest.raises(InvalidEmbeddingVectorError):
        asyncio.run(
            service.index_document_from_binary(
                knowledge_id=nan_kb,
                binary_data=b"nan vector content",
                source_file="nan.txt",
                file_extension=".txt",
                embed_model=NaNEmbedding(1536),
                user_id=1,
                document_id=607,
            )
        )

    assert milvus_env.has_collection(empty_kb) is False
    assert milvus_env.has_collection(whitespace_kb) is False
    assert milvus_env.has_collection(nan_kb) is False


def test_retrieval_scope_limits_documents(
    milvus_env: MilvusContractEnv,
) -> None:
    """A document scope returns only that document's stored chunks."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=701,
        text="alpha unique scope token one",
        dimension=1536,
    )
    _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=702,
        text="alpha unique scope token two",
        dimension=1536,
        backend=backend,
    )

    scoped = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="alpha unique scope token",
        dimension=1536,
        backend=backend,
        model=model,
        scope=RetrievalScope(document_ids=[701]),
    )

    assert scoped["records"]
    assert {record["metadata"]["doc_ref"] for record in scoped["records"]} == {"701"}


def test_resend_is_idempotent_and_score_is_not_renormalized(
    milvus_env: MilvusContractEnv,
) -> None:
    """Re-sending a batch overwrites, and COSINE scores stay raw."""
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, first = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=801,
        text="alpha beta gamma repeated content for scoring",
        dimension=1536,
    )
    _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=801,
        text="alpha beta gamma repeated content for scoring",
        dimension=1536,
        backend=backend,
    )

    document = backend.get_document(knowledge_id, "801")
    stored_chunks = first["chunk_count"]
    assert document["chunk_count"] == stored_chunks

    top_one = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="alpha beta",
        dimension=1536,
        backend=backend,
        model=model,
        top_k=1,
    )
    top_five = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="alpha beta",
        dimension=1536,
        backend=backend,
        model=model,
        top_k=5,
    )
    assert top_one["records"][0]["score"] == top_five["records"][0]["score"]


def test_legacy_collection_without_contract_is_rejected(
    milvus_env: MilvusContractEnv,
) -> None:
    """An unknown existing collection is never adopted or overwritten."""
    from pymilvus import DataType, MilvusClient

    knowledge_id = milvus_env.new_knowledge_id()
    collection_name = milvus_env.collection_name(knowledge_id)
    client = MilvusClient(uri=milvus_env.uri)
    try:
        schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
        schema.add_field("id", DataType.VARCHAR, is_primary=True, max_length=128)
        schema.add_field("dense_vector", DataType.FLOAT_VECTOR, dim=1536)
        index_params = client.prepare_index_params()
        index_params.add_index(
            field_name="dense_vector", index_type="AUTOINDEX", metric_type="COSINE"
        )
        client.create_collection(
            collection_name=collection_name,
            schema=schema,
            index_params=index_params,
        )
    finally:
        client.close()

    with pytest.raises(IndexContractIncompatibleError):
        _index_document(
            milvus_env,
            knowledge_id=knowledge_id,
            document_id=901,
            text="legacy collection content",
            dimension=1536,
        )

    backend = milvus_env.backend()
    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks(knowledge_id)
    with pytest.raises(IndexContractIncompatibleError):
        backend.get_document(knowledge_id, "901")
    with pytest.raises(IndexContractIncompatibleError):
        backend.delete_document(knowledge_id, "901")


def test_concurrent_index_creation_keeps_one_valid_collection(
    milvus_server_env: MilvusContractEnv,
) -> None:
    """Same-contract writers race behind a barrier: one collection stays valid.

    Milvus creates an identical collection idempotently, so both writers may
    succeed; a bounded wait may also make one of them fail explicitly. Both
    outcomes are legal, but the losers must fail loudly - never silently.
    """
    from pymilvus import MilvusClient

    milvus_env = milvus_server_env
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    errors: list[BaseException] = []
    successes: list[int] = []
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def worker(document_id: int) -> None:
        try:
            barrier.wait(timeout=60)
            _index_document(
                milvus_env,
                knowledge_id=knowledge_id,
                document_id=document_id,
                text=f"concurrent content number {document_id}",
                dimension=1536,
                backend=milvus_env.backend(),
            )
            with lock:
                successes.append(document_id)
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            with lock:
                errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(1001 + index,)) for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert successes, f"at least one writer must win; errors={errors}"
    for error in errors:
        assert isinstance(error, IndexContractIncompatibleError), error

    client = MilvusClient(uri=milvus_env.uri)
    try:
        collections = client.list_collections()
    finally:
        client.close()
    assert collections.count(backend.get_index_name(knowledge_id)) == 1

    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="concurrent content",
        dimension=1536,
        backend=backend,
    )
    assert {record["metadata"]["doc_ref"] for record in hits["records"]} == {
        str(document_id) for document_id in successes
    }


def test_concurrent_incompatible_creation_fails_explicitly(
    milvus_server_env: MilvusContractEnv,
) -> None:
    """Same dimension, different model space: both must never succeed."""
    milvus_env = milvus_server_env
    knowledge_id = milvus_env.new_knowledge_id()
    outcomes: list[str] = []
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def worker(model_name: str, document_id: int) -> None:
        try:
            barrier.wait(timeout=60)
            _index_document(
                milvus_env,
                knowledge_id=knowledge_id,
                document_id=document_id,
                text=f"incompatible content {document_id}",
                dimension=1536,
                model_name=model_name,
                backend=milvus_env.backend(),
            )
            result = "ok"
        except (IndexContractIncompatibleError, EmbeddingDimensionMismatchError) as exc:
            result = f"incompatible:{type(exc).__name__}:{exc}"
        except BaseException as exc:  # noqa: BLE001 - surfaced in the assertion
            result = f"error:{type(exc).__name__}"
        with lock:
            outcomes.append(result)

    threads = [
        threading.Thread(target=worker, args=("model-a", 1101)),
        threading.Thread(target=worker, args=("model-b", 1102)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert outcomes.count("ok") <= 1, outcomes
    assert outcomes.count("ok") == 1, outcomes
    assert any(outcome.startswith("incompatible") for outcome in outcomes), outcomes


def test_interrupted_creation_is_never_adopted_by_any_contract(
    milvus_server_env: MilvusContractEnv,
) -> None:
    """The creation window is refused for every writer, without writes.

    Reproduces the reviewed interleaving through the real window: a collection
    exists but its binding was never written (interrupted creation). Neither a
    same-dimension writer with a different embedding space nor the original
    contract may confirm it, and nothing may be written: an operator clears
    the empty collection and retries.
    """
    from knowledge_engine.embedding.space import compute_embedding_space

    milvus_env = milvus_server_env
    knowledge_id = milvus_env.new_knowledge_id()
    backend = milvus_env.backend()
    model = DeterministicEmbedding(1536)
    owner_space = compute_embedding_space(model)
    collection_name = backend.get_index_name(knowledge_id)
    store = backend._store

    with store.client() as client:
        owner_contract = store.build_binding(
            collection_name, dimension=1536, embedding_space=owner_space
        )
        assert store._create_collection(client, owner_contract) is True
        # The creator died before writing the binding.
        assert store.read_binding(client, collection_name) is None

    with store.client() as client:
        for embedding_space in ("sha256:late-writer", owner_space):
            with pytest.raises(IndexContractIncompatibleError):
                store.ensure_index(
                    client,
                    collection_name,
                    dimension=1536,
                    embedding_space=embedding_space,
                )
        assert store.read_binding(client, collection_name) is None

    # Reads of that collection fail loudly instead of returning content.
    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks(knowledge_id)

    # The operator clears the interrupted collection; the KB then rebuilds.
    with store.client() as client:
        client.drop_collection(collection_name=collection_name)

    _, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=1301,
        text="content indexed after the interrupted creation was cleared",
        dimension=1536,
        backend=backend,
    )
    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="content indexed after",
        dimension=1536,
        backend=backend,
        model=model,
    )
    assert hits["records"]


def test_confirmed_binding_is_not_overwritten_by_an_incompatible_writer(
    milvus_server_env: MilvusContractEnv,
) -> None:
    """A different contract never replaces an existing, confirmed one."""
    milvus_env = milvus_server_env
    knowledge_id = milvus_env.new_knowledge_id()
    backend, model, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=1401,
        text="confirmed contract content that must stay queryable",
        dimension=1536,
    )
    collection_name = backend.get_index_name(knowledge_id)
    store = backend._store

    with store.client() as client:
        confirmed = store.read_binding(client, collection_name)
        assert confirmed is not None

        with pytest.raises(IndexContractIncompatibleError):
            store.ensure_index(
                client,
                collection_name,
                dimension=1536,
                embedding_space="sha256:late-writer",
            )

        assert store.read_binding(client, collection_name) == confirmed

    hits = _query(
        milvus_env,
        knowledge_id=knowledge_id,
        query="confirmed contract content",
        dimension=1536,
        backend=backend,
        model=model,
    )
    assert hits["records"]


def test_source_file_and_display_text_survive_the_round_trip(
    milvus_env: MilvusContractEnv,
) -> None:
    """Stored rows keep document identity, display text and retrieval text."""
    from pymilvus import MilvusClient

    from knowledge_engine.storage.milvus_native import (
        DISPLAY_TEXT_FIELD,
        RETRIEVAL_TEXT_FIELD,
    )

    knowledge_id = milvus_env.new_knowledge_id()
    backend, _, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=1201,
        text="display and retrieval text must both be stored",
        dimension=1536,
    )

    client = MilvusClient(uri=milvus_env.uri)
    try:
        rows = client.query(
            collection_name=backend.get_index_name(knowledge_id),
            filter='knowledge_id == "{}"'.format(knowledge_id),
            output_fields=[
                "doc_ref",
                "source_file",
                DISPLAY_TEXT_FIELD,
                RETRIEVAL_TEXT_FIELD,
            ],
            limit=10,
        )
    finally:
        client.close()

    assert rows
    row = rows[0]
    assert row["doc_ref"] == "1201"
    assert row["source_file"] == "document-1201.txt"
    assert "display and retrieval text" in row[DISPLAY_TEXT_FIELD]
    assert row[RETRIEVAL_TEXT_FIELD]


def test_the_collection_keeps_no_publish_or_execution_columns(
    milvus_env: MilvusContractEnv,
) -> None:
    """The physical schema holds the fields retrieval needs and nothing else."""
    from pymilvus import MilvusClient

    knowledge_id = milvus_env.new_knowledge_id()
    backend, _, _ = _index_document(
        milvus_env,
        knowledge_id=knowledge_id,
        document_id=1301,
        text="content whose stored columns are inspected",
        dimension=1536,
    )

    client = MilvusClient(uri=milvus_env.uri)
    try:
        description = client.describe_collection(backend.get_index_name(knowledge_id))
    finally:
        client.close()

    field_names = {field["name"] for field in description["fields"]}
    assert {"published", "generation", "attempt_id"}.isdisjoint(field_names)

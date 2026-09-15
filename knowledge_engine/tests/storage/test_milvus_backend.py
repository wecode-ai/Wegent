# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native MilvusBackend adapter (storage layer faked)."""

from contextlib import contextmanager

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError
from knowledge_engine.embedding.vectors import EmptyIndexableContentError
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    StorageBackendError,
    UnsupportedStorageCapabilityError,
)
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.milvus_native import (
    DISPLAY_TEXT_FIELD,
    METADATA_JSON_FIELD,
    PUBLISHED_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SOURCE_FILE_FIELD,
)
from shared.models import RetrievalScope


class FakeEmbedModel:
    """Deterministic embedding double with a configurable space identity."""

    def __init__(self, vectors, *, dimension=None, model_name="fake-model"):
        self.vectors = vectors
        self._configured_dimension = dimension
        self.model_name = model_name
        self.text_calls: list[list[str]] = []
        self.query_calls: list[str] = []

    def get_text_embedding_batch(self, texts, **kwargs):
        self.text_calls.append(list(texts))
        return [list(vector) for vector in self.vectors[: len(texts)]]

    def get_query_embedding(self, query):
        self.query_calls.append(query)
        return list(self.vectors[0])


class FakeStore:
    """Records the storage-layer calls the adapter makes."""

    def __init__(self, *, collection_exists=True, rows=None, binding="bound"):
        self.collection_exists = collection_exists
        self.rows = list(rows or [])
        self.binding = binding if collection_exists else None
        self.calls: list[tuple] = []
        self.deleted_filters: list[str] = []
        self.queries: list[dict] = []
        self.searches: list[dict] = []
        self.clients_created = 0

    @contextmanager
    def client(self):
        self.clients_created += 1
        yield self

    def has_collection(self, client, collection_name):
        return self.collection_exists

    def ensure_index(self, client, collection_name, *, dimension, embedding_space):
        self.calls.append(("ensure_index", collection_name, dimension, embedding_space))
        self.collection_exists = True
        self.binding = "bound"
        return self.binding

    def verify_index(self, client, collection_name, *, dimension, embedding_space):
        self.calls.append(("verify_index", collection_name, dimension, embedding_space))
        return self.binding

    def read_binding(self, client, collection_name):
        self.calls.append(("read_binding", collection_name))
        return self.binding if self.collection_exists else None

    def require_bound(self, client, collection_name):
        self.calls.append(("require_bound", collection_name))
        if not self.collection_exists:
            return None
        if self.binding is None:
            raise IndexContractIncompatibleError(
                collection_name, "the collection has no stored index contract"
            )
        return self.binding

    def upsert_rows(self, client, collection_name, rows):
        self.calls.append(("upsert_rows", collection_name, list(rows)))
        existing = {row.get("id"): row for row in self.rows if row.get("id")}
        for row in rows:
            if row.get("id"):
                existing[row["id"]] = dict(row)
            else:
                self.rows.append(dict(row))
        replacements = [row for row in self.rows if not row.get("id")]
        self.rows = list(existing.values()) + replacements
        return len(rows)

    def flush(self, client, collection_name):
        self.calls.append(("flush", collection_name))

    def count_rows(self, client, collection_name, filter_expr):
        self.queries.append({"filter": filter_expr, "count": True})
        if "published == true" in filter_expr:
            return sum(
                1
                for row in self.rows
                if row.get(PUBLISHED_FIELD) and self._filter_matches(row, filter_expr)
            )
        return sum(1 for row in self.rows if self._filter_matches(row, filter_expr))

    def delete_rows(self, client, collection_name, filter_expr):
        self.deleted_filters.append(filter_expr)
        self.rows = [
            row for row in self.rows if not self._filter_matches(row, filter_expr)
        ]

    def query_rows(
        self, client, collection_name, filter_expr, *, output_fields=None, limit
    ):
        self.queries.append(
            {"filter": filter_expr, "fields": output_fields, "limit": limit}
        )
        return [
            {key: value for key, value in row.items() if key in (output_fields or row)}
            for row in self.rows
            if self._filter_matches(row, filter_expr)
        ]

    def search(
        self,
        client,
        collection_name,
        *,
        query_vector,
        filter_expr,
        limit,
        output_fields=None,
    ):
        self.searches.append({"filter": filter_expr, "limit": limit})
        return self.rows[:limit]

    @staticmethod
    def _filter_matches(row, filter_expr):
        if "published == true" in filter_expr and not row.get(PUBLISHED_FIELD):
            return False
        if "attempt_id ==" in filter_expr:
            attempt = filter_expr.split('attempt_id == "', 1)[1].split('"', 1)[0]
            if row.get("attempt_id") != attempt:
                return False
        if "doc_ref in [" in filter_expr:
            refs = filter_expr.split("doc_ref in [", 1)[1].split("]", 1)[0]
            allowed = [ref.strip().strip('"') for ref in refs.split(",")]
            if str(row.get("doc_ref")) not in allowed:
                return False
        return True


def _backend(**ext):
    return MilvusBackend(
        {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_dataset", "prefix": "test"},
            "ext": ext,
        }
    )


def _chunk_metadata(**overrides):
    payload = {
        "knowledge_id": "1",
        "doc_ref": "42",
        "source_file": "doc.txt",
        "created_at": "2026-01-01T00:00:00Z",
    }
    payload.update(overrides)
    return ChunkMetadata(**payload)


def _nodes(count=2):
    return [
        TextNode(
            text=f"chunk {index}",
            metadata={
                "knowledge_id": "1",
                "doc_ref": "42",
                "source_file": "doc.txt",
                "chunk_index": index,
                "created_at": "2026-01-01T00:00:00Z",
                RETRIEVAL_TEXT_FIELD: f"retrieval {index}",
                DISPLAY_TEXT_FIELD: f"display {index}",
            },
        )
        for index in range(count)
    ]


def test_init_has_no_default_dimension_and_supports_vector_only():
    backend = _backend()

    assert backend.dim is None
    assert backend.SUPPORTED_RETRIEVAL_METHODS == ["vector"]
    assert backend.supports_retrieval_scope is True
    assert backend.db_name == "default"
    assert backend.base_url == "http://localhost:19530"


def test_init_reads_explicit_dimension_for_validation():
    assert _backend(dim=1536).dim == 1536


def test_create_vector_store_is_not_supported():
    with pytest.raises(UnsupportedStorageCapabilityError):
        _backend().create_vector_store("test_kb_1")


def test_index_empty_batch_fails_before_touching_storage():
    backend = _backend()
    store = FakeStore()
    backend._store = store

    with pytest.raises(EmptyIndexableContentError):
        backend.index_with_metadata(
            nodes=[],
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
        )

    assert store.calls == []
    assert store.clients_created == 0


def test_blank_chunks_are_not_indexed_and_blank_documents_fail():
    backend = _backend()
    store = FakeStore()
    backend._store = store
    blank = TextNode(text="", metadata={"chunk_index": 0})

    with pytest.raises(EmptyIndexableContentError):
        backend.index_with_metadata(
            nodes=[blank],
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
        )

    assert store.clients_created == 0


def test_blank_chunks_are_dropped_when_real_content_exists():
    backend = _backend()
    store = FakeStore()
    backend._store = store
    nodes = [TextNode(text="", metadata={"chunk_index": 7})] + _nodes(1)

    result = backend.index_with_metadata(
        nodes=nodes,
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
    )

    assert result["indexed_count"] == 1


def test_index_writes_unpublished_then_publishes_after_verification():
    backend = _backend()
    store = FakeStore()
    backend._store = store
    model = FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]])

    result = backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
        index_generation=1,
    )

    upserts = [call for call in store.calls if call[0] == "upsert_rows"]
    assert len(upserts) == 2
    unpublished, published = upserts[0][2], upserts[1][2]
    assert all(row[PUBLISHED_FIELD] is False for row in unpublished)
    assert all(row[PUBLISHED_FIELD] is True for row in published)
    assert result["indexed_count"] == 2
    assert result["dimension"] == 2
    assert result["index_name"] == "test_kb_1"
    assert result["status"] == "success"


def test_index_reuses_existing_node_embeddings_without_calling_the_model():
    backend = _backend()
    backend._store = FakeStore()
    nodes = _nodes(1)
    nodes[0].embedding = [0.5, 0.5, 0.0]
    model = FakeEmbedModel([[1.0, 0.0, 0.0]])

    result = backend.index_with_metadata(
        nodes=nodes,
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
    )

    assert result["dimension"] == 3
    assert model.text_calls == []


def test_index_resend_keeps_stable_primary_keys():
    backend = _backend()
    store = FakeStore()
    backend._store = store
    model = FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]])

    def row_ids():
        return [
            row["id"]
            for call in store.calls
            if call[0] == "upsert_rows"
            for row in call[2]
        ]

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
        index_generation=1,
    )
    first_pass = row_ids()
    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
        index_generation=1,
    )
    second_pass = row_ids()[len(first_pass) :]

    assert first_pass[:2] == second_pass[:2]
    assert len(set(second_pass)) == 2


def test_index_rejects_configured_dimension_mismatch():
    backend = _backend(dim=4)
    backend._store = FakeStore()

    with pytest.raises(EmbeddingDimensionMismatchError):
        backend.index_with_metadata(
            nodes=_nodes(1),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
        )


def test_index_fails_when_published_verification_misses_rows():
    backend = _backend()
    store = FakeStore()
    backend._store = store
    original_query = store.query_rows

    def dropping_count_rows(client, collection_name, filter_expr):
        if "published == true" in filter_expr:
            return 0
        return FakeStore.count_rows(store, client, collection_name, filter_expr)

    store.count_rows = dropping_count_rows

    with pytest.raises(StorageBackendError):
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert original_query is not None


def test_publish_failure_rolls_back_visibility():
    """A failure after the publish write must not leave readable content."""
    backend = _backend()
    store = FakeStore()
    backend._store = store

    def fail_on_publish_stage(self, collection_name, filter_expr, *, expected, stage):
        if stage == "publish":
            raise RuntimeError("simulated publish verification failure")
        return None

    backend._assert_visible_row_count = fail_on_publish_stage.__get__(
        backend, type(backend)
    )

    with pytest.raises(RuntimeError):
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    published = [row for row in store.rows if row.get(PUBLISHED_FIELD)]
    assert published == []


def test_retrieve_returns_raw_cosine_scores_above_threshold():
    backend = _backend()
    store = FakeStore(
        rows=[
            {
                "id": "a",
                "content": "hi",
                "doc_ref": "42",
                "source_file": "doc.txt",
                "chunk_index": 0,
                DISPLAY_TEXT_FIELD: "display",
                METADATA_JSON_FIELD: '{"knowledge_id": "1", "doc_ref": "42"}',
                PUBLISHED_FIELD: True,
                "__score__": 0.42,
            },
            {
                "id": "b",
                "content": "lo",
                "doc_ref": "42",
                "source_file": "doc.txt",
                "chunk_index": 1,
                DISPLAY_TEXT_FIELD: "display low",
                METADATA_JSON_FIELD: "{}",
                PUBLISHED_FIELD: True,
                "__score__": 0.11,
            },
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"top_k": 5, "score_threshold": 0.2},
    )

    assert [record["score"] for record in result["records"]] == [0.42]
    assert result["records"][0]["content"] == "display"
    assert "published == true" in store.searches[0]["filter"]
    assert 'knowledge_id == "1"' in store.searches[0]["filter"]


def test_retrieve_missing_index_returns_empty_without_creating():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"top_k": 5, "score_threshold": 0.0},
    )

    assert result == {"records": []}
    assert all(call[0] != "ensure_index" for call in store.calls)


def test_retrieve_missing_index_does_not_call_the_embedding_provider():
    """An empty knowledge base answers empty without a provider request."""
    backend = _backend()
    backend._store = FakeStore(collection_exists=False)

    class ExplodingEmbedModel:
        def get_query_embedding(self, query):
            raise AssertionError("embedding provider must not be called")

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={"top_k": 5, "score_threshold": 0.0},
    )

    assert result == {"records": []}


@pytest.mark.parametrize("mode", ["keyword", "hybrid"])
def test_retrieve_unsupported_modes_fail_loudly(mode):
    with pytest.raises(UnsupportedStorageCapabilityError):
        _backend().retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"retrieval_mode": mode},
        )


def test_retrieve_applies_document_scope_natively():
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        scope=RetrievalScope(document_ids=[7, 8]),
    )

    assert 'doc_ref in ["7", "8"]' in store.searches[0]["filter"]


def test_retrieve_rejects_doc_ref_metadata_condition():
    backend = _backend()
    backend._store = FakeStore(rows=[])

    with pytest.raises(ValueError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "doc_ref", "operator": "eq", "value": "42"}],
            },
        )


def test_retrieve_compiles_supported_metadata_conditions():
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "or",
            "conditions": [
                {"key": "source_file", "operator": "eq", "value": "a.txt"},
                {"key": "chunk_index", "operator": "gte", "value": 3},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert '(source_file == "a.txt" or chunk_index >= 3)' in expression


def test_retrieve_rejects_unsupported_metadata_fields():
    backend = _backend()
    backend._store = FakeStore(rows=[])

    with pytest.raises(UnsupportedStorageCapabilityError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "category", "operator": "eq", "value": "x"}],
            },
        )


def test_delete_missing_document_is_idempotent_and_creates_nothing():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42")

    assert result["deleted_chunks"] == 0
    assert result["status"] == "deleted"
    assert all(call[0] != "ensure_index" for call in store.calls)


def test_delete_document_removes_rows_and_verifies_absence():
    backend = _backend()
    store = FakeStore(
        rows=[
            {"doc_ref": "42", "attempt_id": "gen1", PUBLISHED_FIELD: True},
            {"doc_ref": "42", "attempt_id": "gen1", PUBLISHED_FIELD: False},
            {"doc_ref": "43", "attempt_id": "gen1", PUBLISHED_FIELD: True},
        ]
    )
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42")

    assert result["deleted_chunks"] == 2
    assert store.rows == [
        {"doc_ref": "43", "attempt_id": "gen1", PUBLISHED_FIELD: True}
    ]
    assert len(store.deleted_filters) >= 1


def test_get_document_missing_raises_without_creating():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store

    with pytest.raises(ValueError):
        backend.get_document("1", "42")


def test_reads_reject_a_collection_without_a_contract():
    backend = _backend()
    backend._store = FakeStore(binding=None)
    backend._store.rows = [
        {"doc_ref": "42", PUBLISHED_FIELD: True, DISPLAY_TEXT_FIELD: "x"}
    ]

    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks("1")


def test_get_all_chunks_only_returns_published_rows():
    backend = _backend()
    store = FakeStore(
        rows=[
            {
                "doc_ref": "42",
                "chunk_index": 1,
                DISPLAY_TEXT_FIELD: "second",
                SOURCE_FILE_FIELD: "doc.txt",
                METADATA_JSON_FIELD: "{}",
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "42",
                "chunk_index": 0,
                DISPLAY_TEXT_FIELD: "first",
                SOURCE_FILE_FIELD: "doc.txt",
                METADATA_JSON_FIELD: "{}",
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "42",
                "chunk_index": 2,
                DISPLAY_TEXT_FIELD: "unpublished",
                SOURCE_FILE_FIELD: "doc.txt",
                METADATA_JSON_FIELD: "{}",
                PUBLISHED_FIELD: False,
            },
        ]
    )
    backend._store = store

    chunks = backend.get_all_chunks("1", max_chunks=10)

    assert [chunk["content"] for chunk in chunks] == ["first", "second"]


def test_list_documents_aggregates_published_rows():
    backend = _backend()
    store = FakeStore(
        rows=[
            {
                "doc_ref": "42",
                "source_file": "a.txt",
                "created_at": "2026-01-02T00:00:00Z",
                "chunk_index": 0,
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "42",
                "source_file": "a.txt",
                "created_at": "2026-01-02T00:00:00Z",
                "chunk_index": 1,
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "41",
                "source_file": "b.txt",
                "created_at": "2026-01-01T00:00:00Z",
                "chunk_index": 0,
                PUBLISHED_FIELD: True,
            },
        ]
    )
    backend._store = store

    result = backend.list_documents("1")

    assert result["total"] == 2
    assert result["documents"][0]["doc_ref"] == "42"
    assert result["documents"][0]["chunk_count"] == 2

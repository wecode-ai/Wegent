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
    ANALYZER_TYPE,
    DISPLAY_TEXT_FIELD,
    METADATA_FIELD,
    PUBLISHED_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
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


class FakeBinding:
    """Stored index contract handed back by the fake store."""

    schema_version = SCHEMA_VERSION
    analyzer = ANALYZER_TYPE


def _legacy_binding(*, analyzer=ANALYZER_TYPE, schema_version=SCHEMA_VERSION):
    class LegacyBinding:
        pass

    LegacyBinding.analyzer = analyzer
    LegacyBinding.schema_version = schema_version
    return LegacyBinding()


class FakeStore:
    """Records the storage-layer calls the adapter makes."""

    def __init__(
        self,
        *,
        collection_exists=True,
        rows=None,
        binding=None,
        has_contract=True,
        sparse_hits=None,
    ):
        self.collection_exists = collection_exists
        self.rows = list(rows or [])
        if not collection_exists or not has_contract:
            self.binding = None
        else:
            self.binding = binding or FakeBinding()
        self.calls: list[tuple] = []
        self.deleted_filters: list[str] = []
        self.queries: list[dict] = []
        self.searches: list[dict] = []
        self.sparse_searches: list[dict] = []
        self.sparse_hits: list[dict] = list(sparse_hits or [])
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

    def verify_keyword_index(self, client, collection_name):
        self.calls.append(("verify_keyword_index", collection_name))
        if not self.collection_exists:
            return None
        if self.binding is None:
            raise IndexContractIncompatibleError(
                collection_name, "the collection has no stored index contract"
            )
        if not self.binding.analyzer:
            raise IndexContractIncompatibleError(
                collection_name,
                "the bound index was created without a keyword analyzer",
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

    def sparse_search(
        self,
        client,
        collection_name,
        *,
        query_text,
        filter_expr,
        limit,
        output_fields=None,
    ):
        self.sparse_searches.append(
            {
                "query_text": query_text,
                "filter": filter_expr,
                "limit": limit,
                "fields": output_fields,
            }
        )
        return self.sparse_hits[:limit]

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


def test_init_has_no_default_dimension_and_supports_vector_and_keyword():
    backend = _backend()

    assert backend.dim is None
    assert backend.SUPPORTED_RETRIEVAL_METHODS == ["vector", "keyword"]
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
                METADATA_FIELD: {"knowledge_id": "1", "doc_ref": "42"},
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
                METADATA_FIELD: {},
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

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={"top_k": 5, "score_threshold": 0.0},
    )

    assert result == {"records": []}


@pytest.mark.parametrize("mode", ["hybrid"])
def test_retrieve_unsupported_modes_fail_loudly(mode):
    with pytest.raises(UnsupportedStorageCapabilityError):
        _backend().retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"retrieval_mode": mode},
        )


class ExplodingEmbedModel:
    """Fails the test if keyword retrieval even asks for a vector."""

    def get_query_embedding(self, query):
        raise AssertionError("embedding provider must not be called")

    def get_text_embedding_batch(self, texts, **kwargs):
        raise AssertionError("embedding provider must not be called")


def test_keyword_retrieve_uses_planned_sparse_query_without_embedding():
    """Keyword hits come from server-side BM25 over the retrieved text."""
    backend = _backend()
    store = FakeStore(
        sparse_hits=[
            {
                "id": "a",
                "doc_ref": "42",
                SOURCE_FILE_FIELD: "doc.txt",
                DISPLAY_TEXT_FIELD: "展示正文",
                METADATA_FIELD: {"knowledge_id": "1", "doc_ref": "42"},
                "__score__": 3.0,
            }
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="用户信息",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={
            "retrieval_mode": "keyword",
            "top_k": 5,
            "score_threshold": 0.0,
            "search_hints": {
                "semantic_query": "用户 信息",
                "keywords": ["get_user_by_id"],
            },
        },
    )

    assert store.sparse_searches[0]["query_text"] == "get_user_by_id"
    assert 'knowledge_id == "1"' in store.sparse_searches[0]["filter"]
    assert [record["content"] for record in result["records"]] == ["展示正文"]
    assert result["records"][0]["score"] == pytest.approx(0.75)


def test_keyword_retrieve_applies_the_existing_threshold_to_the_mapped_score():
    backend = _backend()
    store = FakeStore(
        sparse_hits=[
            {
                "id": "a",
                DISPLAY_TEXT_FIELD: "relevant",
                METADATA_FIELD: {},
                "__score__": 3.0,
            },
            {
                "id": "b",
                DISPLAY_TEXT_FIELD: "weak",
                METADATA_FIELD: {},
                "__score__": 0.5,
            },
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={
            "retrieval_mode": "keyword",
            "top_k": 5,
            "score_threshold": 0.7,
        },
    )

    assert [record["content"] for record in result["records"]] == ["relevant"]


def test_keyword_retrieve_keeps_scope_and_metadata_filters():
    backend = _backend()
    store = FakeStore(sparse_hits=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={"retrieval_mode": "keyword", "score_threshold": 0.0},
        scope=RetrievalScope(document_ids=[7, 8]),
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "category", "operator": "eq", "value": "tech"}],
        },
    )

    expression = store.sparse_searches[0]["filter"]
    assert 'knowledge_id == "1"' in expression
    assert 'doc_ref in ["7", "8"]' in expression
    assert 'metadata["category"] == "tech"' in expression
    assert "published == true" in expression


def test_keyword_retrieve_of_a_missing_index_returns_empty_without_embedding():
    backend = _backend()
    backend._store = FakeStore(collection_exists=False)

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={"retrieval_mode": "keyword", "score_threshold": 0.0},
    )

    assert result == {"records": []}


def test_keyword_retrieve_rejects_an_index_without_the_keyword_capability():
    backend = _backend()
    store = FakeStore(has_contract=False)
    backend._store = store

    with pytest.raises(IndexContractIncompatibleError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=ExplodingEmbedModel(),
            retrieval_setting={"retrieval_mode": "keyword", "score_threshold": 0.0},
        )


def test_keyword_retrieve_rejects_a_contract_without_an_analyzer():
    backend = _backend()
    backend._store = FakeStore(binding=_legacy_binding(analyzer=""))

    with pytest.raises(IndexContractIncompatibleError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=ExplodingEmbedModel(),
            retrieval_setting={"retrieval_mode": "keyword", "score_threshold": 0.0},
        )


def test_reads_reject_a_contract_from_an_older_schema():
    """An index an older schema wrote is rebuilt, never read as empty."""
    backend = _backend()
    backend._store = FakeStore(
        binding=_legacy_binding(schema_version=SCHEMA_VERSION - 1)
    )

    with pytest.raises(IndexContractIncompatibleError):
        backend.get_document("1", "42")
    with pytest.raises(IndexContractIncompatibleError):
        backend.list_documents("1")
    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks("1")


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


def test_retrieve_filters_user_metadata_through_the_native_json_column():
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "category", "operator": "eq", "value": "x"},
                {"key": "year", "operator": "gte", "value": 2024},
                {"key": "archived", "operator": "eq", "value": False},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert 'metadata["category"] == "x"' in expression
    assert 'metadata["year"] >= 2024' in expression
    assert 'metadata["archived"] == false' in expression


def test_retrieve_accepts_numeric_lists_without_scalar_validation():
    """A list value on a numeric field is a list comparison, not a scalar."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "generation", "operator": "in", "value": [0, 1]},
                {"key": "chunk_index", "operator": "nin", "value": [7]},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert "generation in [0, 1]" in expression
    assert "chunk_index not in [7]" in expression


def test_retrieve_escapes_quotes_and_backslashes_in_metadata_conditions():
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "category", "operator": "eq", "value": 'a"b\\c'},
            ],
        },
    )

    assert 'metadata["category"] == "a\\"b\\\\c"' in store.searches[0]["filter"]


def test_retrieve_compiles_text_conditions_against_json_and_arrays():
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
                {"key": "tags", "operator": "contains", "value": "alpha"},
                {"key": "source_file", "operator": "text_match", "value": "doc"},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert (
        '(json_contains(metadata["tags"], "alpha") '
        'or metadata["tags"] like "%alpha%")' in expression
    )
    assert 'source_file like "%doc%"' in expression


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("alpha", 'json_contains(metadata["tags"], "alpha")'),
        (2026, 'json_contains(metadata["tags"], 2026)'),
        (True, 'json_contains(metadata["tags"], true)'),
    ],
)
def test_retrieve_compiles_json_array_membership_with_the_value_type(value, expected):
    """A JSON array element keeps its type: 2026 is a number, not "2026"."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "tags", "operator": "contains", "value": value}],
        },
    )

    assert expected in store.searches[0]["filter"]


@pytest.mark.parametrize("value", ["50%off", "get_user_by_id"])
def test_retrieve_rejects_text_conditions_milvus_cannot_match_literally(value):
    """A literal LIKE wildcard has no escaped form, so the condition fails."""
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
                "conditions": [
                    {"key": "category", "operator": "contains", "value": value}
                ],
            },
        )


def test_retrieve_rejects_nested_metadata_conditions():
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
                "conditions": [
                    {
                        "operator": "or",
                        "conditions": [{"key": "category", "operator": "eq"}],
                    }
                ],
            },
        )


def test_retrieve_rejects_non_scalar_values_outside_in_nin():
    """A list value is only meaningful for in/nin; anything else fails."""
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
                "conditions": [
                    {"key": "category", "operator": "eq", "value": ["a", "b"]},
                ],
            },
        )


def test_retrieve_skips_null_value_conditions_like_elasticsearch():
    """A condition with no value carries no constraint in the shared contract."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "category", "operator": "eq", "value": None}],
        },
    )

    assert "metadata[" not in store.searches[0]["filter"]


@pytest.mark.parametrize("key", ["published", "id"])
def test_retrieve_rejects_internal_identity_metadata_conditions(key):
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
                "conditions": [{"key": key, "operator": "eq", "value": "x"}],
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
    backend._store = FakeStore(has_contract=False)
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
                METADATA_FIELD: {},
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "42",
                "chunk_index": 0,
                DISPLAY_TEXT_FIELD: "first",
                SOURCE_FILE_FIELD: "doc.txt",
                METADATA_FIELD: {},
                PUBLISHED_FIELD: True,
            },
            {
                "doc_ref": "42",
                "chunk_index": 2,
                DISPLAY_TEXT_FIELD: "unpublished",
                SOURCE_FILE_FIELD: "doc.txt",
                METADATA_FIELD: {},
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

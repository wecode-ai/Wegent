# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native MilvusBackend adapter (storage layer faked)."""

import re
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

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
from knowledge_engine.storage.milvus_rows import MAX_READ_LIMIT
from shared.models import RetrievalScope

_CLAUSE_SEPARATOR = re.compile(r"\s+(and|or)\s+")
_JSON_CLAUSE = re.compile(
    r'^metadata\["(?P<key>.+?)"\] (?P<operator>==|!=|in|not in|>=|<=|>|<) '
    r"(?P<value>.+)$"
)
_JSON_MEMBERSHIP_CLAUSE = re.compile(
    r'^json_contains\(metadata\["(?P<key>.+?)"\], (?P<value>.+)\)$'
)
_JSON_SUBSTRING_CLAUSE = re.compile(
    r'^metadata\["(?P<key>.+?)"\] like "%(?P<value>.*)%"$'
)
_COLUMN_CLAUSE = re.compile(
    r"^(?P<key>\w+) (?P<operator>==|!=|in|not in|>=|<=|>|<) (?P<value>.+)$"
)


def _split_expression(expression: str, operator: str) -> list[str]:
    """Split one boolean expression on its top level ``operator``."""
    parts: list[str] = []
    current = ""
    depth = 0
    index = 0
    while index < len(expression):
        character = expression[index]
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
        if depth == 0 and current:
            match = _CLAUSE_SEPARATOR.match(expression, index)
            if match and match.group(1) == operator:
                parts.append(current)
                current = ""
                index = match.end()
                continue
        current += character
        index += 1
    parts.append(current)
    return [part.strip() for part in parts if part.strip()]


def _parse_literal(raw_literal: str) -> Any:
    text = raw_literal.strip()
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        return [] if not inner else [_parse_literal(item) for item in inner.split(",")]
    if text == "true":
        return True
    if text == "false":
        return False
    if text.startswith('"') and text.endswith('"'):
        return text[1:-1]
    try:
        return float(text)
    except ValueError:
        return text


def _compare(actual: Any, operator: str, expected: Any) -> bool:
    if operator == "==":
        return actual == expected
    if operator == "!=":
        return actual != expected
    if operator == "in":
        return actual in expected
    if operator == "not in":
        return actual not in expected
    if not _is_number(actual) or not _is_number(expected):
        return False
    comparisons = {
        ">": lambda left, right: left > right,
        ">=": lambda left, right: left >= right,
        "<": lambda left, right: left < right,
        "<=": lambda left, right: left <= right,
    }
    return comparisons[operator](actual, expected)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _enclosing_group(expression: str) -> Optional[str]:
    """Return the inside of the parentheses that wrap the whole expression."""
    if not (expression.startswith("(") and expression.endswith(")")):
        return None
    depth = 0
    for index, character in enumerate(expression):
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0 and index != len(expression) - 1:
                return None
    return expression[1:-1]


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
        # Every contract lookup below reads the shared registry in the real
        # store, so one request costs one registry read per lookup.
        self.contract_reads = 0
        self.deleted_filters: list[str] = []
        self.queries: list[dict] = []
        self.searches: list[dict] = []
        self.sparse_searches: list[dict] = []
        self.sparse_hits: list[dict] = list(sparse_hits or [])
        self.clients_created = 0
        self.clients_closed = 0

    @contextmanager
    def client(self):
        self.clients_created += 1
        try:
            yield self
        finally:
            self.clients_closed += 1

    def has_collection(self, client, collection_name):
        return self.collection_exists

    def ensure_index(self, client, collection_name, *, dimension, embedding_space):
        self.calls.append(("ensure_index", collection_name, dimension, embedding_space))
        self.collection_exists = True
        self.binding = "bound"
        return self.binding

    def verify_bound_contract(
        self, client, collection_name, binding, *, dimension, embedding_space
    ):
        self.calls.append(
            ("verify_bound_contract", collection_name, dimension, embedding_space)
        )

    def read_binding(self, client, collection_name):
        self.calls.append(("read_binding", collection_name))
        self.contract_reads += 1
        return self.binding if self.collection_exists else None

    def read_binding_strong(self, client, collection_name):
        self.calls.append(("read_binding_strong", collection_name))
        self.contract_reads += 1
        return self.binding if self.collection_exists else None

    def require_bound(self, client, collection_name):
        self.calls.append(("require_bound", collection_name))
        self.contract_reads += 1
        if not self.collection_exists:
            return None
        if self.binding is None:
            raise IndexContractIncompatibleError(
                collection_name, "the collection has no stored index contract"
            )
        return self.binding

    def verify_keyword_binding(self, collection_name, binding):
        self.calls.append(("verify_keyword_binding", collection_name, binding.analyzer))
        if not binding.analyzer:
            raise IndexContractIncompatibleError(
                collection_name,
                "the bound index was created without a keyword analyzer",
            )

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
        # Recorded so a reintroduced write-path flush fails the test below.
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

    def delete_rows(
        self, client, collection_name, filter_expr, *, flush: bool = True
    ) -> None:
        self.calls.append(("delete_rows", collection_name, filter_expr))
        self.deleted_filters.append(filter_expr)
        if flush:
            self.flush(client, collection_name)
        self.rows = [
            row for row in self.rows if not self._filter_matches(row, filter_expr)
        ]

    def query_rows(
        self,
        client,
        collection_name,
        filter_expr,
        *,
        output_fields=None,
        limit,
        offset=0,
    ):
        """Answer one page the way Milvus does: filter, then offset and limit."""
        self.queries.append(
            {
                "filter": filter_expr,
                "fields": output_fields,
                "limit": limit,
                "offset": offset,
            }
        )
        matching = [row for row in self.rows if self._filter_matches(row, filter_expr)]
        return [
            {key: value for key, value in row.items() if key in (output_fields or row)}
            for row in matching[offset : offset + limit]
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

    @classmethod
    def _filter_matches(cls, row: Dict[str, Any], filter_expr: str) -> bool:
        """Evaluate a filter with the semantics the compiled clauses promise.

        The double understands exactly the clause shapes the Milvus compiler
        emits for the reading and delete paths. An unknown shape raises, so a
        test can never pass against a filter this double silently ignores.
        """
        return cls._expression_matches(row, filter_expr)

    @classmethod
    def _expression_matches(cls, row: Dict[str, Any], expression: str) -> bool:
        """Evaluate one boolean expression, innermost groups first."""
        expression = expression.strip()
        conjuncts = _split_expression(expression, "and")
        if len(conjuncts) > 1:
            return all(cls._expression_matches(row, part) for part in conjuncts)
        inner = _enclosing_group(expression)
        if inner is not None:
            alternates = _split_expression(inner, "or")
            if len(alternates) > 1:
                return any(cls._expression_matches(row, part) for part in alternates)
            return cls._expression_matches(row, inner)
        return cls._clause_matches(row, expression)

    @classmethod
    def _clause_matches(cls, row: Dict[str, Any], clause: str) -> bool:
        membership = _JSON_MEMBERSHIP_CLAUSE.match(clause)
        if membership:
            return cls._metadata_value(row, membership.group("key")) == _parse_literal(
                membership.group("value")
            )
        substring = _JSON_SUBSTRING_CLAUSE.match(clause)
        if substring:
            return substring.group("value") in str(
                cls._metadata_value(row, substring.group("key")) or ""
            )
        for pattern in (_JSON_CLAUSE, _COLUMN_CLAUSE):
            match = pattern.match(clause)
            if not match:
                continue
            key = match.group("key")
            if key == "knowledge_id":
                # The double's rows already live inside the requested index.
                return True
            if pattern is _JSON_CLAUSE:
                actual = cls._metadata_value(row, key)
            else:
                actual = row.get(key)
            return _compare(
                actual, match.group("operator"), _parse_literal(match.group("value"))
            )
        raise AssertionError(f"the fake store cannot evaluate the clause {clause!r}")

    @staticmethod
    def _metadata_value(row: Dict[str, Any], key: str) -> Any:
        metadata = row.get(METADATA_FIELD) or {}
        return metadata.get(key)


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


def test_init_has_no_default_dimension_and_supports_all_three_modes():
    backend = _backend()

    assert backend.dim is None
    assert backend.SUPPORTED_RETRIEVAL_METHODS == ["vector", "keyword", "hybrid"]
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


def test_index_publishes_without_waiting_for_a_flush():
    """Publication is proven by the verification read, not by a flush.

    The reasoning behind dropping the per-document flush is recorded on
    ``MilvusBackend._publish_rows``.
    """
    backend = _backend()
    store = FakeStore()
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
    )

    assert all(call[0] != "flush" for call in store.calls)
    published = [
        query for query in store.queries if "published == true" in query["filter"]
    ]
    assert published, "the publish is still verified, just not by flushing"


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


def _stored_chunk_row(doc_ref: str, chunk_index: int, *, published: bool = True):
    """A row as a previous index of ``doc_ref`` would have left it."""
    return {
        "id": f"{doc_ref}-{chunk_index}",
        "knowledge_id": "1",
        "doc_ref": doc_ref,
        "chunk_index": chunk_index,
        RETRIEVAL_TEXT_FIELD: "stale",
        DISPLAY_TEXT_FIELD: "stale tail",
        METADATA_FIELD: {},
        PUBLISHED_FIELD: published,
    }


def test_rewrite_drops_the_documents_previous_rows_before_staging():
    """A rewrite replaces one document instead of layering versions."""
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_chunk_row("42", 0),
            _stored_chunk_row("42", 2),
            # A previous attempt that never published its rows still has to go.
            _stored_chunk_row("42", 5, published=False),
            _stored_chunk_row("43", 0),
        ]
    )
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
    )

    remaining_ids = {row.get("id") for row in store.rows}
    assert {"42-0", "42-2", "42-5"}.isdisjoint(remaining_ids)
    assert "43-0" in remaining_ids
    scope = store.deleted_filters[0]
    assert 'knowledge_id == "1"' in scope
    assert 'doc_ref in ["42"]' in scope
    # The document that owns the rows is dropped before the new rows land.
    deletions = [i for i, call in enumerate(store.calls) if call[0] == "delete_rows"]
    staging = [i for i, call in enumerate(store.calls) if call[0] == "upsert_rows"]
    assert deletions and deletions[0] < staging[0]
    assert all(call[0] != "flush" for call in store.calls)


def test_rewrite_of_a_document_without_rows_issues_no_delete():
    """The common first write does not pay for a cleanup nobody needs."""
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("43", 0)])
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
    )

    assert store.deleted_filters == []


def test_rewrite_fails_when_the_previous_rows_cannot_be_removed():
    """An unverified cleanup fails loudly instead of publishing mixed content."""

    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 7)])
    backend._store = store

    def keep_rows(client, collection_name, filter_expr, *, flush=True):
        store.calls.append(("delete_rows", collection_name, filter_expr))
        store.deleted_filters.append(filter_expr)

    store.delete_rows = keep_rows

    with pytest.raises(StorageBackendError):
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert all(call[0] != "upsert_rows" for call in store.calls)


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


def test_retrieve_without_a_threshold_keeps_low_scoring_hits():
    """An absent score_threshold means "do not cut" on the Milvus read path."""
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
        retrieval_setting={"top_k": 5},
    )

    assert [record["score"] for record in result["records"]] == [0.42, 0.11]


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


@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_one_retrieve_reads_the_stored_contract_once(retrieval_mode):
    """One request reads the registry once and reuses that contract.

    The stored contract cannot change while a single request is in flight, so
    asking the registry again inside the same request only adds a Strong
    consistency round trip. A contract the read level sees is therefore never
    re-read: the write-level fallback only answers one it missed.
    """
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="深度学习模型训练 zebra_pipeline_99",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": retrieval_mode,
            "top_k": 5,
            "score_threshold": 0.0,
        },
    )

    assert store.contract_reads == 1
    assert [name for name, *_ in store.calls].count("read_binding_strong") == 0
    assert store.searches or store.sparse_searches


class _ContractInvisibleToTheReadLevel(FakeStore):
    """The publication window: the collection is visible, the contract is not."""

    def read_binding(self, client, collection_name):
        super().read_binding(client, collection_name)
        return None


class _ContractInvisibleAtEveryLevel(_ContractInvisibleToTheReadLevel):
    """A collection whose contract the request can never observe."""

    def read_binding_strong(self, client, collection_name):
        super().read_binding_strong(client, collection_name)
        return None


def _exploding_search(*args, **kwargs):
    raise StorageBackendError("the storage call failed")


def test_a_contract_invisible_to_the_read_level_is_re_read_once():
    """A contract committed moments ago answers instead of failing.

    The collection is already visible while its contract row is not, so the
    request re-reads the contract at the write level on the client it holds.
    """
    backend = _backend()
    store = _ContractInvisibleToTheReadLevel(
        rows=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="深度学习模型训练 zebra_pipeline_99",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "vector",
            "top_k": 5,
            "score_threshold": 0.0,
        },
    )

    assert [name for name, *_ in store.calls].count("read_binding_strong") == 1
    assert store.contract_reads == 2
    assert store.clients_created == 1
    assert store.clients_closed == 1
    assert result["records"]


def test_a_contract_invisible_at_every_level_still_fails():
    """A collection that really lost its contract must not degrade to empty."""
    backend = _backend()
    store = _ContractInvisibleAtEveryLevel()
    backend._store = store

    with pytest.raises(IndexContractIncompatibleError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=ExplodingEmbedModel(),
            retrieval_setting={
                "retrieval_mode": "vector",
                "top_k": 5,
                "score_threshold": 0.0,
            },
        )

    assert store.contract_reads == 2
    assert not store.searches


@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_one_retrieve_owns_exactly_one_client(retrieval_mode):
    """One request costs one client lifetime, not one per storage lookup.

    The client is still created per request and closed in ``finally``, so
    concurrent requests keep owning independent connections; the point is that
    a single request no longer pays the teardown twice - including a request
    that falls back to the write-level contract read.
    """
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="深度学习模型训练 zebra_pipeline_99",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": retrieval_mode,
            "top_k": 5,
            "score_threshold": 0.0,
        },
    )

    assert store.clients_created == 1
    assert store.clients_closed == 1


@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_a_failing_retrieve_still_releases_its_client(retrieval_mode):
    """A retrieval that raises on the storage call closes what it opened."""
    backend = _backend()
    store = _hybrid_store()
    store.search = _exploding_search
    store.sparse_search = _exploding_search
    backend._store = store

    with pytest.raises(StorageBackendError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={
                "retrieval_mode": retrieval_mode,
                "top_k": 5,
                "score_threshold": 0.0,
            },
        )

    assert store.clients_created == 1
    assert store.clients_closed == 1


def test_retrieve_unsupported_mode_fails_loudly():
    with pytest.raises(UnsupportedStorageCapabilityError):
        _backend().retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"retrieval_mode": "rerank"},
        )


def _hybrid_hit(row_id, doc_ref, *, display, score):
    return {
        "id": row_id,
        "doc_ref": doc_ref,
        SOURCE_FILE_FIELD: f"document-{doc_ref}.txt",
        DISPLAY_TEXT_FIELD: display,
        METADATA_FIELD: {"knowledge_id": "1", "doc_ref": doc_ref},
        "__score__": score,
    }


def _hybrid_store():
    """One candidate only the dense branch prefers and one only BM25 prefers."""
    return FakeStore(
        rows=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)],
        sparse_hits=[
            _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=0.5)
        ],
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


def test_hybrid_retrieve_fuses_both_branches_with_the_default_weights():
    """Hybrid queries both routes over one filter and fuses their raw scores."""
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="深度学习模型训练 zebra_pipeline_99",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
        },
    )

    dense_request = store.searches[0]
    keyword_request = store.sparse_searches[0]
    assert dense_request["limit"] == 5
    assert keyword_request["limit"] == 5
    assert dense_request["filter"] == keyword_request["filter"]
    assert 'knowledge_id == "1"' in dense_request["filter"]
    assert "published == true" in dense_request["filter"]
    assert [record["content"] for record in result["records"]] == [
        "dense 偏好",
        "keyword 偏好",
    ]
    # Default 0.7/0.3 of the fixed mappings: dense (1+0.75)/2, keyword 0.5/1.5.
    assert result["records"][0]["score"] == pytest.approx(0.7 * 0.875)
    assert result["records"][1]["score"] == pytest.approx(0.3 * (0.5 / 1.5))
    assert result["records"][0]["title"] == "document-42.txt"
    assert result["records"][0]["metadata"]["doc_ref"] == "42"


def test_hybrid_retrieve_sums_both_shares_for_a_row_both_routes_recall():
    """A row recalled by both routes reports the sum, not the larger share."""
    backend = _backend()
    shared_row = _hybrid_hit("shared-row", "42", display="两路都命中", score=0.75)
    store = FakeStore(
        rows=[shared_row],
        sparse_hits=[dict(shared_row, **{"__score__": 1.0})],
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
            "vector_weight": 0.5,
            "keyword_weight": 0.5,
        },
    )

    # Dense (1 + 0.75) / 2 = 0.875 and keyword 1.0 / 2.0 = 0.5, summed.
    assert [record["content"] for record in result["records"]] == ["两路都命中"]
    assert result["records"][0]["score"] == pytest.approx(0.5 * 0.875 + 0.5 * 0.5)


@pytest.mark.parametrize(
    ("vector_weight", "keyword_weight", "dense_share", "keyword_share"),
    [
        (0.9, 0.1, 0.9, 0.1),
        (0.1, 0.9, 0.1, 0.9),
        (3.0, 1.0, 0.75, 0.25),
    ],
)
def test_hybrid_retrieve_weights_the_two_contributions(
    vector_weight, keyword_weight, dense_share, keyword_share
):
    """Each route contributes exactly its normalized share of the fusion."""
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
            "vector_weight": vector_weight,
            "keyword_weight": keyword_weight,
        },
    )

    scores = {record["content"]: record["score"] for record in result["records"]}
    assert scores["dense 偏好"] == pytest.approx(dense_share * 0.875)
    assert scores["keyword 偏好"] == pytest.approx(keyword_share * (0.5 / 1.5))
    if vector_weight > keyword_weight:
        assert [record["content"] for record in result["records"]] == [
            "dense 偏好",
            "keyword 偏好",
        ]
    else:
        assert [record["content"] for record in result["records"]] == [
            "keyword 偏好",
            "dense 偏好",
        ]


def test_hybrid_threshold_cuts_the_reported_fusion_score():
    """The threshold compares exactly the score the caller receives."""
    backend = _backend()
    store = FakeStore(
        sparse_hits=[
            _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=0.5)
        ],
        rows=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)],
    )
    backend._store = store
    settings = {
        "retrieval_mode": "hybrid",
        "top_k": 5,
        "vector_weight": 0.7,
        "keyword_weight": 0.3,
    }

    above_both = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={**settings, "score_threshold": 0.05},
    )
    between = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={**settings, "score_threshold": 0.3},
    )
    below_both = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={**settings, "score_threshold": 0.7},
    )

    # Reported fusion scores: dense 0.7 * (1 + 0.75) / 2 = 0.6125, keyword
    # 0.3 * 0.5 / 1.5 = 0.1. The cut is that same score, so 0.05 keeps both,
    # 0.3 keeps the dense row only and 0.7 keeps neither.
    assert [record["content"] for record in above_both["records"]] == [
        "dense 偏好",
        "keyword 偏好",
    ]
    assert [record["content"] for record in between["records"]] == ["dense 偏好"]
    assert between["records"][0]["score"] == pytest.approx(0.7 * 0.875)
    assert below_both == {"records": []}


def test_hybrid_threshold_keeps_a_score_equal_to_the_cut():
    """The boundary is inclusive, exactly like the other retrieval modes."""
    backend = _backend()
    store = FakeStore(
        sparse_hits=[
            _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=0.5)
        ],
        rows=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)],
    )
    backend._store = store
    fusion_score = 0.7 * 0.875

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "vector_weight": 0.7,
            "keyword_weight": 0.3,
            "score_threshold": fusion_score,
        },
    )

    assert [record["content"] for record in result["records"]] == ["dense 偏好"]
    assert result["records"][0]["score"] == pytest.approx(fusion_score)


@pytest.mark.parametrize(
    ("configured", "dense_share", "keyword_share"),
    [
        ({"keyword_weight": 0.3}, 0.7, 0.3),
        ({"vector_weight": 0.5}, 0.5, 0.5),
        ({"keyword_weight": 0.1}, 0.9, 0.1),
    ],
)
def test_hybrid_retrieve_completes_a_single_configured_weight(
    configured, dense_share, keyword_share
):
    """A lone weight keeps its share and the partner takes the remainder."""
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
            **configured,
        },
    )

    scores = {record["content"]: record["score"] for record in result["records"]}
    assert scores["dense 偏好"] == pytest.approx(dense_share * 0.875)
    assert scores["keyword 偏好"] == pytest.approx(keyword_share * (0.5 / 1.5))


def test_hybrid_retrieve_with_full_vector_weight_skips_the_keyword_branch():
    """A 1/0 endpoint still runs only the effective branch."""
    backend = _backend()
    store = FakeStore(
        rows=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
            "vector_weight": 1.0,
            "keyword_weight": 0.0,
        },
    )

    assert store.searches, "the dense branch must still run"
    assert store.sparse_searches == []
    assert [record["content"] for record in result["records"]] == ["dense 偏好"]
    # The vector endpoint reports the raw cosine score of the pure vector mode.
    assert result["records"][0]["score"] == pytest.approx(0.75)


def test_hybrid_retrieve_with_full_keyword_weight_never_embeds():
    """The 0/1 endpoint answers from BM25 alone and builds no query vector."""
    backend = _backend()
    store = _hybrid_store()
    store.sparse_hits = [
        _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=3.0)
    ]
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.0,
            "vector_weight": 0.0,
            "keyword_weight": 1.0,
        },
    )

    assert store.searches == []
    assert store.sparse_searches, "the keyword branch must run"
    # The keyword endpoint reports the keyword mode's fixed s/(1+s) mapping.
    assert result["records"][0]["content"] == "keyword 偏好"
    assert result["records"][0]["score"] == pytest.approx(0.75)


@pytest.mark.parametrize(
    ("weights", "message"),
    [
        ({"vector_weight": -0.1, "keyword_weight": 1.0}, "vector_weight"),
        ({"vector_weight": 1.0, "keyword_weight": -0.1}, "keyword_weight"),
        ({"vector_weight": 1.1}, "vector_weight"),
        ({"keyword_weight": 1.1}, "keyword_weight"),
        ({"vector_weight": "0.7", "keyword_weight": 0.3}, "vector_weight"),
        ({"keyword_weight": ["0.3"]}, "keyword_weight"),
        ({"vector_weight": float("nan"), "keyword_weight": 0.5}, "vector_weight"),
        ({"vector_weight": float("inf"), "keyword_weight": 0.5}, "vector_weight"),
        ({"keyword_weight": float("nan")}, "keyword_weight"),
        ({"vector_weight": 0.0, "keyword_weight": 0.0}, "zero"),
        ({"vector_weight": -0.0, "keyword_weight": -0.0}, "zero"),
    ],
)
def test_hybrid_retrieve_rejects_invalid_weights(weights, message):
    """Invalid weights fail explicitly instead of silently changing the mode."""
    backend = _backend()
    backend._store = _hybrid_store()

    with pytest.raises(ValueError) as error:
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"retrieval_mode": "hybrid", **weights},
        )

    assert message in str(error.value)


def test_hybrid_retrieve_keeps_scope_and_metadata_filters():
    """Both branches share the same scope and metadata predicate."""
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"retrieval_mode": "hybrid", "score_threshold": 0.0},
        scope=RetrievalScope(document_ids=[7, 8]),
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "category", "operator": "eq", "value": "tech"}],
        },
    )

    expression = store.searches[0]["filter"]
    assert store.searches[0]["filter"] == store.sparse_searches[0]["filter"]
    assert 'knowledge_id == "1"' in expression
    assert 'doc_ref in ["7", "8"]' in expression
    assert 'metadata["category"] == "tech"' in expression
    assert "published == true" in expression


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
    ("value", "membership", "substring"),
    [
        (
            "alpha",
            'json_contains(metadata["tags"], "alpha")',
            'metadata["tags"] like "%alpha%"',
        ),
        (
            2026,
            'json_contains(metadata["tags"], 2026)',
            'metadata["tags"] like "%2026%"',
        ),
        (
            True,
            'json_contains(metadata["tags"], true)',
            'metadata["tags"] like "%true%"',
        ),
    ],
)
def test_retrieve_keeps_json_array_membership_typed_and_the_substring_path(
    value, membership, substring
):
    """A JSON condition keeps both the typed element match and the substring."""
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

    expression = store.searches[0]["filter"]
    assert membership in expression
    assert substring in expression


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
    # The delete entry point promises a durable removal, unlike a rewrite.
    assert ("flush", "test_kb_1") in store.calls


def test_delete_document_never_prepares_vectors(monkeypatch):
    """Removing stored rows must not reach for the embedding provider."""
    import knowledge_engine.embedding.vectors as vectors

    def forbidden(*args, **kwargs):
        raise AssertionError("delete must not prepare an embedding vector")

    monkeypatch.setattr(vectors, "prepare_text_vectors", forbidden)
    monkeypatch.setattr(vectors, "prepare_query_vector", forbidden)

    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0)])
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42")

    assert result["deleted_chunks"] == 1


def test_delete_knowledge_clears_only_the_knowledge_base_scope():
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0), _stored_chunk_row("42", 1)])
    backend._store = store

    result = backend.delete_knowledge("1")

    assert result["deleted_chunks"] == 2
    assert result["status"] == "deleted"
    assert store.rows == []
    assert store.deleted_filters, "the chunks and the parent store are cleared"
    assert all('knowledge_id == "1"' in expr for expr in store.deleted_filters)


def test_drop_knowledge_index_refuses_a_shared_collection():
    """Only a collection the knowledge base owns may be dropped."""
    backend = MilvusBackend(
        {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"mode": "per_user", "prefix": "test"},
            "ext": {},
        }
    )
    store = FakeStore()
    backend._store = store

    with pytest.raises(ValueError):
        backend.drop_knowledge_index("1", user_id=7)

    assert store.calls == []


def test_get_document_missing_raises_without_creating():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store

    with pytest.raises(ValueError):
        backend.get_document("1", "42")


def _chunk_rows(
    doc_ref: str,
    chunk_indexes,
    *,
    metadata: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    return [
        {
            "doc_ref": doc_ref,
            "source_file": f"{doc_ref}.txt",
            "chunk_index": index,
            DISPLAY_TEXT_FIELD: f"chunk {index}",
            METADATA_FIELD: dict(metadata or {}),
            PUBLISHED_FIELD: True,
        }
        for index in chunk_indexes
    ]


def test_get_document_reads_every_chunk_across_pages():
    """A document longer than one internal page is still complete."""
    backend = _backend()
    backend._store = FakeStore(rows=_chunk_rows("42", range(2500)))

    document = backend.get_document("1", "42")

    assert document["chunk_count"] == 2500
    assert [chunk["chunk_index"] for chunk in document["chunks"]] == list(range(2500))


def test_get_document_fails_when_the_document_exceeds_the_read_budget():
    """A truncated document must not be reported as the complete one."""
    backend = _backend()
    backend._store = FakeStore(rows=_chunk_rows("42", range(MAX_READ_LIMIT + 1)))

    with pytest.raises(StorageBackendError):
        backend.get_document("1", "42")


def test_get_document_group_order_does_not_follow_the_arrival_order():
    """Equal chunk indexes keep one order across reads of the same rows."""
    rows = [
        {
            "id": row_id,
            "doc_ref": "42",
            "source_file": "42.txt",
            "chunk_index": 0,
            DISPLAY_TEXT_FIELD: f"chunk {row_id}",
            METADATA_FIELD: {},
            PUBLISHED_FIELD: True,
        }
        for row_id in ("row-b", "row-a")
    ]

    backend = _backend()
    backend._store = FakeStore(rows=rows)
    first = backend.get_document("1", "42")
    backend._store = FakeStore(rows=list(reversed(rows)))
    second = backend.get_document("1", "42")

    assert [chunk["content"] for chunk in first["chunks"]] == [
        chunk["content"] for chunk in second["chunks"]
    ]


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


def test_get_all_chunks_keeps_a_match_behind_the_read_limit():
    """The metadata condition narrows the read, not the truncated page."""
    backend = _backend()
    store = FakeStore(
        rows=_chunk_rows("42", range(5), metadata={"tag": "other"})
        + _chunk_rows("42", [99], metadata={"tag": "keep"})
    )
    backend._store = store

    chunks = backend.get_all_chunks(
        "1",
        max_chunks=2,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "tag", "operator": "eq", "value": "keep"}],
        },
    )

    assert [chunk["chunk_id"] for chunk in chunks] == [99]
    # The condition reaches the database, so the limit applies to matches.
    assert 'metadata["tag"] == "keep"' in store.queries[-1]["filter"]


def test_get_all_chunks_compiles_the_shared_condition_contract():
    """Text and numeric conditions both narrow the database read."""
    backend = _backend()
    store = FakeStore(
        rows=_chunk_rows("42", range(6), metadata={"tag": "release-2026"})
    )
    backend._store = store

    chunks = backend.get_all_chunks(
        "1",
        max_chunks=10,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "tag", "operator": "contains", "value": "2026"},
                {"key": "chunk_index", "operator": "gte", "value": 3},
            ],
        },
    )

    assert [chunk["chunk_id"] for chunk in chunks] == [3, 4, 5]


def test_get_all_chunks_allows_a_doc_ref_condition_inside_the_knowledge_base():
    """The read path keeps the listing contract the other backends serve."""
    backend = _backend()
    store = FakeStore(rows=_chunk_rows("42", [0]) + _chunk_rows("43", [0, 1]))
    backend._store = store

    chunks = backend.get_all_chunks(
        "1",
        max_chunks=10,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "doc_ref", "operator": "eq", "value": "43"}],
        },
    )

    assert {chunk["doc_ref"] for chunk in chunks} == {"43"}
    assert 'doc_ref == "43"' in store.queries[-1]["filter"]


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


def _document_rows(
    doc_refs, *, created_at: str = "2026-01-01T00:00:00Z"
) -> List[Dict[str, Any]]:
    """One published chunk per document, so each doc_ref appears once."""
    return [
        {
            "doc_ref": doc_ref,
            "source_file": f"{doc_ref}.txt",
            "created_at": created_at,
            "chunk_index": 0,
            PUBLISHED_FIELD: True,
        }
        for doc_ref in doc_refs
    ]


def test_list_documents_page_order_does_not_follow_the_arrival_order():
    """Milvus answers rows in no promised order, so the page order is ours."""
    doc_refs = ["10", "20", "30", "40"]
    backend = _backend()

    backend._store = FakeStore(rows=_document_rows(doc_refs))
    forward = backend.list_documents("1", page=1, page_size=2)
    backend._store = FakeStore(rows=_document_rows(list(reversed(doc_refs))))
    reversed_arrival = backend.list_documents("1", page=1, page_size=2)

    assert [doc["doc_ref"] for doc in forward["documents"]] == [
        doc["doc_ref"] for doc in reversed_arrival["documents"]
    ]


def test_list_documents_pages_every_document_exactly_once():
    """Repeated paging over static data has no gap and no repeat."""
    doc_refs = ["10", "20", "30", "40"]
    backend = _backend()
    backend._store = FakeStore(rows=_document_rows(doc_refs))

    pages = [backend.list_documents("1", page=page, page_size=2) for page in (1, 2)]
    collected = [doc["doc_ref"] for page in pages for doc in page["documents"]]

    assert collected == doc_refs
    assert [page["total"] for page in pages] == [len(doc_refs)] * 2


def test_list_documents_fails_instead_of_reporting_a_truncated_total():
    """Beyond the read budget the total would be a lie, so the read fails."""
    backend = _backend()
    backend._store = FakeStore(rows=_chunk_rows("42", range(MAX_READ_LIMIT + 1)))

    with pytest.raises(StorageBackendError):
        backend.list_documents("1")


def test_list_documents_reports_the_total_at_the_read_budget():
    """Exactly at the budget the complete result is still returned."""
    backend = _backend()
    backend._store = FakeStore(rows=_chunk_rows("42", range(MAX_READ_LIMIT)))

    result = backend.list_documents("1")

    assert result["total"] == 1
    assert result["documents"][0]["chunk_count"] == MAX_READ_LIMIT

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
from knowledge_engine.storage.milvus.backend import MilvusBackend
from knowledge_engine.storage.milvus.native import (
    DENSE_VECTOR_FIELD,
    DISPLAY_TEXT_FIELD,
    METADATA_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    MilvusIndexBinding,
    index_contract_description,
)
from knowledge_engine.storage.milvus.rows import ITERATOR_BATCH_SIZE, MAX_READ_LIMIT
from knowledge_engine.storage.milvus.store import MilvusDocumentStore
from shared.models import RetrievalScope

_CLAUSE_SEPARATOR = re.compile(r"\s+(and|or)\s+")
_JSON_CLAUSE = re.compile(
    r'^metadata\["(?P<key>.+?)"\] (?P<operator>==|in) (?P<value>.+)$'
)


def _split_conjuncts(expression: str) -> list[str]:
    """Split one boolean expression on its top level ``and``."""
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
            if match and match.group(1) == "and":
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
        # The embedding factory attaches this to every model it builds, so the
        # double carries the same stable identity a real model would.
        self.embedding_space_id = f"sha256:{model_name}"
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


def _legacy_binding(*, schema_version=SCHEMA_VERSION):
    class LegacyBinding:
        pass

    LegacyBinding.schema_version = schema_version
    return LegacyBinding()


class FakeRowIterator:
    """Stands in for PyMilvus ``query_iterator`` on the reading path.

    The server continues a query iterator from the primary key of the last row
    it sent, so this double hands the matching rows back in key order, one
    ``batch_size`` at a time, and reports exhaustion once the row count reaches
    the limit the caller bounded the read with.
    """

    def __init__(
        self,
        rows,
        *,
        collection_name,
        filter_expr,
        batch_size,
        limit,
        output_fields,
        failure=None,
        failure_after_batches=0,
    ):
        self.collection_name = collection_name
        self.filter_expr = filter_expr
        self.batch_size = batch_size
        self.limit = limit
        self.output_fields = output_fields
        self.failure = failure
        self.failure_after_batches = failure_after_batches
        self.matching_rows = sorted(
            (row for row in rows if FakeStore._filter_matches(row, filter_expr)),
            key=lambda row: str(row.get("id") or ""),
        )
        self.batches = 0
        self.returned = 0
        self.closed = False

    def next(self):
        if self.failure is not None and self.batches >= self.failure_after_batches:
            raise self.failure
        assert not self.closed, "a closed iterator is never read again"
        if self.returned >= self.limit:
            return []
        allowed = min(self.batch_size, self.limit - self.returned)
        batch = self.matching_rows[self.returned : self.returned + allowed]
        if not batch:
            return []
        self.batches += 1
        self.returned += len(batch)
        return [
            {
                key: value
                for key, value in row.items()
                if key in (self.output_fields or row)
            }
            for row in batch
        ]

    def close(self):
        self.closed = True


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
        hybrid_hits=None,
        iterator_failure=None,
        iterator_failure_after_batches=0,
    ):
        self.collection_exists = collection_exists
        self.rows = list(rows or [])
        if not collection_exists or not has_contract:
            self.binding = None
        else:
            self.binding = binding or FakeBinding()
        self.calls: list[tuple] = []
        # Reading the contract describes the collection itself in the real
        # store, so one request costs one contract read per lookup.
        self.contract_reads = 0
        self.has_collection_calls: list[str] = []
        self.deleted_filters: list[str] = []
        self.queries: list[dict] = []
        self.dropped_collections: list[str] = []
        self.iterators: list["FakeRowIterator"] = []
        self.iterator_failure = iterator_failure
        self.iterator_failure_after_batches = iterator_failure_after_batches
        self.searches: list[dict] = []
        self.sparse_searches: list[dict] = []
        self.sparse_hits: list[dict] = list(sparse_hits or [])
        self.hybrid_searches: list[dict] = []
        self.hybrid_hits: list[dict] = list(hybrid_hits or [])
        self.clients_created = 0
        self.clients_closed = 0
        # The real store exposes the per-RPC deadline the drop RPCs send.
        self.rpc_timeout: float = 10.0

    @contextmanager
    def client(self):
        self.clients_created += 1
        try:
            yield self
        finally:
            self.clients_closed += 1

    def has_collection(self, client: Any, collection_name: str) -> bool:
        self.has_collection_calls.append(collection_name)
        return self.collection_exists

    def ensure_index(self, client, collection_name, *, dimension, embedding_space_id):
        self.calls.append(
            ("ensure_index", collection_name, dimension, embedding_space_id)
        )
        self.collection_exists = True
        # The real store answers with the contract the collection declares, so
        # a read that follows this write sees a readable one.
        self.binding = FakeBinding()
        return self.binding

    def confirm_contract(
        self, collection_name, binding, *, dimension, embedding_space_id
    ):
        self.calls.append(
            ("confirm_contract", collection_name, dimension, embedding_space_id)
        )

    def read_contract(self, client, collection_name):
        self.calls.append(("read_contract", collection_name))
        self.contract_reads += 1
        if not self.collection_exists:
            return None
        if self.binding is None:
            raise IndexContractIncompatibleError(
                collection_name, "the collection declares no readable index contract"
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
        # Recorded so a reintroduced write-path flush fails the test below.
        self.calls.append(("flush", collection_name))

    def delete_rows(
        self,
        client: Any,
        collection_name: str,
        filter_expr: str,
        *,
        flush: bool = True,
    ) -> int:
        self.calls.append(("delete_rows", collection_name, filter_expr))
        self.deleted_filters.append(filter_expr)
        if flush:
            self.flush(client, collection_name)
        matching = [row for row in self.rows if self._filter_matches(row, filter_expr)]
        self.rows = [
            row for row in self.rows if not self._filter_matches(row, filter_expr)
        ]
        # The real store reports the delete RPC's own count.
        return len(matching)

    def drop_collection(self, collection_name: str, **kwargs: Any) -> None:
        self.dropped_collections.append(collection_name)
        self.collection_exists = False

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

    def open_row_iterator(
        self,
        client,
        collection_name,
        filter_expr,
        *,
        batch_size,
        limit,
        output_fields=None,
    ):
        """Answer one complete read the way ``query_iterator`` does."""
        self.calls.append(("open_row_iterator", collection_name, filter_expr))
        iterator = FakeRowIterator(
            self.rows,
            collection_name=collection_name,
            filter_expr=filter_expr,
            batch_size=batch_size,
            limit=limit,
            output_fields=output_fields,
            failure=self.iterator_failure,
            failure_after_batches=self.iterator_failure_after_batches,
        )
        self.iterators.append(iterator)
        return iterator

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

    def hybrid_search(
        self,
        client,
        collection_name,
        *,
        dense_query_vector,
        sparse_query_text,
        filter_expr,
        limit,
        vector_weight,
        keyword_weight,
        output_fields=None,
    ):
        self.hybrid_searches.append(
            {
                "dense_vector": list(dense_query_vector),
                "query_text": sparse_query_text,
                "filter": filter_expr,
                "limit": limit,
                "vector_weight": vector_weight,
                "keyword_weight": keyword_weight,
                "fields": output_fields,
            }
        )
        return self.hybrid_hits[:limit]

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
        """Evaluate one boolean expression, the outermost group first."""
        expression = expression.strip()
        conjuncts = _split_conjuncts(expression)
        if len(conjuncts) > 1:
            return all(cls._expression_matches(row, part) for part in conjuncts)
        inner = _enclosing_group(expression)
        if inner is not None:
            return cls._expression_matches(row, inner)
        return cls._clause_matches(row, expression)

    @classmethod
    def _clause_matches(cls, row: Dict[str, Any], clause: str) -> bool:
        comparison = _JSON_CLAUSE.match(clause)
        if not comparison:
            raise AssertionError(
                f"the fake store cannot evaluate the clause {clause!r}"
            )
        # Every clause the compiler emits addresses the row's metadata column.
        actual = cls._metadata_value(row, comparison.group("key"))
        expected = _parse_literal(comparison.group("value"))
        if comparison.group("operator") == "==":
            return actual == expected
        return actual in expected

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


def _stored_row(
    doc_ref: str,
    chunk_index: int = 0,
    *,
    metadata: Optional[Dict[str, Any]] = None,
    display_text: Optional[str] = None,
    created_at: str = "2026-01-01T00:00:00Z",
    **overrides: Any,
) -> Dict[str, Any]:
    """One stored row, laid out the way the write path lays one out.

    The row's scope and document fields live in its metadata JSON column, so a
    reader and a compiled filter are both exercised against the shape a real
    row has.
    """
    stored_metadata = {
        "knowledge_id": "1",
        "doc_ref": doc_ref,
        "source_file": f"{doc_ref}.txt",
        "created_at": created_at,
        "chunk_index": chunk_index,
    }
    stored_metadata.update(metadata or {})
    row = {
        "id": f"{doc_ref}-{chunk_index}",
        RETRIEVAL_TEXT_FIELD: f"retrieval {chunk_index}",
        DISPLAY_TEXT_FIELD: (
            f"chunk {chunk_index}" if display_text is None else display_text
        ),
        METADATA_FIELD: stored_metadata,
    }
    row.update(overrides)
    return row


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


def test_index_writes_the_document_with_a_single_upsert():
    """One write per document: no staged copy and no second pass."""
    backend = _backend()
    store = FakeStore()
    backend._store = store
    model = FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]])

    result = backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
    )

    upserts = [call for call in store.calls if call[0] == "upsert_rows"]
    assert len(upserts) == 1
    written = upserts[0][2]
    assert len(written) == 2
    assert result["indexed_count"] == 2
    assert result["dimension"] == 2
    assert result["index_name"] == "test_kb_1"
    assert result["status"] == "success"


def test_a_written_row_keeps_its_scope_in_the_metadata_column():
    """The scope keys have one home: the row's own metadata JSON column."""
    backend = _backend()
    store = FakeStore()
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(1),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
    )

    [row] = store.rows
    assert row[METADATA_FIELD]["knowledge_id"] == "1"
    assert row[METADATA_FIELD]["doc_ref"] == "42"
    assert row[METADATA_FIELD]["chunk_index"] == 0
    assert row[METADATA_FIELD]["source_file"] == "doc.txt"
    assert row[METADATA_FIELD]["created_at"] == "2026-01-01T00:00:00Z"
    for removed in (
        "knowledge_id",
        "doc_ref",
        "source_file",
        "chunk_index",
        "created_at",
    ):
        assert removed not in row


def test_a_written_row_carries_scope_keys_a_caller_did_not_apply():
    """A node without them is still stored under the write path's identity.

    The metadata column is the only home of the scope now, so a row that
    reached storage without those keys could never be read or deleted through
    the scope it belongs to. The write path writes the values it derives the
    row id from.
    """
    backend = _backend()
    store = FakeStore()
    backend._store = store

    backend.index_with_metadata(
        nodes=[TextNode(text="chunk without metadata", metadata={})],
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
    )

    [row] = store.rows
    assert row[METADATA_FIELD]["knowledge_id"] == "1"
    assert row[METADATA_FIELD]["doc_ref"] == "42"
    assert row[METADATA_FIELD]["chunk_index"] == 0


def test_a_written_row_stores_its_scope_the_way_the_filter_compares_it():
    """The scope keys are text, exactly as the compiled conditions compare them.

    A caller that hands the write path a numeric reference must not leave a
    number in the metadata column: the scope filter compares text, so the row
    would drop out of the scope it belongs to.
    """
    backend = _backend()
    store = FakeStore()
    backend._store = store

    backend.index_with_metadata(
        nodes=[TextNode(text="chunk", metadata={})],
        chunk_metadata=_chunk_metadata(doc_ref=42),
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
    )

    [row] = store.rows
    assert row[METADATA_FIELD]["doc_ref"] == "42"
    assert backend.get_document("1", "42")["chunk_count"] == 1


def test_index_returns_as_soon_as_the_rows_are_written():
    """One write, no per-document flush and no write-side visibility wait.

    Retrieval reads at ``Bounded``, so the write returns as soon as the server
    accepted the rows and the next ~0.5s of reads may miss them; that window is
    accepted instead of paying for it on every write.
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
    # The last storage call of a successful write is the write itself: no read
    # back, no second pass.
    assert store.calls[-1][0] == "upsert_rows"


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
    )
    first_pass = row_ids()
    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
    )
    second_pass = row_ids()[len(first_pass) :]

    assert first_pass[:2] == second_pass[:2]
    assert len(set(second_pass)) == 2


def _stored_chunk_row(doc_ref: str, chunk_index: int):
    """A row as a previous index of ``doc_ref`` would have left it."""
    return _stored_row(doc_ref, chunk_index, display_text="stale tail")


def _stored_scopes(store: "FakeStore") -> set[tuple[str, str]]:
    """The (knowledge base, document) pairs a store still keeps rows for."""
    return {
        (row[METADATA_FIELD]["knowledge_id"], row[METADATA_FIELD]["doc_ref"])
        for row in store.rows
    }


def test_rewrite_drops_the_documents_previous_rows_before_writing():
    """A rewrite replaces one document instead of layering versions."""
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_chunk_row("42", 0),
            _stored_chunk_row("42", 2),
            # Whatever a previous write of the same document left has to go.
            _stored_chunk_row("42", 5),
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
    assert 'metadata["knowledge_id"] == "1"' in scope
    assert 'metadata["doc_ref"] in ["42"]' in scope
    # The document that owns the rows is dropped before the new rows land.
    deletions = [i for i, call in enumerate(store.calls) if call[0] == "delete_rows"]
    writes = [i for i, call in enumerate(store.calls) if call[0] == "upsert_rows"]
    assert deletions and deletions[0] < writes[0]
    assert all(call[0] != "flush" for call in store.calls)


def test_one_write_owns_exactly_one_client() -> None:
    """The contract confirm, the replacement delete and the write share a client.

    A write that opened one client per storage step would pay a connection for
    a consistency claim no caller needs; one lifetime covers the whole
    replacement and is still closed on every exit.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0)])
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
    )

    assert store.clients_created == 1
    assert store.clients_closed == 1
    assert [call[0] for call in store.calls] == [
        "ensure_index",
        "delete_rows",
        "upsert_rows",
    ]


def test_a_first_write_still_runs_its_replacement_delete() -> None:
    """The replacement is unconditional: one scoped delete, then one write.

    Whether the document had rows is not worth a counting query per write, so
    the delete is always issued and matches nothing on a first write.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("43", 0)])
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
    )

    assert len(store.deleted_filters) == 1
    scope = store.deleted_filters[0]
    assert 'metadata["knowledge_id"] == "1"' in scope
    assert 'metadata["doc_ref"] in ["42"]' in scope
    # The other document's rows survive the no-match delete.
    assert [row["id"] for row in store.rows if row["id"] == "43-0"]


def test_rewrite_stops_before_the_write_when_the_delete_rpc_fails():
    """A delete that failed is not a delete that found nothing.

    The previous rows are still stored, so writing the new ones would leave two
    versions of the document readable at once. The write reports that failure
    and never reaches the new rows.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0)])
    backend._store = store

    def failing_delete(client, collection_name, filter_expr, *, flush=True):
        store.calls.append(("delete_rows", collection_name, filter_expr))
        store.deleted_filters.append(filter_expr)
        raise StorageBackendError("simulated delete failure")

    store.delete_rows = failing_delete

    with pytest.raises(StorageBackendError) as failure:
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert "simulated delete failure" in str(failure.value)
    assert all(call[0] != "upsert_rows" for call in store.calls)
    assert [row["id"] for row in store.rows] == ["42-0"]


def test_rewrite_confirms_the_contract_before_it_deletes_the_old_rows():
    """An incompatible collection fails while the stored rows are untouched.

    The write path reads the contract the collection declares about itself
    before it deletes anything, so a shared collection whose schema, dimension,
    metric or embedding space disagrees with this write is refused without
    losing the document - or any other document's - rows.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0)])
    backend._store = store

    def refuse(client, collection_name, *, dimension, embedding_space_id):
        store.calls.append(
            ("ensure_index", collection_name, dimension, embedding_space_id)
        )
        raise IndexContractIncompatibleError(
            collection_name,
            "dimension mismatch",
            details={"bound": 3, "requested": dimension},
        )

    store.ensure_index = refuse

    with pytest.raises(IndexContractIncompatibleError):
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert store.deleted_filters == []
    assert all(call[0] != "upsert_rows" for call in store.calls)
    assert [row["id"] for row in store.rows] == ["42-0"]


class _ForeignSpaceClient:
    """A collection this code did not create, bound to another vector space."""

    def __init__(self, *, dimension: int, embedding_space_id: str) -> None:
        self.binding = MilvusIndexBinding(
            schema_version=SCHEMA_VERSION,
            dimension=dimension,
            embedding_space_id=embedding_space_id,
        )
        self.calls: List[str] = []

    def close(self) -> None:
        pass

    def has_collection(self, collection_name: str, **kwargs) -> bool:
        self.calls.append("has_collection")
        return True

    def describe_collection(self, collection_name: str, **kwargs) -> Dict[str, Any]:
        self.calls.append("describe_collection")
        return {
            "description": index_contract_description(self.binding),
            "fields": [
                {
                    "name": DENSE_VECTOR_FIELD,
                    "params": {"dim": self.binding.dimension},
                }
            ],
        }

    def delete(self, **kwargs) -> Dict[str, Any]:
        self.calls.append("delete")
        return {"delete_count": 0}

    def upsert(self, **kwargs) -> Dict[str, Any]:
        self.calls.append("upsert")
        return {}


def test_a_shared_collection_in_another_embedding_space_fails_before_writing():
    """A same-dimension space swap is refused with the stored rows untouched.

    The write path confirms the contract the collection declares about itself
    on the same client it later writes with, so the refusal happens before the
    old rows are deleted and before any new row is staged.
    """
    client = _ForeignSpaceClient(dimension=2, embedding_space_id="sha256:other")
    backend = _backend()
    backend._store = MilvusDocumentStore(
        uri="http://localhost:19530",
        client_factory=lambda **kwargs: client,
    )

    with pytest.raises(IndexContractIncompatibleError):
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert "delete" not in client.calls
    assert "upsert" not in client.calls


@pytest.mark.parametrize(
    "strategy,index_kwargs",
    [
        ({"mode": "per_dataset", "prefix": "test"}, {}),
        ({"mode": "fixed", "fixedName": "test_fixed_contract"}, {}),
        ({"mode": "rolling", "prefix": "test", "rollingStep": 10}, {}),
        ({"mode": "per_user", "prefix": "test"}, {"user_id": 7}),
    ],
    ids=["per_dataset", "fixed", "rolling", "per_user"],
)
def test_every_strategy_replaces_one_document_inside_its_knowledge_base(
    strategy, index_kwargs
):
    """The replacement is scoped to one document of one knowledge base.

    The shared strategies keep other knowledge bases - and the same document
    reference in them - in the same physical collection, so the delete a
    rewrite issues has to carry both the knowledge base and the document. No
    strategy drops a collection here.
    """
    backend = MilvusBackend(
        {
            "url": "http://localhost:19530/default",
            "indexStrategy": strategy,
            "ext": {},
        }
    )
    store = FakeStore(
        rows=[
            _stored_chunk_row("42", 0),
            _stored_chunk_row("43", 0),
            _stored_row("42", 0, metadata={"knowledge_id": "2"}),
        ]
    )
    backend._store = store

    backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        **index_kwargs,
    )

    [scope] = store.deleted_filters
    assert 'metadata["knowledge_id"] == "1"' in scope
    assert 'metadata["doc_ref"] in ["42"]' in scope
    replaced = [
        row
        for row in store.rows
        if row[METADATA_FIELD]["knowledge_id"] == "1"
        and row[METADATA_FIELD]["doc_ref"] == "42"
    ]
    assert len(replaced) == 2
    assert _stored_scopes(store) == {("1", "42"), ("1", "43"), ("2", "42")}


@pytest.mark.parametrize(
    "strategy,index_kwargs",
    [
        ({"mode": "fixed", "fixedName": "test_fixed_contract"}, {}),
        ({"mode": "rolling", "prefix": "test", "rollingStep": 10}, {}),
        ({"mode": "per_user", "prefix": "test"}, {"user_id": 7}),
    ],
    ids=["fixed", "rolling", "per_user"],
)
def test_a_shared_strategy_deletes_one_document_inside_one_knowledge_base(
    strategy, index_kwargs
):
    """A shared collection is never dropped and never cleared across datasets.

    The delete entry point removes one document of one knowledge base, so the
    same document reference another knowledge base stored in that shared
    collection stays readable. The fake store has no drop RPC, so a strategy
    that dropped the collection - which only ``per_dataset`` may do - would
    fail this test instead of passing quietly.
    """
    backend = MilvusBackend(
        {
            "url": "http://localhost:19530/default",
            "indexStrategy": strategy,
            "ext": {},
        }
    )
    store = FakeStore(
        rows=[
            _stored_chunk_row("42", 0),
            _stored_row("42", 0, metadata={"knowledge_id": "2"}),
            _stored_chunk_row("43", 0),
        ]
    )
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42", **index_kwargs)

    assert result["deleted_chunks"] == 1
    [scope] = store.deleted_filters
    assert 'metadata["knowledge_id"] == "1"' in scope
    assert 'metadata["doc_ref"] in ["42"]' in scope
    assert _stored_scopes(store) == {("1", "43"), ("2", "42")}


def test_index_rejects_configured_dimension_mismatch():
    backend = _backend(dim=4)
    backend._store = FakeStore()

    with pytest.raises(EmbeddingDimensionMismatchError):
        backend.index_with_metadata(
            nodes=_nodes(1),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
        )


def test_a_failed_write_is_reported_without_a_compensating_delete() -> None:
    """A failed write is raised as it is; nobody deletes for it.

    The replacement delete runs before the write, so a write that fails after
    it leaves whatever the server already accepted stored. The task reports
    that failure and the next attempt of the same document clears those rows
    with its own replacement delete; a second delete here would compete with a
    rewrite another writer may already be performing.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("43", 0)])
    backend._store = store

    def partially_written_then_failed(client, collection_name, rows):
        # The server accepted part of the batch before the RPC failed.
        store.rows.extend(dict(row) for row in rows[:1])
        raise StorageBackendError("simulated write failure")

    store.upsert_rows = partially_written_then_failed

    with pytest.raises(StorageBackendError) as failure:
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]]),
        )

    assert "simulated write failure" in str(failure.value)
    # Document 42 had no rows before this write, so its one replacement delete
    # matched nothing, and nothing deletes for the failure afterwards: the
    # half-written row stays stored until a retry replaces it.
    assert len(store.deleted_filters) == 1
    assert 'metadata["doc_ref"] in ["42"]' in store.deleted_filters[0]
    assert sorted(row[METADATA_FIELD]["doc_ref"] for row in store.rows) == [
        "42",
        "43",
    ]


def test_a_retried_write_replaces_what_the_failed_attempt_left():
    """The retry repeats the whole replacement, so convergence happens there.

    Nothing compensates a failed write, so the rows that attempt left behind
    are still stored when the next attempt starts. That attempt deletes the
    document's rows - the leftovers included - before it writes once, which is
    what makes a failed task recoverable by retrying it.
    """
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 9)])
    backend._store = store
    original_upsert = store.upsert_rows
    attempts: list[list[Dict[str, Any]]] = []

    def fail_the_first_write(client, collection_name, rows):
        attempts.append([dict(row) for row in rows])
        if len(attempts) == 1:
            # The server accepted the whole batch before the RPC failed.
            store.rows.extend(dict(row) for row in rows)
            raise StorageBackendError("simulated write failure")
        return original_upsert(client, collection_name, rows)

    store.upsert_rows = fail_the_first_write
    model = FakeEmbedModel([[1.0, 0.0], [0.0, 1.0]])

    with pytest.raises(StorageBackendError) as failure:
        backend.index_with_metadata(
            nodes=_nodes(),
            chunk_metadata=_chunk_metadata(),
            embed_model=model,
        )

    assert "simulated write failure" in str(failure.value)
    # The attempt replaced the stale row first and then left its own rows.
    assert len(store.rows) == 2
    assert "42-9" not in {row["id"] for row in store.rows}

    result = backend.index_with_metadata(
        nodes=_nodes(),
        chunk_metadata=_chunk_metadata(),
        embed_model=model,
    )

    assert result["indexed_count"] == 2
    assert {row["id"] for row in store.rows} == {row["id"] for row in attempts[1]}


def test_retrieve_returns_raw_cosine_scores_above_threshold():
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_row("42", 0, id="a", display_text="display", **{"__score__": 0.42}),
            _stored_row(
                "42", 1, id="b", display_text="display low", **{"__score__": 0.11}
            ),
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
    assert 'metadata["knowledge_id"] == "1"' in store.searches[0]["filter"]


def test_retrieve_without_a_threshold_uses_the_engine_default():
    """An absent score_threshold falls back to 0.7 on the Milvus read path."""
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_row("42", 0, id="a", display_text="display", **{"__score__": 0.81}),
            _stored_row(
                "42", 1, id="b", display_text="display low", **{"__score__": 0.11}
            ),
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"top_k": 5},
    )

    assert [record["score"] for record in result["records"]] == [0.81]


def test_retrieve_keeps_low_scoring_hits_when_zero_is_explicit():
    """An explicitly configured zero is not replaced by the engine default."""
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_row("42", 0, id="a", display_text="display", **{"__score__": 0.42}),
            _stored_row(
                "42", 1, id="b", display_text="display low", **{"__score__": 0.11}
            ),
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"top_k": 5, "score_threshold": 0.0},
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
def test_one_retrieve_reads_the_stored_contract_once(retrieval_mode: str) -> None:
    """One request reads the contract once and reuses what it read.

    The contract lives in the collection's own description, so the request that
    read it already owns the only copy: asking again inside the same request
    would add a round trip without learning anything new.
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
    assert [name for name, *_ in store.calls].count("read_contract") == 1
    # The contract read is the only existence check: the answering branch runs
    # on what it already learned.
    assert store.has_collection_calls == []
    assert store.searches or store.sparse_searches or store.hybrid_searches


def _exploding_search(*args, **kwargs):
    raise StorageBackendError("the storage call failed")


def test_a_collection_without_a_readable_contract_fails_without_creating():
    """A collection this code did not create is refused, never adopted."""
    backend = _backend()
    store = FakeStore(has_contract=False)
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

    assert store.contract_reads == 1
    assert store.clients_created == 1
    assert store.clients_closed == 1
    assert not store.searches
    assert all(call[0] != "ensure_index" for call in store.calls)


@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_a_retrieve_of_a_never_indexed_knowledge_base_creates_nothing(
    retrieval_mode,
):
    """An absent collection is an empty knowledge base, not a failure."""
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={
            "retrieval_mode": retrieval_mode,
            "top_k": 5,
            "score_threshold": 0.0,
        },
    )

    assert result == {"records": []}
    assert store.contract_reads == 1
    assert not store.searches


@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_one_retrieve_owns_exactly_one_client(retrieval_mode):
    """One request costs one client lifetime, not one per storage lookup.

    The client is still created per request and closed in ``finally``, so
    concurrent requests keep owning independent connections; the point is that
    a single request reads the collection's own contract on the client it holds
    instead of opening another one for it.
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
    store.hybrid_search = _exploding_search
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
    return _stored_row(
        doc_ref,
        id=row_id,
        display_text=display,
        metadata={"source_file": f"document-{doc_ref}.txt"},
        **{"__score__": score},
    )


def _hybrid_store():
    """One candidate only the dense branch prefers and one only BM25 prefers."""
    return FakeStore(
        hybrid_hits=[
            _hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75),
            _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=0.5),
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
            _stored_row("42", id="a", display_text="展示正文", **{"__score__": 3.0})
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
    assert 'metadata["knowledge_id"] == "1"' in store.sparse_searches[0]["filter"]
    assert [record["content"] for record in result["records"]] == ["展示正文"]
    # The reported score is the raw BM25 score the server returned.
    assert result["records"][0]["score"] == pytest.approx(3.0)


def test_keyword_retrieve_applies_the_threshold_to_the_native_bm25_score():
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
    assert result["records"][0]["score"] == pytest.approx(3.0)


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
            "conditions": [{"key": "file_name", "operator": "eq", "value": "tech"}],
        },
    )

    expression = store.sparse_searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["doc_ref"] in ["7", "8"]' in expression
    assert 'metadata["file_name"] == "tech"' in expression


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


def test_keyword_retrieve_rejects_a_contract_from_an_older_schema():
    """An index an older schema wrote never answers keyword queries empty."""
    backend = _backend()
    backend._store = FakeStore(
        binding=_legacy_binding(schema_version=SCHEMA_VERSION - 1)
    )

    with pytest.raises(IndexContractIncompatibleError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=ExplodingEmbedModel(),
            retrieval_setting={"retrieval_mode": "keyword", "score_threshold": 0.0},
        )


def test_hybrid_retrieve_runs_one_native_search_with_the_default_weights():
    """Hybrid is Milvus's own: one call carries both branches and the weights."""
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

    [request] = store.hybrid_searches
    assert request["limit"] == 5
    assert request["query_text"] == "深度学习模型训练 zebra_pipeline_99"
    assert request["dense_vector"] == [1.0, 0.0]
    assert (request["vector_weight"], request["keyword_weight"]) == (0.7, 0.3)
    assert 'metadata["knowledge_id"] == "1"' in request["filter"]
    # The branches are the server's business now, so neither is run here.
    assert store.searches == []
    assert store.sparse_searches == []
    assert [record["content"] for record in result["records"]] == [
        "dense 偏好",
        "keyword 偏好",
    ]
    assert result["records"][0]["title"] == "document-42.txt"
    assert result["records"][0]["metadata"]["doc_ref"] == "42"


def test_hybrid_retrieve_reports_the_score_the_ranker_returned():
    """The fused score is the server's: it is reported, never recomputed."""
    backend = _backend()
    store = FakeStore(
        hybrid_hits=[
            _hybrid_hit("shared-row", "42", display="两路都命中", score=0.83),
            _hybrid_hit("weak-row", "43", display="两路都偏弱", score=0.12),
        ]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "score_threshold": 0.2,
        },
    )

    assert [record["content"] for record in result["records"]] == ["两路都命中"]
    assert result["records"][0]["score"] == pytest.approx(0.83)


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        ({"vector_weight": 0.9, "keyword_weight": 0.1}, (0.9, 0.1)),
        ({"vector_weight": 3.0, "keyword_weight": 1.0}, (0.75, 0.25)),
        ({"keyword_weight": 0.3}, (0.7, 0.3)),
        ({"vector_weight": 0.5}, (0.5, 0.5)),
        ({}, (0.7, 0.3)),
    ],
)
def test_hybrid_retrieve_passes_the_resolved_weights_to_the_ranker(
    configured, expected
):
    """The configured shares are what the native ranker receives."""
    backend = _backend()
    store = _hybrid_store()
    backend._store = store

    backend.retrieve(
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

    [request] = store.hybrid_searches
    assert (request["vector_weight"], request["keyword_weight"]) == expected


def test_hybrid_threshold_cuts_the_native_score():
    """The threshold compares exactly the score the caller receives."""
    backend = _backend()
    store = FakeStore(
        hybrid_hits=[
            _hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75),
            _hybrid_hit("keyword-row", "43", display="keyword 偏好", score=0.5),
        ]
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
        retrieval_setting={**settings, "score_threshold": 0.4},
    )
    between = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={**settings, "score_threshold": 0.6},
    )
    below_both = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={**settings, "score_threshold": 0.8},
    )

    assert [record["content"] for record in above_both["records"]] == [
        "dense 偏好",
        "keyword 偏好",
    ]
    assert [record["content"] for record in between["records"]] == ["dense 偏好"]
    assert between["records"][0]["score"] == pytest.approx(0.75)
    assert below_both == {"records": []}


def test_hybrid_threshold_keeps_a_score_equal_to_the_cut():
    """The boundary is inclusive, exactly like the other retrieval modes."""
    backend = _backend()
    store = FakeStore(
        hybrid_hits=[_hybrid_hit("dense-row", "42", display="dense 偏好", score=0.75)]
    )
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": "hybrid",
            "top_k": 5,
            "vector_weight": 0.7,
            "keyword_weight": 0.3,
            "score_threshold": 0.75,
        },
    )

    assert [record["content"] for record in result["records"]] == ["dense 偏好"]
    assert result["records"][0]["score"] == pytest.approx(0.75)


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

    assert store.hybrid_searches == []
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

    assert store.hybrid_searches == []
    assert store.searches == []
    assert store.sparse_searches, "the keyword branch must run"
    # The keyword endpoint reports the keyword mode's raw BM25 score.
    assert result["records"][0]["content"] == "keyword 偏好"
    assert result["records"][0]["score"] == pytest.approx(3.0)


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
    assert backend._store.hybrid_searches == []


def test_hybrid_retrieve_keeps_scope_and_metadata_filters():
    """The one hybrid request carries the whole scope and the predicate."""
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
            "conditions": [{"key": "file_name", "operator": "eq", "value": "tech"}],
        },
    )

    expression = store.hybrid_searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["doc_ref"] in ["7", "8"]' in expression
    assert 'metadata["file_name"] == "tech"' in expression


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

    assert 'metadata["doc_ref"] in ["7", "8"]' in store.searches[0]["filter"]


def test_retrieve_rejects_doc_ref_metadata_condition():
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

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

    # Document scope belongs to RetrievalScope, so nothing was queried.
    assert store.searches == []


def test_retrieve_compiles_a_flat_and_of_the_supported_operators():
    """Equality and membership compile against the row's metadata column."""
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
                {"key": "source_file", "operator": "eq", "value": "a.txt"},
                {"key": "file_name", "operator": "in", "value": ["a", "b"]},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert (
        '(metadata["source_file"] == "a.txt" and '
        'metadata["file_name"] in ["a", "b"])' in expression
    )


def test_retrieve_keeps_an_implicit_and_condition_inside_the_scope():
    """A condition without an operator is a flat and with one member."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0},
        metadata_condition={
            "conditions": [{"key": "page_number", "operator": "eq", "value": 3}],
        },
    )

    expression = store.searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["page_number"] == 3' in expression


def test_retrieve_keeps_the_double_equals_input_compatibility():
    """``==`` is the documented alias of ``eq``, not a second operator."""
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
            "conditions": [{"key": "filename", "operator": "==", "value": "a.txt"}],
        },
    )

    assert 'metadata["filename"] == "a.txt"' in store.searches[0]["filter"]


def test_retrieve_encodes_a_number_and_a_boolean_by_their_type():
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
                {"key": "chunk_index", "operator": "eq", "value": 3},
                {"key": "chunk_index", "operator": "in", "value": [0, 1]},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert 'metadata["chunk_index"] == 3' in expression
    assert 'metadata["chunk_index"] in [0, 1]' in expression


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
            "conditions": [{"key": "filename", "operator": "eq", "value": 'a"b\\c'}],
        },
    )

    assert 'metadata["filename"] == "a\\"b\\\\c"' in store.searches[0]["filter"]


@pytest.mark.parametrize(
    "operator",
    ["ne", "nin", "gt", "gte", "lt", "lte", "contains", "text_match", "!="],
)
def test_retrieve_rejects_every_unsupported_operator(operator):
    """An operator outside the contract fails instead of matching nothing."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError, match="not supported"):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={
                "operator": "and",
                "conditions": [
                    {"key": "source_file", "operator": operator, "value": "a.txt"}
                ],
            },
        )

    assert store.searches == []


def test_retrieve_rejects_the_or_combination():
    """Only a flat and is supported, so an or fails before it is compiled."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError, match="'or' is not supported"):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={
                "operator": "or",
                "conditions": [
                    {"key": "source_file", "operator": "eq", "value": "a.txt"}
                ],
            },
        )

    assert store.searches == []


def test_retrieve_rejects_an_or_that_names_no_conditions():
    """An or without conditions states a combination, not "no constraint"."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError, match="'conditions'"):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={"operator": "or"},
        )

    assert store.searches == []


def test_retrieve_compiles_a_key_no_row_carries():
    """A key outside the ingestion vocabulary narrows the same query.

    Milvus answers an unknown JSON path with an empty result rather than an
    error, so the adapter needs no per-backend key list: the condition compiles
    into the same metadata path and matches nothing.
    """
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
            "conditions": [{"key": "published", "operator": "eq", "value": True}],
        },
    )

    assert 'metadata["published"] == true' in store.searches[0]["filter"]


def test_retrieve_ands_a_condition_that_names_the_knowledge_base():
    """A condition on the scope key can only narrow the scope it is anded to."""
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
            "conditions": [{"key": "knowledge_id", "operator": "eq", "value": "2"}],
        },
    )

    expression = store.searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["knowledge_id"] == "2"' in expression
    assert " and " in expression


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
                        "operator": "and",
                        "conditions": [
                            {"key": "file_name", "operator": "eq", "value": "a"}
                        ],
                    }
                ],
            },
        )


def test_retrieve_rejects_a_condition_object_without_a_conditions_list():
    """A bare metadata mapping must not be read as "no condition".

    Reading it that way would answer a request that meant to narrow with the
    whole knowledge base.
    """
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError, match="conditions"):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={"doc_ref": "doc_123"},
        )

    assert store.searches == []


def test_retrieve_rejects_a_list_value_outside_in():
    """A list value is only meaningful for in; anything else fails."""
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
                    {"key": "file_name", "operator": "eq", "value": ["a", "b"]}
                ],
            },
        )


def test_retrieve_skips_a_condition_without_a_constraint():
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
            "conditions": [
                {"key": "filename", "operator": "eq", "value": None},
                {"key": "file_name", "operator": "==", "value": None},
                {"key": "file_type", "operator": "in"},
            ],
        },
    )

    expression = store.searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    for key in ("filename", "file_name", "file_type"):
        assert f'metadata["{key}"]' not in expression


@pytest.mark.parametrize(
    "condition",
    [
        {"key": "doc_ref", "operator": "eq", "value": None},
        {"key": "filename", "operator": "gte", "value": None},
        {"key": "filename", "operator": "contains", "value": None},
        {"key": "", "operator": "eq", "value": None},
        {"key": "", "operator": "eq", "value": "a.txt"},
        {"operator": "eq", "value": "a.txt"},
        {"key": 5, "operator": "eq", "value": None},
    ],
)
def test_retrieve_validates_a_condition_before_its_empty_value(condition):
    """An unusable key or operator never hides behind an empty value."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError):
        backend.retrieve(
            knowledge_id="1",
            query="q",
            embed_model=FakeEmbedModel([[1.0, 0.0]]),
            retrieval_setting={"score_threshold": 0.0},
            metadata_condition={"operator": "and", "conditions": [condition]},
        )

    assert store.searches == []


def test_get_all_chunks_validates_a_condition_before_its_empty_value():
    """The reading path validates the same way, with doc_ref as its own key."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError):
        backend.get_all_chunks(
            "1",
            max_chunks=10,
            metadata_condition={
                "operator": "and",
                "conditions": [{"key": "category", "operator": "contains"}],
            },
        )

    assert store.queries == []


def test_get_all_chunks_rejects_a_condition_object_without_a_conditions_list():
    """The reading path refuses a bare mapping instead of listing everything."""
    backend = _backend()
    store = FakeStore(rows=[])
    backend._store = store

    with pytest.raises(ValueError, match="conditions"):
        backend.get_all_chunks(
            "1",
            max_chunks=10,
            metadata_condition={"doc_ref": "doc_123"},
        )

    assert store.queries == []


def test_retrieve_answers_empty_for_a_scope_that_names_no_document():
    """An empty document scope matches nothing; it never widens to the KB."""
    backend = _backend()
    store = FakeStore(rows=[_stored_row("42")])
    backend._store = store
    empty_scope = RetrievalScope.model_construct(document_ids=[])

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=ExplodingEmbedModel(),
        retrieval_setting={"score_threshold": 0.0},
        scope=empty_scope,
    )

    assert result == {"records": []}
    assert store.searches == []
    assert store.sparse_searches == []
    assert store.hybrid_searches == []
    assert store.queries == []


def test_retrieve_answers_a_scope_without_document_ids_from_the_knowledge_base():
    """A scope that names no document ID restricts nothing, as ES and Qdrant do."""
    backend = _backend()
    store = FakeStore(rows=[_stored_row("42")])
    backend._store = store

    backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={"score_threshold": 0.0, "retrieval_mode": "vector"},
        scope=RetrievalScope(),
    )

    assert store.searches, "the knowledge base stays readable"
    expression = store.searches[0]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert "doc_ref" not in expression


@pytest.mark.parametrize(
    ("strategy", "kwargs"),
    [
        ({"mode": "fixed", "fixedName": "shared_index"}, {}),
        ({"mode": "rolling", "rollingStep": 10}, {}),
        ({"mode": "per_dataset"}, {}),
        ({"mode": "per_user"}, {"user_id": 7}),
    ],
)
@pytest.mark.parametrize("retrieval_mode", ["vector", "keyword", "hybrid"])
def test_every_strategy_keeps_retrieval_inside_its_knowledge_base(
    strategy, kwargs, retrieval_mode
):
    """Every collection strategy scopes every mode by the knowledge base."""
    backend = MilvusBackend(
        {
            "url": "http://localhost:19530/default",
            "indexStrategy": {"prefix": "test", **strategy},
            "ext": {},
        }
    )
    store = FakeStore(rows=[_stored_row("42")], hybrid_hits=[_stored_row("42")])
    store.sparse_hits = [_stored_row("42")]
    backend._store = store

    result = backend.retrieve(
        knowledge_id="1",
        query="q",
        embed_model=FakeEmbedModel([[1.0, 0.0]]),
        retrieval_setting={
            "retrieval_mode": retrieval_mode,
            "top_k": 5,
            "score_threshold": 0.0,
        },
        scope=RetrievalScope(document_ids=[9]),
        **kwargs,
    )

    request = (
        store.searches[0]
        if retrieval_mode == "vector"
        else (
            store.sparse_searches[0]
            if retrieval_mode == "keyword"
            else store.hybrid_searches[0]
        )
    )
    expression = request["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["doc_ref"] in ["9"]' in expression
    assert result["records"], "the scoped request must still answer its own rows"


def test_delete_missing_document_is_idempotent_and_creates_nothing():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42")

    assert result["deleted_chunks"] == 0
    assert result["status"] == "deleted"
    assert all(call[0] != "ensure_index" for call in store.calls)


def test_delete_document_removes_rows_and_reports_the_delete_rpcs_count() -> None:
    """One delete answers the entry point: no counting query, no read-back."""
    backend = _backend()
    store = FakeStore(
        rows=[_stored_row("42", 0), _stored_row("42", 1), _stored_row("43", 0)]
    )
    backend._store = store
    backend.delete_parent_nodes = lambda *args, **kwargs: 0

    result = backend.delete_document("1", "42")

    assert result["deleted_chunks"] == 2
    assert [row["id"] for row in store.rows] == ["43-0"]
    assert len(store.deleted_filters) == 1
    assert 'metadata["doc_ref"] in ["42"]' in store.deleted_filters[0]
    # The contract read is the only extra lookup, and the delete entry point
    # flushes so the removal is durable when it is reported.
    assert [call[0] for call in store.calls] == [
        "read_contract",
        "delete_rows",
        "flush",
    ]
    assert store.has_collection_calls == []
    assert store.queries == []


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


def test_delete_knowledge_clears_only_the_knowledge_base_scope() -> None:
    backend = _backend()
    store = FakeStore(rows=[_stored_chunk_row("42", 0), _stored_chunk_row("42", 1)])
    backend._store = store

    result = backend.delete_knowledge("1")

    assert result["deleted_chunks"] == 2
    assert result["status"] == "deleted"
    assert store.rows == []
    # The index scope lives in its metadata JSON column and the sidecar keeps
    # its own top-level field, so each collection is deleted in its own shape -
    # once each, with no counting query in front of either delete.
    assert store.deleted_filters == [
        'metadata["knowledge_id"] == "1"',
        'knowledge_id == "1"',
    ]
    assert store.queries == []


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


def test_drop_reads_the_contract_once_and_drops_both_collections() -> None:
    """The drop chain is one contract read, one sidecar lookup and two drops."""
    backend = _backend()
    store = FakeStore()
    backend._store = store

    result = backend.drop_knowledge_index("1")

    assert result["status"] == "dropped"
    assert result["dropped_parent_collection"] is True
    # The contract read answers both the existence and the ownership of the
    # index collection; the sidecar declares no contract, so it is only looked
    # up by name.
    assert [name for name, *_ in store.calls] == ["read_contract"]
    assert store.has_collection_calls == ["test_kb_1__parents"]
    assert store.dropped_collections == ["test_kb_1", "test_kb_1__parents"]


def test_get_document_missing_raises_without_creating():
    backend = _backend()
    store = FakeStore(collection_exists=False)
    backend._store = store

    with pytest.raises(ValueError):
        backend.get_document("1", "42")

    assert store.iterators == [], "a missing collection opens no iterator"
    assert "ensure_index" not in [call[0] for call in store.calls]


def _chunk_rows(
    doc_ref: str,
    chunk_indexes,
    *,
    metadata: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    return [_stored_row(doc_ref, index, metadata=metadata) for index in chunk_indexes]


def test_get_document_reads_every_chunk_across_batches():
    """A document longer than one iterator batch is still complete."""
    backend = _backend()
    store = FakeStore(rows=list(reversed(_chunk_rows("42", range(2500)))))
    backend._store = store

    document = backend.get_document("1", "42")

    [iterator] = store.iterators
    assert iterator.batches == 3, "the read crossed more than one batch"
    assert document["chunk_count"] == 2500
    assert [chunk["chunk_index"] for chunk in document["chunks"]] == list(range(2500))


def test_a_complete_read_uses_one_bounded_iterator_instead_of_offset_pages():
    """The reader walks the server's own cursor, never an unordered offset."""
    backend = _backend()
    store = FakeStore(rows=_chunk_rows("42", range(5)))
    backend._store = store

    backend.get_document("1", "42")

    assert store.queries == [], "a complete read no longer pages with offsets"
    [iterator] = store.iterators
    assert iterator.batch_size == ITERATOR_BATCH_SIZE
    assert (
        iterator.limit == MAX_READ_LIMIT + 1
    ), "the iterator is bounded one row past the budget"
    assert iterator.closed is True


def test_the_iterator_narrows_the_read_to_the_requested_scope():
    """Both the knowledge base and the document scope reach the database read."""
    backend = _backend()
    store = FakeStore(rows=_chunk_rows("42", [0]) + _chunk_rows("43", [0, 1]))
    backend._store = store

    listing = backend.list_documents("1")

    [iterator] = store.iterators
    assert iterator.filter_expr == 'metadata["knowledge_id"] == "1"'
    assert iterator.output_fields == [METADATA_FIELD]
    assert [document["doc_ref"] for document in listing["documents"]] == ["42", "43"]

    backend.get_document("1", "42")

    document_iterator = store.iterators[-1]
    assert 'metadata["knowledge_id"] == "1"' in document_iterator.filter_expr
    assert 'metadata["doc_ref"] in ["42"]' in document_iterator.filter_expr


def test_a_read_over_the_budget_stops_early_and_closes_the_iterator():
    """The bounded read ends as soon as the budget is passed, and releases."""
    backend = _backend()
    store = FakeStore(rows=_chunk_rows("42", range(MAX_READ_LIMIT + 1)))
    backend._store = store

    with pytest.raises(StorageBackendError):
        backend.get_document("1", "42")

    [iterator] = store.iterators
    assert iterator.closed is True
    assert iterator.returned == MAX_READ_LIMIT + 1, "the read stopped at the budget"


def test_a_failing_iterator_batch_is_reported_and_closed():
    """A batch that fails mid-read still releases the iterator."""
    backend = _backend()
    failure = RuntimeError("milvus rpc failed")
    store = FakeStore(
        rows=_chunk_rows("42", range(2500)),
        iterator_failure=failure,
        iterator_failure_after_batches=1,
    )
    backend._store = store

    with pytest.raises(RuntimeError):
        backend.get_document("1", "42")

    [iterator] = store.iterators
    assert iterator.batches == 1, "the failure happened inside the read"
    assert iterator.closed is True


def test_get_document_fails_when_the_document_exceeds_the_read_budget():
    """A truncated document must not be reported as the complete one."""
    backend = _backend()
    backend._store = FakeStore(rows=_chunk_rows("42", range(MAX_READ_LIMIT + 1)))

    with pytest.raises(StorageBackendError):
        backend.get_document("1", "42")


def test_get_document_group_order_does_not_follow_the_arrival_order():
    """Equal chunk indexes keep one order across reads of the same rows."""
    rows = [
        _stored_row("42", id=row_id, display_text=f"chunk {row_id}")
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
    backend._store.rows = [{"doc_ref": "42", DISPLAY_TEXT_FIELD: "x"}]

    with pytest.raises(IndexContractIncompatibleError):
        backend.get_all_chunks("1")


def test_get_all_chunks_returns_the_stored_rows_in_stable_order():
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_row("42", 1, display_text="second"),
            _stored_row("42", 0, display_text="first"),
        ]
    )
    backend._store = store

    chunks = backend.get_all_chunks("1", max_chunks=10)

    assert [chunk["content"] for chunk in chunks] == ["first", "second"]


def test_get_all_chunks_keeps_a_match_behind_the_read_limit():
    """The metadata condition narrows the read, not the truncated page."""
    backend = _backend()
    store = FakeStore(
        rows=_chunk_rows("42", range(5), metadata={"node_role": "chunk"})
        + _chunk_rows("42", [99], metadata={"node_role": "qa_pair"})
    )
    backend._store = store

    chunks = backend.get_all_chunks(
        "1",
        max_chunks=2,
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "node_role", "operator": "eq", "value": "qa_pair"}],
        },
    )

    assert [chunk["chunk_id"] for chunk in chunks] == [99]
    # The condition reaches the database, so the limit applies to matches.
    assert 'metadata["node_role"] == "qa_pair"' in store.queries[-1]["filter"]


def test_get_all_chunks_compiles_the_supported_condition_contract():
    """The read path narrows with the same condition contract as retrieval."""
    backend = _backend()
    store = FakeStore(
        rows=_chunk_rows("42", range(6), metadata={"chunk_strategy": "parent_child"})
    )
    backend._store = store

    chunks = backend.get_all_chunks(
        "1",
        max_chunks=10,
        metadata_condition={
            "operator": "and",
            "conditions": [
                {
                    "key": "chunk_strategy",
                    "operator": "eq",
                    "value": "parent_child",
                },
                {"key": "chunk_index", "operator": "in", "value": [3, 4, 5]},
            ],
        },
    )

    assert [chunk["chunk_id"] for chunk in chunks] == [3, 4, 5]


def test_get_all_chunks_allows_a_doc_ref_condition_inside_the_knowledge_base():
    """The read path keeps the listing contract the other backends serve.

    Retrieval refuses a ``doc_ref`` condition because there the document scope
    is an explicit input a condition must not impersonate. The reading path has
    no such input, so the condition narrows the same query - still anded to the
    knowledge base the adapter forces, so it cannot leave it.
    """
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
    expression = store.queries[-1]["filter"]
    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["doc_ref"] == "43"' in expression


def test_list_documents_aggregates_stored_rows():
    backend = _backend()
    store = FakeStore(
        rows=[
            _stored_row(
                "42",
                0,
                created_at="2026-01-02T00:00:00Z",
                metadata={"source_file": "a.txt"},
            ),
            _stored_row(
                "42",
                1,
                created_at="2026-01-02T00:00:00Z",
                metadata={"source_file": "a.txt"},
            ),
            _stored_row(
                "41",
                0,
                created_at="2026-01-01T00:00:00Z",
                metadata={"source_file": "b.txt"},
            ),
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
    """One stored chunk per document, so each doc_ref appears once."""
    return [_stored_row(doc_ref, created_at=created_at) for doc_ref in doc_refs]


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


def test_list_documents_rejects_a_page_below_the_first_one():
    """Pagination is one-based, so a lower page fails before any read."""
    backend = _backend()
    store = FakeStore(rows=_document_rows(["10", "20"]))
    backend._store = store

    for page in (0, -1):
        with pytest.raises(ValueError):
            backend.list_documents("1", page=page)

    assert store.calls == []


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

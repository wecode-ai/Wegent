# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native Milvus contract and schema layer (no server)."""

import json

import pytest
from pymilvus import DataType, FunctionType

from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    BM25_FUNCTION_NAME,
    DENSE_VECTOR_FIELD,
    METADATA_FIELD,
    METRIC_TYPE,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    build_collection_schema,
    build_scope_filter,
    contract_token_field,
    node_row_id,
    strip_connection_credentials,
)


def _binding(**overrides):
    payload = {
        "collection_name": "wegent_kb_1",
        "connection": "http://milvus.test:19530",
        "database": "default",
        "schema_version": SCHEMA_VERSION,
        "embedding_space": "sha256:abc",
        "dimension": 1536,
        "metric_type": METRIC_TYPE,
        "index_type": "AUTOINDEX",
        "analyzer": ANALYZER_TYPE,
    }
    payload.update(overrides)
    return MilvusIndexBinding(**payload)


def test_binding_row_round_trip():
    """A binding survives serialization into the registry collection."""
    binding = _binding()

    assert MilvusIndexBinding.from_row(binding.to_row()) == binding


def test_binding_row_without_contract_payload_is_rejected():
    """A registry row without its contract payload is an explicit failure."""
    with pytest.raises(IndexContractIncompatibleError):
        MilvusIndexBinding.from_row({"collection_name": "wegent_kb_1"})


@pytest.mark.parametrize(
    "overrides",
    [
        {"dimension": 4096},
        {"embedding_space": "sha256:other"},
        {"metric_type": "L2"},
        {"schema_version": SCHEMA_VERSION - 1},
        {"analyzer": ""},
        {"analyzer": "standard"},
        {"database": "other_db"},
        {"connection": "http://other:19530"},
    ],
)
def test_binding_rejects_incompatible_contracts(overrides):
    """Any contract difference is an explicit, non-retryable failure."""
    bound = _binding()
    requested = _binding(**overrides)

    with pytest.raises(IndexContractIncompatibleError):
        bound.assert_compatible(requested)


def test_binding_accepts_identical_contract():
    _binding().assert_compatible(_binding())


def test_node_row_id_is_stable_per_document_and_chunk():
    """The same document and chunk keep one key, so a write replaces its row."""
    base = {"knowledge_id": "1", "doc_ref": "42", "chunk_index": 0}

    assert node_row_id(**base) == node_row_id(**base)
    assert node_row_id(**base) != node_row_id(**{**base, "chunk_index": 1})
    assert node_row_id(**base) != node_row_id(**{**base, "doc_ref": "43"})
    assert node_row_id(**base) != node_row_id(**{**base, "knowledge_id": "2"})


def test_scope_filter_scopes_the_knowledge_base_and_documents():
    expression = build_scope_filter(knowledge_id="1", doc_refs=[42, "doc_b"])

    assert 'knowledge_id == "1"' in expression
    assert 'doc_ref in ["42", "doc_b"]' in expression
    assert "published" not in expression


def test_scope_filter_escapes_quotes_and_backslashes():
    expression = build_scope_filter(knowledge_id='a"b\\c')

    assert 'knowledge_id == "a\\"b\\\\c"' in expression


def test_scope_filter_rejects_empty_document_scope():
    """An empty intersection must never widen into an unfiltered query."""
    with pytest.raises(ValueError):
        build_scope_filter(knowledge_id="1", doc_refs=[])


def test_collection_schema_declares_required_fields_and_dimension():
    schema = build_collection_schema(4096, "sha256:space")
    fields = {field.name: field for field in schema.fields}

    assert fields[DENSE_VECTOR_FIELD].params["dim"] == 4096
    for name in (
        "knowledge_id",
        "doc_ref",
        "chunk_index",
        "retrieval_text",
        "display_text",
    ):
        assert name in fields
    for removed in ("generation", "attempt_id", "published", "node_kind"):
        assert removed not in fields
    assert contract_token_field("sha256:space") in fields
    assert fields["id"].is_primary


def test_collection_schema_declares_server_side_bm25_over_analyzed_retrieval_text():
    """Keyword retrieval is a physical capability of the collection schema."""
    schema = build_collection_schema(1536, "sha256:space")
    fields = {field.name: field for field in schema.fields}

    text_field = fields[RETRIEVAL_TEXT_FIELD]
    assert str(text_field.params.get("enable_analyzer")).lower() == "true"
    assert json.loads(text_field.params.get("analyzer_params")) == {
        "type": ANALYZER_TYPE
    }
    assert fields[SPARSE_VECTOR_FIELD].dtype == DataType.SPARSE_FLOAT_VECTOR
    assert fields[METADATA_FIELD].dtype == DataType.JSON

    [function] = schema.functions
    assert function.name == BM25_FUNCTION_NAME
    assert function.type == FunctionType.BM25
    assert function.input_field_names == [RETRIEVAL_TEXT_FIELD]
    assert function.output_field_names == [SPARSE_VECTOR_FIELD]


def test_collection_schema_separates_embedding_spaces():
    """Milvus only rejects a duplicate create when the schema differs.

    The contract token encodes the embedding space, so two same-dimension
    writers with different spaces produce different schemas and the server
    refuses the second creation instead of returning an idempotent success.
    """
    first = {field.name for field in build_collection_schema(1536, "sha256:a").fields}
    second = {field.name for field in build_collection_schema(1536, "sha256:b").fields}
    same = {field.name for field in build_collection_schema(1536, "sha256:a").fields}

    assert first != second
    assert first == same


def test_strip_connection_credentials_removes_userinfo():
    assert (
        strip_connection_credentials("https://user:pass@milvus.test:19530/db")
        == "https://milvus.test:19530/db"
    )
    assert strip_connection_credentials("/tmp/milvus.db") == "/tmp/milvus.db"

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native Milvus contract and schema layer (no server).

The index contract lives in the description of the collection it describes, so
these tests cover the round trip through that description and the schema the
contract is written with.
"""

import json

import pytest
from pymilvus import DataType, FunctionType

from knowledge_engine.storage.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus.native import (
    ANALYZER_TYPE,
    BM25_FUNCTION_NAME,
    CONTRACT_DESCRIPTION_PREFIX,
    DENSE_VECTOR_FIELD,
    METADATA_FIELD,
    METRIC_TYPE,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    build_collection_schema,
    build_scope_filter,
    index_contract_description,
    index_contract_from_description,
    node_row_id,
    read_collection_description,
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


def test_binding_survives_the_collection_description_round_trip():
    """The contract is stored in, and read back from, its own collection."""
    binding = _binding()

    description = index_contract_description(binding)

    assert description.startswith(CONTRACT_DESCRIPTION_PREFIX)
    assert index_contract_from_description(description) == binding


@pytest.mark.parametrize(
    "description",
    [
        "",
        "wegent knowledge index schema v4",
        CONTRACT_DESCRIPTION_PREFIX + "not json",
        CONTRACT_DESCRIPTION_PREFIX + '["not a contract"]',
        CONTRACT_DESCRIPTION_PREFIX + '{"collection_name": "wegent_kb_1"}',
    ],
)
def test_a_description_without_a_readable_contract_is_reported_as_absent(
    description,
):
    """Every unreadable description reads as "no contract", never as a guess."""
    assert index_contract_from_description(description) is None


def test_describe_collection_reads_the_contract_and_the_dimension_once():
    """Both facts a contract check needs come from the one describe call."""
    binding = _binding()
    calls: list[dict] = []

    class _Client:
        def describe_collection(self, collection_name: str, **kwargs) -> dict:
            calls.append(kwargs)
            return {
                "description": index_contract_description(binding),
                "fields": [
                    {"name": DENSE_VECTOR_FIELD, "params": {"dim": binding.dimension}}
                ],
            }

    described = read_collection_description(_Client(), "wegent_kb_1", timeout=5.0)

    assert described.binding == binding
    assert described.dimension == binding.dimension
    assert len(calls) == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"collection_name": "wegent_kb_other"},
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

    assert 'metadata["knowledge_id"] == "1"' in expression
    assert 'metadata["doc_ref"] in ["42", "doc_b"]' in expression


def test_scope_filter_escapes_quotes_and_backslashes():
    expression = build_scope_filter(knowledge_id='a"b\\c')

    assert 'metadata["knowledge_id"] == "a\\"b\\\\c"' in expression


def test_scope_filter_rejects_empty_document_scope():
    """An empty intersection must never widen into an unfiltered query."""
    with pytest.raises(ValueError):
        build_scope_filter(knowledge_id="1", doc_refs=[])


def test_collection_schema_declares_required_fields_and_dimension():
    binding = _binding(dimension=4096, embedding_space="sha256:space")
    schema = build_collection_schema(binding)
    fields = {field.name: field for field in schema.fields}

    assert fields[DENSE_VECTOR_FIELD].params["dim"] == 4096
    # The six fields retrieval needs: identity, both texts, the metadata column
    # every condition is compiled against and the two vectors.
    assert set(fields) == {
        "id",
        "retrieval_text",
        "display_text",
        "metadata",
        DENSE_VECTOR_FIELD,
        SPARSE_VECTOR_FIELD,
    }
    # The contract needs no column of its own: the collection carries it.
    assert schema.description == index_contract_description(binding)
    assert [name for name in fields if name.startswith("contract")] == []
    assert fields["id"].is_primary


def test_collection_schema_declares_server_side_bm25_over_analyzed_retrieval_text():
    """Keyword retrieval is a physical capability of the collection schema."""
    schema = build_collection_schema(_binding(dimension=1536))
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


def test_two_same_dimension_embedding_spaces_declare_different_contracts():
    """The contract, not the schema, separates two embedding spaces.

    Two same-dimension writers produce identical physical schemas, so the server
    cannot tell them apart; the contract each one writes into the collection
    description is what the read-back after creation compares (``store``
    owns that comparison).
    """
    first = build_collection_schema(
        _binding(dimension=1536, embedding_space="sha256:a")
    )
    second = build_collection_schema(
        _binding(dimension=1536, embedding_space="sha256:b")
    )

    assert first.description != second.description
    assert index_contract_from_description(first.description).embedding_space == (
        "sha256:a"
    )


def test_strip_connection_credentials_removes_userinfo():
    assert (
        strip_connection_credentials("https://user:pass@milvus.test:19530/db")
        == "https://milvus.test:19530/db"
    )
    assert strip_connection_credentials("/tmp/milvus.db") == "/tmp/milvus.db"

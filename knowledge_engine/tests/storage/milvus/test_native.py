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

from knowledge_engine.storage.milvus.errors import IndexContractIncompatibleError
from knowledge_engine.storage.milvus.native import (
    ANALYZER_TYPE,
    BM25_FUNCTION_NAME,
    CONTRACT_DESCRIPTION_PREFIX,
    DENSE_VECTOR_FIELD,
    INDEX_TYPE,
    METADATA_FIELD,
    METRIC_TYPE,
    RETRIEVAL_TEXT_FIELD,
    SCHEMA_VERSION,
    SPARSE_INDEX_TYPE,
    SPARSE_METRIC_TYPE,
    SPARSE_VECTOR_FIELD,
    MilvusIndexBinding,
    build_collection_schema,
    build_scope_filter,
    index_contract_description,
    index_contract_from_description,
    node_row_id,
    read_collection_description,
)

# The persisted contract is a stable three-field fact, so this literal pins the
# field set a description may carry. Reading the constant from the module would
# let a new deployment-bound field pass unnoticed.
CONTRACT_FIELDS = {"schema_version", "dimension", "embedding_space_id"}


def _binding(**overrides):
    payload = {
        "schema_version": SCHEMA_VERSION,
        "embedding_space_id": "sha256:abc",
        "dimension": 1536,
    }
    payload.update(overrides)
    return MilvusIndexBinding(**payload)


def test_binding_survives_the_collection_description_round_trip():
    """The contract is stored in, and read back from, its own collection."""
    binding = _binding()

    description = index_contract_description(binding)

    assert description.startswith(CONTRACT_DESCRIPTION_PREFIX)
    assert index_contract_from_description(description) == binding


def test_stored_contract_carries_only_the_stable_compatibility_fields():
    """Deployment and physical layout are not part of the persisted contract."""
    description = index_contract_description(_binding())
    payload = json.loads(description[len(CONTRACT_DESCRIPTION_PREFIX) :])

    assert set(payload) == CONTRACT_FIELDS
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["dimension"] == 1536
    assert payload["embedding_space_id"] == "sha256:abc"


def test_a_contract_without_the_required_fields_is_reported_as_absent():
    """A readable payload missing a compatibility field is never guessed."""
    for payload in (
        {"schema_version": SCHEMA_VERSION},
        {"schema_version": SCHEMA_VERSION, "dimension": 1536},
        {
            "schema_version": SCHEMA_VERSION,
            "dimension": 1536,
            "embedding_space_id": "",
        },
    ):
        description = CONTRACT_DESCRIPTION_PREFIX + json.dumps(payload)

        with pytest.raises(ValueError):
            MilvusIndexBinding.from_payload(payload)

        assert index_contract_from_description(description) is None


def test_the_persisted_contract_reads_back_as_the_one_that_was_written():
    """The payload the writer stored is the payload the reader accepts."""
    binding = _binding()

    assert MilvusIndexBinding.from_payload(binding.to_payload()) == binding


@pytest.mark.parametrize(
    ("field", "value"),
    [
        # A JSON number that is not an integer is a different fact than the
        # integer the contract was written with, not a value to coerce.
        ("schema_version", 5.0),
        ("dimension", 1536.0),
        # A digit string is text, not the number the contract carries.
        ("schema_version", "5"),
        ("dimension", "1536"),
        # ``True`` is an ``int`` in Python but a boolean in JSON.
        ("schema_version", True),
        ("dimension", True),
    ],
)
def test_a_contract_whose_numbers_are_not_json_integers_is_refused(
    field: str, value: object
) -> None:
    """Coercing a stored value would accept a contract no writer produced."""
    payload = _binding().to_payload()
    payload[field] = value

    with pytest.raises(ValueError):
        MilvusIndexBinding.from_payload(payload)

    assert (
        index_contract_from_description(
            CONTRACT_DESCRIPTION_PREFIX + json.dumps(payload)
        )
        is None
    )


@pytest.mark.parametrize(
    "payload",
    [
        # A field of the contract is missing.
        {"schema_version": SCHEMA_VERSION, "dimension": 1536},
        # A field a later writer added is not part of this contract.
        {
            "schema_version": SCHEMA_VERSION,
            "dimension": 1536,
            "embedding_space_id": "sha256:abc",
            "analyzer": "chinese",
        },
    ],
)
def test_a_contract_that_is_not_exactly_the_written_field_set_is_refused(
    payload: dict,
) -> None:
    """The persisted contract is one exact field set, never a superset."""
    with pytest.raises(ValueError):
        MilvusIndexBinding.from_payload(payload)


@pytest.mark.parametrize(
    "description",
    [
        "",
        "wegent knowledge index schema v4",
        CONTRACT_DESCRIPTION_PREFIX + "not json",
        CONTRACT_DESCRIPTION_PREFIX + '["not a contract"]',
        # A description carrying a static-structure field was written by another
        # version of this code, so it is refused instead of being read as a
        # contract of its own: the index it describes must be rebuilt
        # explicitly.
        CONTRACT_DESCRIPTION_PREFIX + '{"schema_version": 5, "dimension": 1536, '
        '"embedding_space_id": "x", "analyzer": "chinese"}',
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
                "auto_id": True,
            }

    described = read_collection_description(_Client(), "wegent_kb_1", timeout=5.0)

    assert described.binding == binding
    assert described.dimension == binding.dimension
    # Whether the collection assigns its own primary keys is part of what the
    # description declares, so it is read instead of dropped.
    assert described.auto_id is True
    assert len(calls) == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"dimension": 4096},
        {"embedding_space_id": "sha256:other"},
        {"schema_version": SCHEMA_VERSION - 1},
    ],
)
def test_binding_rejects_incompatible_contracts(overrides):
    """Any contract difference is an explicit, non-retryable failure."""
    bound = _binding()
    requested = _binding(**overrides)

    with pytest.raises(IndexContractIncompatibleError):
        bound.assert_compatible(requested, collection_name="wegent_kb_1")


def test_binding_accepts_identical_contract():
    _binding().assert_compatible(_binding(), collection_name="wegent_kb_1")


def test_binding_compares_only_the_compatibility_fields():
    """A contract that differs only outside the field set is still compatible.

    The three fields are the whole persisted contract, so the comparison can
    never depend on where the collection lives or how it was produced.
    """
    bound = _binding()
    requested = MilvusIndexBinding(
        schema_version=bound.schema_version,
        dimension=bound.dimension,
        embedding_space_id=bound.embedding_space_id,
    )

    bound.assert_compatible(requested, collection_name="wegent_kb_1")


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
    binding = _binding(dimension=4096, embedding_space_id="sha256:space")
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
        _binding(dimension=1536, embedding_space_id="sha256:a")
    )
    second = build_collection_schema(
        _binding(dimension=1536, embedding_space_id="sha256:b")
    )

    assert first.description != second.description
    assert (
        index_contract_from_description(first.description).embedding_space_id
        == "sha256:a"
    )


def test_the_schema_version_publishes_the_current_physical_structure():
    """Static structure is versioned, never persisted as its own fields.

    The analyzer, metric, index and row layout are what a stored collection is
    physically built from. They are not part of the persisted contract, so this
    literal is the record of what the current ``SCHEMA_VERSION`` means: change
    any value here and the version must move with it, or an older collection
    would be served under a physical structure it does not have.
    """
    schema = build_collection_schema(_binding())

    assert SCHEMA_VERSION == 5
    assert (
        ANALYZER_TYPE,
        METRIC_TYPE,
        INDEX_TYPE,
        SPARSE_METRIC_TYPE,
        SPARSE_INDEX_TYPE,
        BM25_FUNCTION_NAME,
    ) == (
        "chinese",
        "COSINE",
        "AUTOINDEX",
        "BM25",
        "SPARSE_INVERTED_INDEX",
        "retrieval_text_bm25",
    )
    assert set(field.name for field in schema.fields) == {
        "id",
        "retrieval_text",
        "display_text",
        "metadata",
        DENSE_VECTOR_FIELD,
        SPARSE_VECTOR_FIELD,
    }
    assert index_contract_from_description(schema.description).schema_version == (
        SCHEMA_VERSION
    )

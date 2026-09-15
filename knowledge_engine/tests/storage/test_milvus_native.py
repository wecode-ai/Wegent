# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for the native Milvus contract and schema layer (no server)."""

import pytest

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
)
from knowledge_engine.storage.milvus_native import (
    BINDING_STATE_CREATING,
    BINDING_STATE_READY,
    DENSE_VECTOR_FIELD,
    METRIC_TYPE,
    MilvusDocumentStore,
    MilvusIndexBinding,
    build_collection_schema,
    build_scope_filter,
    claim_id_for,
    node_row_id,
    strip_connection_credentials,
)


def _binding(**overrides):
    payload = {
        "collection_name": "wegent_kb_1",
        "connection": "http://milvus.test:19530",
        "database": "default",
        "schema_version": 1,
        "embedding_space": "sha256:abc",
        "dimension": 1536,
        "metric_type": METRIC_TYPE,
        "index_type": "AUTOINDEX",
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
        {"schema_version": 2},
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


def test_node_row_id_is_stable_and_execution_scoped():
    """The same batch re-sent overwrites; a new execution is isolated."""
    base = {
        "knowledge_id": "1",
        "doc_ref": "42",
        "generation": 3,
        "attempt_id": "attempt-a",
        "node_kind": "chunk",
        "chunk_index": 0,
    }

    assert node_row_id(**base) == node_row_id(**base)
    assert node_row_id(**base) != node_row_id(**{**base, "attempt_id": "attempt-b"})
    assert node_row_id(**base) != node_row_id(**{**base, "generation": 4})
    assert node_row_id(**base) != node_row_id(**{**base, "chunk_index": 1})


def test_scope_filter_requires_published_rows_in_scope():
    expression = build_scope_filter(knowledge_id="1", doc_refs=[42, "doc_b"])

    assert 'knowledge_id == "1"' in expression
    assert "published == true" in expression
    assert 'doc_ref in ["42", "doc_b"]' in expression


def test_scope_filter_escapes_quotes_and_backslashes():
    expression = build_scope_filter(knowledge_id='a"b\\c')

    assert 'knowledge_id == "a\\"b\\\\c"' in expression


def test_scope_filter_rejects_empty_document_scope():
    """An empty intersection must never widen into an unfiltered query."""
    with pytest.raises(ValueError):
        build_scope_filter(knowledge_id="1", doc_refs=[])


def test_collection_schema_declares_required_fields_and_dimension():
    schema = build_collection_schema(4096)
    fields = {field.name: field for field in schema.fields}

    assert fields[DENSE_VECTOR_FIELD].params["dim"] == 4096
    for name in (
        "knowledge_id",
        "doc_ref",
        "generation",
        "attempt_id",
        "chunk_index",
        "retrieval_text",
        "display_text",
        "metadata_json",
        "published",
    ):
        assert name in fields
    assert fields["id"].is_primary


def test_strip_connection_credentials_removes_userinfo():
    assert (
        strip_connection_credentials("https://user:pass@milvus.test:19530/db")
        == "https://milvus.test:19530/db"
    )
    assert strip_connection_credentials("/tmp/milvus.db") == "/tmp/milvus.db"


class _FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    def close(self):
        self.closed = True

    def has_collection(self, collection_name):
        return False


def test_read_only_verify_does_not_create_resources():
    """A missing index reports absence and touches nothing else."""
    created: list[_FakeClient] = []

    def factory(**kwargs):
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    store = MilvusDocumentStore(
        uri="http://milvus.test:19530",
        client_factory=factory,
    )

    with store.client() as client:
        assert (
            store.verify_index(client, "wegent_kb_1", dimension=8, embedding_space="s")
            is None
        )

    assert len(created) == 1
    assert created[0].closed is True
    assert created[0].kwargs["db_name"] == "default"


def test_client_is_closed_when_the_operation_raises():
    created: list[_FakeClient] = []

    def factory(**kwargs):
        client = _FakeClient(**kwargs)
        created.append(client)
        return client

    store = MilvusDocumentStore(uri="/tmp/milvus.db", client_factory=factory)

    with pytest.raises(RuntimeError):
        with store.client():
            raise RuntimeError("boom")

    assert created[0].closed is True


class _CollectionClient:
    """Minimal client stub for index-creation state transitions."""

    def __init__(self, *, collection_exists: bool) -> None:
        self.collection_exists = collection_exists

    def has_collection(self, collection_name: str) -> bool:
        return self.collection_exists


def _store_for_state(binding, state, *, collection_exists: bool):
    store = MilvusDocumentStore(uri="http://milvus.test:19530")
    store.read_binding_entry = lambda client, name: (binding, state)
    store._assert_collection_dimension = lambda client, requested: None
    written: list[str] = []
    store.write_binding = (
        lambda client, requested, *, state=BINDING_STATE_READY: written.append(state)
    )
    claims: list[str] = []
    store.claim_index = lambda client, requested: claims.append(
        "claim"
    ) or claim_id_for(requested)
    store.has_claim = lambda client, requested: bool(claims)
    store.release_claim = lambda client, requested: claims.append("release")
    created: list[str] = []
    store._create_collection = (
        lambda client, requested: created.append(requested.collection_name) or True
    )
    return store, written, created


def test_ensure_index_repairs_a_crashed_creation_holding_the_claim():
    """A crash between collection creation and confirmation is retryable."""
    binding = _binding()
    store, written, _ = _store_for_state(None, None, collection_exists=True)
    claims: list[str] = []
    store.has_claim = lambda client, requested: True
    store.release_claim = lambda client, requested: claims.append("release")

    result = store.ensure_index(
        _CollectionClient(collection_exists=True),
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert result == binding
    assert written == [BINDING_STATE_READY]
    assert claims == ["release"]


def test_ensure_index_claims_before_creating():
    """The creation claim is durable, so an interrupted create can be retried."""
    binding = _binding()
    store, written, created = _store_for_state(None, None, collection_exists=False)
    claims: list[str] = []
    store.claim_index = lambda client, requested: claims.append(
        "claim"
    ) or claim_id_for(requested)

    store.ensure_index(
        _CollectionClient(collection_exists=False),
        binding.collection_name,
        dimension=binding.dimension,
        embedding_space=binding.embedding_space,
    )

    assert claims == ["claim"]
    assert written == [BINDING_STATE_READY]
    assert created == [binding.collection_name]


def test_ensure_index_still_rejects_an_unknown_collection():
    """A collection with no contract and no claim is never adopted."""
    binding = _binding()
    store, written, _ = _store_for_state(None, None, collection_exists=True)

    with pytest.raises(IndexContractIncompatibleError):
        store.ensure_index(
            _CollectionClient(collection_exists=True),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )

    assert written == []


def test_claim_keys_are_contract_scoped():
    """A different contract gets a different claim key and cannot clobber."""
    first = _binding()
    second = _binding(dimension=4096)
    third = _binding(embedding_space="sha256:other")

    assert claim_id_for(first) != claim_id_for(second)
    assert claim_id_for(first) != claim_id_for(third)
    assert claim_id_for(first) == claim_id_for(_binding())


def test_ensure_index_reports_a_missing_confirmed_index():
    """A ready contract whose collection disappeared must fail loudly."""
    binding = _binding()
    store, _, _ = _store_for_state(
        binding, BINDING_STATE_READY, collection_exists=False
    )

    with pytest.raises(IndexMissingError):
        store.ensure_index(
            _CollectionClient(collection_exists=False),
            binding.collection_name,
            dimension=binding.dimension,
            embedding_space=binding.embedding_space,
        )

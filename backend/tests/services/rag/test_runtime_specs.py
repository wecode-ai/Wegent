import pytest
from pydantic import ValidationError

from app.services.knowledge.splitter_config import normalize_splitter_config
from app.services.rag.runtime_specs import (
    DeleteRuntimeSpec,
    DirectInjectionBudget,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    IndexSource,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)
from shared.models import RemoteQueryRequest, RetrievalScope


def test_index_runtime_spec_keeps_control_plane_free_fields():
    spec = IndexRuntimeSpec(
        knowledge_base_id=7,
        document_id=8,
        index_owner_user_id=9,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(attachment_id=123, source_type="attachment"),
        index_families=["chunk_vector"],
        splitter_config={"type": "smart"},
        user_name="alice",
    )
    assert spec.knowledge_base_id == 7
    assert spec.source.attachment_id == 123
    assert spec.index_families == ["chunk_vector"]
    assert spec.splitter_config.chunk_strategy == "flat"
    assert spec.splitter_config.format_enhancement == "file_aware"


@pytest.mark.parametrize(
    "spec_type",
    [
        IndexRuntimeSpec,
        DeleteRuntimeSpec,
        PurgeKnowledgeRuntimeSpec,
        DropKnowledgeIndexRuntimeSpec,
        ListChunksRuntimeSpec,
    ],
)
def test_execution_specs_declare_no_resolved_execution_config(spec_type):
    """knowledge_runtime resolves retriever and embedding configs, not the Backend."""
    assert "retriever_config" not in spec_type.model_fields
    assert "embedding_model_config" not in spec_type.model_fields


def test_index_runtime_spec_keeps_normalized_splitter_config_shape():
    normalized = normalize_splitter_config({"type": "smart"})

    spec = IndexRuntimeSpec(
        knowledge_base_id=7,
        document_id=8,
        index_owner_user_id=9,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(attachment_id=123, source_type="attachment"),
        splitter_config=normalized.model_dump(exclude_none=True),
    )

    assert spec.splitter_config.model_dump(exclude_none=True) == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 1024,
            "chunk_overlap": 50,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
        "legacy_type": "smart",
    }


def test_index_runtime_spec_defaults_missing_splitter_config_to_runtime_default():
    spec = IndexRuntimeSpec(
        knowledge_base_id=7,
        document_id=8,
        index_owner_user_id=9,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(attachment_id=123, source_type="attachment"),
    )

    assert spec.splitter_config.model_dump(exclude_none=True) == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 1024,
            "chunk_overlap": 50,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
    }


def test_index_runtime_spec_accepts_hierarchical_splitter_config():
    spec = IndexRuntimeSpec(
        knowledge_base_id=7,
        document_id=8,
        index_owner_user_id=9,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embed-a",
        embedding_model_namespace="default",
        source=IndexSource(attachment_id=123, source_type="attachment"),
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
    )

    assert spec.splitter_config.model_dump(exclude_none=True) == {
        "chunk_strategy": "hierarchical",
        "format_enhancement": "file_aware",
        "hierarchical_config": {
            "parent_chunk_size": 2048,
            "child_chunk_size": 512,
            "child_chunk_overlap": 64,
            "parent_separator": "\n\n",
            "child_separator": "\n",
        },
        "markdown_enhancement": {"enabled": False},
    }


def test_query_runtime_spec_keeps_direct_injection_budget():
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[1, 2],
        query="how to ship",
        max_results=5,
        route_mode="auto",
        direct_injection_budget=DirectInjectionBudget(
            context_window=200000,
            used_context_tokens=5000,
            reserved_output_tokens=4096,
            context_buffer_ratio=0.1,
            max_direct_chunks=500,
        ),
        scope=RetrievalScope(document_ids=[11]),
        metadata_condition={"key": "source", "operator": "==", "value": "kb"},
        restricted_mode=False,
        user_id=3,
        user_name="alice",
        enabled_index_families=["chunk_vector", "summary_vector"],
        retrieval_policy="summary_first",
    )
    assert spec.knowledge_base_ids == [1, 2]
    assert spec.scope == RetrievalScope(document_ids=[11])
    assert spec.metadata_condition == {
        "key": "source",
        "operator": "==",
        "value": "kb",
    }
    assert spec.direct_injection_budget.max_direct_chunks == 500
    assert spec.enabled_index_families == ["chunk_vector", "summary_vector"]
    assert spec.retrieval_policy == "summary_first"


def test_query_runtime_spec_forbids_control_plane_only_fields():
    with pytest.raises(ValidationError):
        QueryRuntimeSpec(
            user_id=7,
            knowledge_base_ids=[1],
            query="how to ship",
            user_subtask_id=77,
        )


def test_query_runtime_spec_defaults_remote_compatible_fields():
    spec = QueryRuntimeSpec(user_id=7, knowledge_base_ids=[1], query="how to ship")

    assert spec.enabled_index_families == ["chunk_vector"]
    assert spec.retrieval_policy == "chunk_only"


def test_delete_runtime_spec_keeps_reference_fields():
    spec = DeleteRuntimeSpec(
        knowledge_base_id=7,
        document_ref="doc-8",
        index_owner_user_id=9,
        enabled_index_families=["chunk_vector", "summary_vector_index"],
    )

    assert spec.knowledge_base_id == 7
    assert spec.document_ref == "doc-8"
    assert spec.index_owner_user_id == 9
    assert spec.enabled_index_families == ["chunk_vector", "summary_vector_index"]


@pytest.mark.parametrize(
    ("kwargs", "expected_message"),
    [
        (
            {"source_type": "attachment"},
            "Field required",
        ),
    ],
)
def test_index_source_enforces_coherent_shape(kwargs, expected_message):
    with pytest.raises(ValidationError, match=expected_message):
        IndexSource(**kwargs)


@pytest.mark.parametrize("spec_type", [QueryRuntimeSpec, RemoteQueryRequest])
@pytest.mark.parametrize("identity", [None, 0, -1, True, "7", 7.5])
def test_query_contract_rejects_invalid_identity(spec_type, identity):
    with pytest.raises(ValidationError, match="user_id"):
        spec_type(knowledge_base_ids=[1], query="probe", user_id=identity)


@pytest.mark.parametrize("spec_type", [QueryRuntimeSpec, RemoteQueryRequest])
def test_query_contract_requires_identity(spec_type):
    with pytest.raises(ValidationError, match="user_id"):
        spec_type(knowledge_base_ids=[1], query="probe")

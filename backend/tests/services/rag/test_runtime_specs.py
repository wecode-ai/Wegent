import pytest
from pydantic import ValidationError

from app.services.rag.runtime_specs import (
    DirectInjectionBudget,
    IndexRuntimeSpec,
    IndexSource,
    QueryRuntimeSpec,
)


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
        document_ids=[11],
        restricted_mode=False,
        user_id=3,
        user_name="alice",
    )
    assert spec.knowledge_base_ids == [1, 2]
    assert spec.document_ids == [11]
    assert spec.direct_injection_budget.max_direct_chunks == 500


def test_query_runtime_spec_forbids_control_plane_only_fields():
    with pytest.raises(ValidationError):
        QueryRuntimeSpec(
            knowledge_base_ids=[1],
            query="how to ship",
            user_subtask_id=77,
        )


@pytest.mark.parametrize(
    ("kwargs", "expected_message"),
    [
        (
            {"source_type": "attachment"},
            "attachment_id is required",
        ),
        (
            {"source_type": "attachment", "attachment_id": 123, "file_path": "/tmp/a"},
            "file_path must not be provided",
        ),
        (
            {"source_type": "file_path"},
            "file_path is required",
        ),
        (
            {"source_type": "file_path", "file_path": "/tmp/a", "attachment_id": 123},
            "attachment_id must not be provided",
        ),
    ],
)
def test_index_source_enforces_coherent_shape(kwargs, expected_message):
    with pytest.raises(ValidationError, match=expected_message):
        IndexSource(**kwargs)

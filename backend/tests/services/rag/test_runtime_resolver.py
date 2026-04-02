from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.rag.runtime_resolver import RagRuntimeResolver


def test_build_index_runtime_spec_uses_kb_owner_for_group_kb():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch(
        "app.services.rag.runtime_resolver.get_kb_index_info",
        return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=True),
    ) as get_kb_index_info_mock:
        spec = resolver.build_index_runtime_spec(
            db=db,
            knowledge_base_id="7",
            attachment_id=11,
            retriever_name="retriever-a",
            retriever_namespace="default",
            embedding_model_name="embed-a",
            embedding_model_namespace="default",
            user_id=9,
            user_name="alice",
            document_id=99,
            splitter_config_dict={"type": "smart"},
        )

    get_kb_index_info_mock.assert_called_once_with(
        db=db,
        knowledge_base_id="7",
        current_user_id=9,
    )
    assert spec.knowledge_base_id == 7
    assert spec.index_owner_user_id == 42
    assert spec.source.attachment_id == 11


def test_build_query_runtime_spec_maps_runtime_budget():
    resolver = RagRuntimeResolver()

    spec = resolver.build_query_runtime_spec(
        knowledge_base_ids=[1],
        query="release checklist",
        max_results=3,
        route_mode="auto",
        document_ids=[10],
        user_id=5,
        user_name="alice",
        context_window=200000,
        used_context_tokens=1200,
        reserved_output_tokens=4096,
        context_buffer_ratio=0.1,
        max_direct_chunks=250,
        restricted_mode=True,
    )

    assert spec.knowledge_base_ids == [1]
    assert spec.query == "release checklist"
    assert spec.max_results == 3
    assert spec.route_mode == "auto"
    assert spec.document_ids == [10]
    assert spec.user_id == 5
    assert spec.user_name == "alice"
    assert spec.restricted_mode is True
    assert spec.direct_injection_budget.context_window == 200000
    assert spec.direct_injection_budget.used_context_tokens == 1200
    assert spec.direct_injection_budget.reserved_output_tokens == 4096
    assert spec.direct_injection_budget.context_buffer_ratio == 0.1
    assert spec.direct_injection_budget.max_direct_chunks == 250


def test_build_query_runtime_spec_omits_budget_without_context_window():
    resolver = RagRuntimeResolver()

    spec = resolver.build_query_runtime_spec(
        knowledge_base_ids=[1],
        query="release checklist",
        max_results=3,
        route_mode="auto",
    )

    assert spec.direct_injection_budget is None


def test_build_query_runtime_spec_rejects_control_plane_only_inputs():
    resolver = RagRuntimeResolver()

    with pytest.raises(TypeError):
        resolver.build_query_runtime_spec(
            knowledge_base_ids=[1],
            query="release checklist",
            max_results=3,
            route_mode="auto",
            document_ids=[10],
            user_id=5,
            user_name="alice",
            context_window=200000,
            used_context_tokens=1200,
            reserved_output_tokens=4096,
            context_buffer_ratio=0.1,
            max_direct_chunks=250,
            restricted_mode=True,
            user_subtask_id=77,
        )


def test_build_index_runtime_spec_rejects_non_integer_kb_id():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch(
        "app.services.rag.runtime_resolver.get_kb_index_info"
    ) as get_kb_index_info:
        with pytest.raises(ValueError, match="knowledge_base_id must be an integer"):
            resolver.build_index_runtime_spec(
                db=db,
                knowledge_base_id="abc",
                attachment_id=11,
                retriever_name="retriever-a",
                retriever_namespace="default",
                embedding_model_name="embed-a",
                embedding_model_namespace="default",
                user_id=9,
                user_name="alice",
                document_id=99,
                splitter_config_dict={"type": "smart"},
            )

    get_kb_index_info.assert_not_called()

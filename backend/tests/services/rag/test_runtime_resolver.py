from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.models import (
    RetrievalScope,
    RuntimeRetrievalConfig,
)


def test_build_index_runtime_spec_uses_kb_owner_for_group_kb():
    """The index spec carries references only; no execution config is resolved."""
    resolver = RagRuntimeResolver()
    db = MagicMock()
    db.query.side_effect = AssertionError("indexing must not resolve configs")

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
    assert spec.retriever_name == "retriever-a"
    assert spec.embedding_model_name == "embed-a"


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
        enabled_index_families=["chunk_vector", "summary_vector"],
        retrieval_policy="summary_first",
    )

    assert spec.knowledge_base_ids == [1]
    assert spec.query == "release checklist"
    assert spec.max_results == 3
    assert spec.route_mode == "auto"
    assert spec.scope == RetrievalScope(document_ids=[10])
    assert spec.user_id == 5
    assert spec.user_name == "alice"
    assert spec.restricted_mode is True
    assert spec.enabled_index_families == ["chunk_vector", "summary_vector"]
    assert spec.retrieval_policy == "summary_first"
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
    assert spec.enabled_index_families == ["chunk_vector"]
    assert spec.retrieval_policy == "chunk_only"


def test_build_public_list_chunks_runtime_spec_carries_metadata_condition() -> None:
    """A knowledge base without retrieval config still yields a list-chunks spec."""
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(
        id=7,
        user_id=42,
        namespace="default",
        json={"spec": {}},
    )

    with patch(
        "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
        return_value=(kb, True),
    ):
        spec = resolver.build_public_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=7,
            user_id=9,
            max_chunks=500,
            query="list_index_chunks",
            metadata_condition={
                "operator": "and",
                "conditions": [
                    {"key": "lang", "operator": "==", "value": "zh"},
                ],
            },
        )

    assert spec.knowledge_base_id == 7
    assert spec.index_owner_user_id == 42
    assert spec.max_chunks == 500
    assert spec.metadata_condition == {
        "operator": "and",
        "conditions": [
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }


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


def test_build_delete_runtime_spec_carries_reference_only():
    """A knowledge base without retrieval config still yields a delete spec."""
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch.object(
        resolver,
        "_get_knowledge_base_record",
        return_value=SimpleNamespace(user_id=42, json={"spec": {}}),
    ):
        spec = resolver.build_delete_runtime_spec(
            db=db,
            knowledge_base_id=7,
            document_ref="doc-8",
            index_owner_user_id=99,
            enabled_index_families=["chunk_vector", "summary_vector_index"],
        )

    assert spec.knowledge_base_id == 7
    assert spec.document_ref == "doc-8"
    assert spec.index_owner_user_id == 99
    assert spec.enabled_index_families == ["chunk_vector", "summary_vector_index"]


def test_build_delete_runtime_spec_requires_an_existing_knowledge_base():
    """The non-config precondition stays in the Backend."""
    resolver = RagRuntimeResolver()

    with patch.object(resolver, "_get_knowledge_base_record", return_value=None):
        with pytest.raises(ValueError, match="Knowledge base 7 not found"):
            resolver.build_delete_runtime_spec(
                db=MagicMock(),
                knowledge_base_id=7,
                document_ref="doc-8",
            )


def test_build_delete_runtime_spec_preserves_explicit_public_owner_scope():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch.object(
        resolver,
        "_get_knowledge_base_record",
        return_value=SimpleNamespace(user_id=42, json={"spec": {}}),
    ):
        spec = resolver.build_delete_runtime_spec(
            db=db,
            knowledge_base_id=7,
            document_ref="doc-8",
            index_owner_user_id=0,
        )

    assert spec.index_owner_user_id == 0


def test_build_public_query_runtime_spec_requires_kb_access():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch(
        "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
        return_value=(None, False),
    ):
        with pytest.raises(
            ValueError, match="Knowledge base 7 not found or access denied"
        ):
            resolver.build_public_query_runtime_spec(
                db=db,
                knowledge_base_id=7,
                query="release checklist",
                max_results=5,
                user_id=9,
                user_name="alice",
                score_threshold=0.7,
                retrieval_mode="vector",
            )


def test_build_public_query_runtime_spec_carries_only_retrieval_overrides():
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(id=7, user_id=42, namespace="default")

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(kb, True),
        ) as get_knowledge_base,
    ):
        spec = resolver.build_public_query_runtime_spec(
            db=db,
            knowledge_base_id=7,
            query="release checklist",
            max_results=5,
            user_id=9,
            user_name="alice",
            score_threshold=0.7,
            retrieval_mode="vector",
        )

    get_knowledge_base.assert_called_once_with(
        db=db,
        knowledge_base_id=7,
        user_id=9,
    )
    assert spec.knowledge_base_ids == [7]
    assert spec.route_mode == "rag_retrieval"
    assert spec.max_results == 5
    assert len(spec.knowledge_base_retrieval_overrides) == 1
    assert spec.knowledge_base_retrieval_overrides[0].knowledge_base_id == 7
    assert spec.knowledge_base_retrieval_overrides[0].retrieval_config == (
        RuntimeRetrievalConfig(
            top_k=5,
            score_threshold=0.7,
            retrieval_mode="vector",
        )
    )


def test_build_query_runtime_spec_resolves_no_execution_config() -> None:
    """A query spec carries only references; knowledge_runtime resolves configs."""
    resolver = RagRuntimeResolver()

    spec = resolver.build_query_runtime_spec(
        knowledge_base_ids=[7],
        query="release checklist",
        max_results=5,
        route_mode="rag_retrieval",
        user_id=9,
        user_name="alice",
    )

    assert spec.knowledge_base_ids == [7]
    assert spec.route_mode == "rag_retrieval"


def test_build_public_list_chunks_runtime_spec_uses_resolved_owner_scope() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(
        id=7,
        user_id=42,
        namespace="default",
        json={"spec": {}},
    )

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(kb, True),
        ),
        patch(
            "app.services.knowledge.index_runtime.build_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=7, summary_enabled=False),
        ) as build_kb_index_info,
    ):
        spec = resolver.build_public_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=7,
            user_id=9,
            max_chunks=500,
            query="list_index_chunks",
            metadata_condition={"operator": "and"},
        )

    build_kb_index_info.assert_called_once_with(
        db=db,
        knowledge_base=kb,
        current_user_id=9,
    )
    assert spec.index_owner_user_id == 7


@pytest.mark.parametrize("builder_name", ["purge", "drop"])
def test_build_public_index_admin_runtime_spec_carries_reference_only(
    builder_name,
) -> None:
    """Purge and drop carry the knowledge base id and owner, nothing else."""
    resolver = RagRuntimeResolver()
    kb = SimpleNamespace(id=7, user_id=42, json={"spec": {}})
    builders = {
        "purge": resolver.build_public_purge_index_runtime_spec,
        "drop": resolver.build_public_drop_index_runtime_spec,
    }

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(kb, True),
        ),
        patch(
            "app.services.knowledge.index_runtime.build_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=False),
        ),
    ):
        spec = builders[builder_name](
            db=MagicMock(),
            knowledge_base_id=7,
            user_id=9,
        )

    assert spec.knowledge_base_id == 7
    assert spec.index_owner_user_id == 42


@pytest.mark.parametrize("builder_name", ["purge", "drop", "list_chunks"])
def test_public_admin_specs_still_require_knowledge_base_access(builder_name) -> None:
    """The non-config precondition stays in the Backend for every admin path."""
    resolver = RagRuntimeResolver()
    builders = {
        "purge": resolver.build_public_purge_index_runtime_spec,
        "drop": resolver.build_public_drop_index_runtime_spec,
        "list_chunks": resolver.build_public_list_chunks_runtime_spec,
    }
    builder = builders[builder_name]
    kwargs = {"max_chunks": 500} if builder_name == "list_chunks" else {}

    with patch(
        "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
        return_value=(None, False),
    ):
        with pytest.raises(
            ValueError, match="Knowledge base 7 not found or access denied"
        ):
            builder(
                db=MagicMock(),
                knowledge_base_id=7,
                user_id=9,
                **kwargs,
            )

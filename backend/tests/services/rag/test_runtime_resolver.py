from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)


def test_build_index_runtime_spec_uses_kb_owner_for_group_kb():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch(
            "app.services.rag.runtime_resolver.get_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=True),
        ) as get_kb_index_info_mock,
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ),
        patch.object(
            resolver,
            "_build_resolved_embedding_model_config",
            return_value=RuntimeEmbeddingModelConfig(
                model_name="embed-a",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
        ),
    ):
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
    assert spec.retriever_config.storage_config["type"] == "qdrant"
    assert spec.embedding_model_config.resolved_config["protocol"] == "openai"


def test_build_query_runtime_spec_maps_runtime_budget():
    resolver = RagRuntimeResolver()

    with patch.object(
        resolver,
        "_build_query_knowledge_base_configs",
        return_value=[
            RemoteKnowledgeBaseQueryConfig(
                knowledge_base_id=1,
                index_owner_user_id=5,
                retriever_config=RuntimeRetrieverConfig(
                    name="retriever-a",
                    namespace="default",
                    storage_config={"type": "qdrant"},
                ),
                embedding_model_config=RuntimeEmbeddingModelConfig(
                    model_name="embed-a",
                    model_namespace="default",
                    resolved_config={"protocol": "openai"},
                ),
                retrieval_config=RuntimeRetrievalConfig(top_k=20),
            )
        ],
    ):
        spec = resolver.build_query_runtime_spec(
            db=MagicMock(),
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
    assert spec.document_ids == [10]
    assert spec.user_id == 5
    assert spec.user_name == "alice"
    assert spec.restricted_mode is True
    assert spec.knowledge_base_configs == []
    assert spec.enabled_index_families == ["chunk_vector", "summary_vector"]
    assert spec.retrieval_policy == "summary_first"
    assert spec.direct_injection_budget.context_window == 200000
    assert spec.direct_injection_budget.used_context_tokens == 1200
    assert spec.direct_injection_budget.reserved_output_tokens == 4096
    assert spec.direct_injection_budget.context_buffer_ratio == 0.1
    assert spec.direct_injection_budget.max_direct_chunks == 250


def test_build_query_runtime_spec_omits_budget_without_context_window():
    resolver = RagRuntimeResolver()

    with patch.object(
        resolver,
        "_build_query_knowledge_base_configs",
        return_value=[],
    ):
        spec = resolver.build_query_runtime_spec(
            db=MagicMock(),
            knowledge_base_ids=[1],
            query="release checklist",
            max_results=3,
            route_mode="auto",
        )

    assert spec.direct_injection_budget is None
    assert spec.knowledge_base_configs == []
    assert spec.enabled_index_families == ["chunk_vector"]
    assert spec.retrieval_policy == "chunk_only"


def test_build_query_runtime_spec_resolves_configs_for_forced_rag_route():
    resolver = RagRuntimeResolver()
    resolved_configs = [
        RemoteKnowledgeBaseQueryConfig(
            knowledge_base_id=1,
            index_owner_user_id=5,
            retriever_config=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
            embedding_model_config=RuntimeEmbeddingModelConfig(
                model_name="embed-a",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
            retrieval_config=RuntimeRetrievalConfig(top_k=20),
        )
    ]

    with patch.object(
        resolver,
        "_build_query_knowledge_base_configs",
        return_value=resolved_configs,
    ):
        spec = resolver.build_query_runtime_spec(
            db=MagicMock(),
            knowledge_base_ids=[1],
            query="release checklist",
            max_results=3,
            route_mode="rag_retrieval",
        )

    assert spec.knowledge_base_configs == resolved_configs


def test_build_public_list_chunks_runtime_spec_carries_metadata_condition() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(
        id=7,
        user_id=42,
        namespace="default",
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                }
            }
        },
    )

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(kb, True),
        ),
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant", "url": "http://qdrant:6333"},
            ),
        ),
    ):
        spec = resolver.build_public_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=7,
            user_id=9,
            user_name="alice",
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


def test_build_resolved_retriever_config_defaults_missing_index_strategy() -> None:
    resolver = RagRuntimeResolver()
    retriever = SimpleNamespace(
        spec=SimpleNamespace(
            storageConfig=SimpleNamespace(
                type="qdrant",
                url="http://qdrant:6333",
                username=None,
                password=None,
                apiKey=None,
                indexStrategy=None,
                ext=None,
            )
        )
    )

    with patch(
        "app.services.rag.runtime_resolver.retriever_kinds_service.get_retriever",
        return_value=retriever,
    ):
        config = resolver._build_resolved_retriever_config(
            db=MagicMock(),
            user_id=7,
            name="retriever-a",
            namespace="default",
        )

    assert config.storage_config["indexStrategy"] == {"mode": "per_dataset"}


def test_build_query_runtime_spec_rejects_control_plane_only_inputs():
    resolver = RagRuntimeResolver()

    with pytest.raises(TypeError):
        resolver.build_query_runtime_spec(
            db=MagicMock(),
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


def test_build_delete_runtime_spec_resolves_retriever_config():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch.object(
            resolver,
            "_get_knowledge_base_record",
            return_value=SimpleNamespace(
                user_id=42,
                json={
                    "spec": {
                        "retrievalConfig": {
                            "retriever_name": "retriever-a",
                            "retriever_namespace": "default",
                        }
                    }
                },
            ),
        ),
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ),
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
    assert spec.retriever_config.storage_config["type"] == "qdrant"


def test_build_delete_runtime_spec_preserves_explicit_public_owner_scope():
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch.object(
            resolver,
            "_get_knowledge_base_record",
            return_value=SimpleNamespace(
                user_id=42,
                json={
                    "spec": {
                        "retrievalConfig": {
                            "retriever_name": "retriever-a",
                            "retriever_namespace": "default",
                        }
                    }
                },
            ),
        ),
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ) as build_retriever,
    ):
        spec = resolver.build_delete_runtime_spec(
            db=db,
            knowledge_base_id=7,
            document_ref="doc-8",
            index_owner_user_id=0,
        )

    assert spec.index_owner_user_id == 0
    build_retriever.assert_called_once_with(
        db=db,
        user_id=0,
        name="retriever-a",
        namespace="default",
    )


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
                retriever_name="retriever-a",
                retriever_namespace="default",
                embedding_model_name="embed-a",
                embedding_model_namespace="default",
                user_id=9,
                user_name="alice",
                score_threshold=0.7,
                retrieval_mode="vector",
            )


def test_build_public_query_runtime_spec_uses_resolved_owner_scope():
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(id=7, user_id=42, namespace="default")

    with (
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService.get_knowledge_base",
            return_value=(kb, True),
        ),
        patch(
            "app.services.knowledge.index_runtime.build_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=7, summary_enabled=False),
        ) as build_kb_index_info,
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ),
        patch.object(
            resolver,
            "_build_resolved_embedding_model_config",
            return_value=RuntimeEmbeddingModelConfig(
                model_name="embed-a",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
        ),
    ):
        spec = resolver.build_public_query_runtime_spec(
            db=db,
            knowledge_base_id=7,
            query="release checklist",
            max_results=5,
            retriever_name="retriever-a",
            retriever_namespace="default",
            embedding_model_name="embed-a",
            embedding_model_namespace="default",
            user_id=9,
            user_name="alice",
            score_threshold=0.7,
            retrieval_mode="vector",
        )

    build_kb_index_info.assert_called_once_with(
        db=db,
        knowledge_base=kb,
        current_user_id=9,
    )
    assert spec.knowledge_base_configs[0].index_owner_user_id == 7


def test_build_query_runtime_spec_uses_resolved_owner_scope_for_rag_route() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(
        id=7,
        user_id=42,
        namespace="default",
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "embed-a",
                        "model_namespace": "default",
                    },
                }
            }
        },
    )

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=kb),
        patch(
            "app.services.knowledge.index_runtime.build_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=False),
        ) as build_kb_index_info,
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ) as build_retriever,
        patch.object(
            resolver,
            "_build_resolved_embedding_model_config",
            return_value=RuntimeEmbeddingModelConfig(
                model_name="embed-a",
                model_namespace="default",
                resolved_config={"protocol": "openai"},
            ),
        ) as build_embedding,
    ):
        spec = resolver.build_query_runtime_spec(
            db=db,
            knowledge_base_ids=[7],
            query="release checklist",
            max_results=5,
            route_mode="rag_retrieval",
            user_id=9,
            user_name="alice",
        )

    build_kb_index_info.assert_called_once_with(
        db=db,
        knowledge_base=kb,
        current_user_id=9,
    )
    build_retriever.assert_called_once_with(
        db=db,
        user_id=42,
        name="retriever-a",
        namespace="default",
    )
    build_embedding.assert_called_once_with(
        db=db,
        user_id=42,
        model_name="embed-a",
        model_namespace="default",
        user_name="alice",
    )
    assert spec.knowledge_base_configs[0].index_owner_user_id == 42


def test_build_public_list_chunks_runtime_spec_uses_resolved_owner_scope() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    kb = SimpleNamespace(
        id=7,
        user_id=42,
        namespace="default",
        json={
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                }
            }
        },
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
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="retriever-a",
                namespace="default",
                storage_config={"type": "qdrant"},
            ),
        ),
    ):
        spec = resolver.build_public_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=7,
            user_id=9,
            user_name="alice",
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


def test_build_resolved_embedding_model_config_preserves_additional_modalities() -> (
    None
):
    resolver = RagRuntimeResolver()
    db = MagicMock()
    model_kind = SimpleNamespace(
        json={
            "spec": {
                "protocol": "openai",
                "modelConfig": {
                    "env": {
                        "base_url": "https://api.openai.com/v1",
                        "model_id": "text-embedding-3-large",
                    }
                },
                "embeddingConfig": {
                    "dimensions": 3072,
                    "additional_input_modalities": ["image", "image", "audio"],
                },
            }
        }
    )

    with patch.object(resolver, "_get_model_kind", return_value=model_kind):
        config = resolver._build_resolved_embedding_model_config(
            db=db,
            user_id=7,
            model_name="embed-a",
            model_namespace="default",
            user_name="alice",
        )

    assert config.resolved_config["dimensions"] == 3072
    assert config.resolved_config["additional_input_modalities"] == ["image"]

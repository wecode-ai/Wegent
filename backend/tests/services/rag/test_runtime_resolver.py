from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.knowledge_module import RetrievalResource
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteKnowledgeBaseQueryConfig,
    RemoteRetrievalResourceRef,
    RetrievalScope,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)

_QUERY_KB = SimpleNamespace(
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


def test_build_query_authorized_resources_authorizes_owner_resources() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    reader = SimpleNamespace(id=9)

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=_QUERY_KB),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".resolve_read_user_for_knowledge_base",
            return_value=reader,
        ),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".get_knowledge_base",
            return_value=(_QUERY_KB, True),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=RetrievalResource(
                name="retriever-a", kind="Retriever", namespace="default"
            ),
        ) as get_retriever,
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource",
            return_value=RetrievalResource(
                name="embed-a",
                kind="Model",
                category="embedding",
                namespace="default",
            ),
        ) as get_model,
    ):
        authorized = resolver.build_query_authorized_resources(
            db=db,
            knowledge_base_ids=[7],
            read_user_id=9,
            task_id=11,
        )

    assert len(authorized) == 1
    entry = authorized[0]
    assert entry.knowledge_base_id == 7
    assert entry.index_owner_user_id == 42
    assert entry.retriever.kind == "Retriever"
    assert entry.retriever.name == "retriever-a"
    assert entry.embedding_model.kind == "Model"
    assert entry.embedding_model.name == "embed-a"
    get_retriever.assert_called_once_with(
        db, user_id=42, name="retriever-a", namespace="default"
    )
    get_model.assert_called_once_with(
        db, user_id=42, name="embed-a", namespace="default"
    )


def test_build_query_authorized_resources_rejects_owner_without_resource() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    reader = SimpleNamespace(id=9)

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=_QUERY_KB),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".resolve_read_user_for_knowledge_base",
            return_value=reader,
        ),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".get_knowledge_base",
            return_value=(_QUERY_KB, True),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=None,
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource"
        ) as resolve_embedding,
    ):
        with pytest.raises(HTTPException) as exc_info:
            resolver.build_query_authorized_resources(
                db=db,
                knowledge_base_ids=[7],
                read_user_id=9,
            )

    assert exc_info.value.status_code == 403
    resolve_embedding.assert_not_called()


def test_build_query_authorized_resources_rejects_missing_embedding_model() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()
    reader = SimpleNamespace(id=9)

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=_QUERY_KB),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".resolve_read_user_for_knowledge_base",
            return_value=reader,
        ),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".get_knowledge_base",
            return_value=(_QUERY_KB, True),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=RetrievalResource(
                name="retriever-a", kind="Retriever", namespace="default"
            ),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource",
            return_value=None,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            resolver.build_query_authorized_resources(
                db=db,
                knowledge_base_ids=[7],
                read_user_id=9,
            )

    assert exc_info.value.status_code == 403
    assert "embed-a" in str(exc_info.value.detail)


def test_build_query_authorized_resources_rejects_caller_without_read_access() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=_QUERY_KB),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".resolve_read_user_for_knowledge_base",
            return_value=SimpleNamespace(id=9),
        ),
        patch(
            "app.services.knowledge.knowledge_service.KnowledgeService"
            ".get_knowledge_base",
            return_value=(_QUERY_KB, False),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource"
        ) as resolve_retriever,
    ):
        with pytest.raises(HTTPException) as exc_info:
            resolver.build_query_authorized_resources(
                db=db,
                knowledge_base_ids=[7],
                read_user_id=9,
            )

    assert exc_info.value.status_code == 403
    assert "Access denied" in str(exc_info.value.detail)
    resolve_retriever.assert_not_called()


def test_build_query_authorized_resources_rejects_missing_reader() -> None:
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with patch.object(resolver, "_get_knowledge_base_record", return_value=_QUERY_KB):
        with pytest.raises(HTTPException) as exc_info:
            resolver.build_query_authorized_resources(
                db=db,
                knowledge_base_ids=[7],
            )

    assert exc_info.value.status_code == 403


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
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=RetrievalResource(
                name="retriever-a", kind="Retriever", namespace="default"
            ),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource",
            return_value=RetrievalResource(
                name="embed-a",
                kind="Model",
                category="embedding",
                namespace="default",
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
    assert spec.authorized_resources == RemoteAuthorizedRetrievalResources(
        knowledge_base_id=7,
        index_owner_user_id=42,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name="retriever-a", namespace="default"
        ),
        embedding_model=RemoteRetrievalResourceRef(
            kind="Model", name="embed-a", namespace="default"
        ),
    )
    assert spec.retriever_config is not None
    assert spec.embedding_model_config is not None


def test_build_index_runtime_spec_skips_resolved_configs_for_remote():
    """The remote request carries references, not configuration it will drop."""
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch(
            "app.services.rag.runtime_resolver.get_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=True),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=RetrievalResource(
                name="retriever-a", kind="Retriever", namespace="default"
            ),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource",
            return_value=RetrievalResource(
                name="embed-a",
                kind="Model",
                category="embedding",
                namespace="default",
            ),
        ),
        patch.object(resolver, "_build_resolved_retriever_config") as build_retriever,
        patch.object(
            resolver, "_build_resolved_embedding_model_config"
        ) as build_embedding,
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
            splitter_config_dict=None,
            resolve_execution_configs=False,
        )

    build_retriever.assert_not_called()
    build_embedding.assert_not_called()
    assert spec.retriever_config is None
    assert spec.embedding_model_config is None
    assert spec.authorized_resources is not None


def test_build_index_runtime_spec_rejects_owner_without_resource() -> None:
    """Indexing fails before any remote request when the owner lost a resource."""
    resolver = RagRuntimeResolver()
    db = MagicMock()

    with (
        patch(
            "app.services.rag.runtime_resolver.get_kb_index_info",
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=False),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=None,
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_embedding_model_resource"
        ) as resolve_embedding,
    ):
        with pytest.raises(HTTPException) as exc_info:
            resolver.build_index_runtime_spec(
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
                splitter_config_dict=None,
            )

    assert exc_info.value.status_code == 403
    resolve_embedding.assert_not_called()


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
    assert spec.scope == RetrievalScope(document_ids=[10])
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
    authorized = [
        RemoteAuthorizedRetrievalResources(
            knowledge_base_id=1,
            index_owner_user_id=5,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="retriever-a", namespace="default"
            ),
            embedding_model=RemoteRetrievalResourceRef(
                kind="Model", name="embed-a", namespace="default"
            ),
        )
    ]

    with patch.object(
        resolver,
        "build_query_authorized_resources",
        return_value=authorized,
    ) as build_authorized:
        spec = resolver.build_query_runtime_spec(
            db=MagicMock(),
            knowledge_base_ids=[1],
            query="release checklist",
            max_results=3,
            route_mode="rag_retrieval",
            user_id=9,
            task_id=11,
        )

    build_authorized.assert_called_once_with(
        db=ANY,
        knowledge_base_ids=[1],
        read_user_id=9,
        task_id=11,
    )
    assert spec.authorized_resources == authorized
    assert spec.knowledge_base_configs == []


def test_build_query_runtime_spec_reuses_provided_rag_configs():
    resolver = RagRuntimeResolver()
    authorized = [
        RemoteAuthorizedRetrievalResources(
            knowledge_base_id=1,
            index_owner_user_id=5,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="retriever-a", namespace="default"
            ),
            embedding_model=RemoteRetrievalResourceRef(
                kind="Model", name="embed-a", namespace="default"
            ),
        )
    ]

    with patch.object(resolver, "build_query_authorized_resources") as build_authorized:
        spec = resolver.build_query_runtime_spec(
            db=MagicMock(),
            knowledge_base_ids=[1],
            query="release checklist",
            max_results=3,
            route_mode="rag_retrieval",
            authorized_resources=authorized,
        )

    build_authorized.assert_not_called()
    assert spec.authorized_resources == authorized


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
            "_authorize_owner_resources",
        ) as authorize_resources,
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
    authorize_resources.assert_called_once_with(
        db=db,
        entry=RemoteAuthorizedRetrievalResources(
            knowledge_base_id=7,
            index_owner_user_id=7,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="retriever-a", namespace="default"
            ),
            embedding_model=RemoteRetrievalResourceRef(
                kind="Model", name="embed-a", namespace="default"
            ),
            explicit_selection=True,
        ),
    )
    assert spec.authorized_resources[0].index_owner_user_id == 7
    assert spec.authorized_resources[0].retriever.name == "retriever-a"
    assert spec.authorized_resources[0].embedding_model.name == "embed-a"
    assert len(spec.knowledge_base_retrieval_overrides) == 1
    assert spec.knowledge_base_retrieval_overrides[0].knowledge_base_id == 7
    assert spec.knowledge_base_retrieval_overrides[0].retrieval_config == (
        RuntimeRetrievalConfig(
            top_k=5,
            score_threshold=0.7,
            retrieval_mode="vector",
        )
    )


def test_build_public_query_runtime_spec_selects_caller_resources():
    """Public callers execute the resources they named, not stored values."""
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
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=False),
        ),
        patch.object(resolver, "_authorize_owner_resources") as authorize_resources,
    ):
        spec = resolver.build_public_query_runtime_spec(
            db=db,
            knowledge_base_id=7,
            query="release checklist",
            max_results=5,
            retriever_name="retriever-b",
            retriever_namespace="default",
            embedding_model_name="embed-b",
            embedding_model_namespace="default",
            user_id=9,
            user_name="alice",
            score_threshold=0.7,
            retrieval_mode="vector",
        )

    authorize_resources.assert_called_once()
    assert spec.authorized_resources[0] == RemoteAuthorizedRetrievalResources(
        knowledge_base_id=7,
        index_owner_user_id=42,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name="retriever-b", namespace="default"
        ),
        embedding_model=RemoteRetrievalResourceRef(
            kind="Model", name="embed-b", namespace="default"
        ),
        explicit_selection=True,
    )


def test_build_public_query_runtime_spec_rejects_unavailable_resource():
    """An explicit reference the owner cannot use is refused, not substituted."""
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
            return_value=SimpleNamespace(index_owner_user_id=42, summary_enabled=False),
        ),
        patch(
            "app.services.rag.runtime_resolver.resolve_retriever_resource",
            return_value=None,
        ),
        pytest.raises(HTTPException) as exc_info,
    ):
        resolver.build_public_query_runtime_spec(
            db=db,
            knowledge_base_id=7,
            query="release checklist",
            max_results=5,
            retriever_name="missing-retriever",
            retriever_namespace="default",
            embedding_model_name="embed-a",
            embedding_model_namespace="default",
            user_id=9,
            user_name="alice",
            score_threshold=0.7,
            retrieval_mode="vector",
        )

    assert exc_info.value.status_code == 403
    assert "missing-retriever" in exc_info.value.detail


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
                    "retrieval_mode": "vector",
                }
            }
        },
    )

    with (
        patch.object(resolver, "_get_knowledge_base_record", return_value=kb),
        patch.object(resolver, "_require_knowledge_read_access") as require_read,
        patch.object(
            resolver,
            "_authorize_owner_resources",
        ) as authorize_resources,
    ):
        spec = resolver.build_query_runtime_spec(
            db=db,
            knowledge_base_ids=[7],
            query="release checklist",
            max_results=5,
            route_mode="rag_retrieval",
            user_id=9,
            user_name="alice",
            task_id=11,
        )

    require_read.assert_called_once_with(
        db=db, knowledge_base=kb, read_user_id=9, task_id=11
    )
    authorize_resources.assert_called_once_with(
        db=db,
        entry=RemoteAuthorizedRetrievalResources(
            knowledge_base_id=7,
            index_owner_user_id=42,
            retriever=RemoteRetrievalResourceRef(
                kind="Retriever", name="retriever-a", namespace="default"
            ),
            embedding_model=RemoteRetrievalResourceRef(
                kind="Model", name="embed-a", namespace="default"
            ),
        ),
    )
    assert spec.authorized_resources[0].index_owner_user_id == 42
    assert spec.authorized_resources[0].retriever.namespace == "default"
    assert spec.authorized_resources[0].embedding_model.namespace == "default"


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
                    "encoding_format": "float",
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
    assert config.resolved_config["encoding_format"] == "float"
    assert config.resolved_config["additional_input_modalities"] == ["image"]

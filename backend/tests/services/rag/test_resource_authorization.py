from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.knowledge_module import RetrievalResource
from tests.utils.query_knowledge import QUERY_KB as _QUERY_KB


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

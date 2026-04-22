# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, DocumentStatus, KnowledgeDocument
from app.models.user import User
from app.services.context import context_service
from app.services.knowledge.indexing import run_document_indexing
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.rag.remote_gateway import RemoteRagGatewayError
from app.services.rag.runtime_specs import DirectInjectionBudget, QueryRuntimeSpec
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)

COMMON_QUERY_RESULT = {
    "mode": "rag_retrieval",
    "records": [
        {
            "content": "Release checklist",
            "title": "Checklist",
            "knowledge_base_id": 1,
        }
    ],
    "total": 1,
    "total_estimated_tokens": 12,
}

EXPECTED_QUERY_RESPONSE = {
    "mode": "rag_retrieval",
    "records": [
        {
            "content": "Release checklist",
            "score": None,
            "title": "Checklist",
            "metadata": None,
            "knowledge_base_id": 1,
        }
    ],
    "total": 1,
    "total_estimated_tokens": 12,
    "message": None,
}


def _make_runtime_spec(
    *,
    route_mode: str = "rag_retrieval",
    knowledge_base_ids: list[int] | None = None,
    query: str = "release checklist",
    with_budget: bool = False,
    with_remote_configs: bool = False,
) -> QueryRuntimeSpec:
    knowledge_base_ids = knowledge_base_ids or [1]
    knowledge_base_configs = []
    if with_remote_configs:
        knowledge_base_configs = [
            RemoteKnowledgeBaseQueryConfig(
                knowledge_base_id=knowledge_base_ids[0],
                index_owner_user_id=8,
                retriever_config=RuntimeRetrieverConfig(
                    name="retriever-a",
                    namespace="default",
                    storage_config={
                        "type": "qdrant",
                        "url": "http://qdrant:6333",
                    },
                ),
                embedding_model_config=RuntimeEmbeddingModelConfig(
                    model_name="embed-a",
                    model_namespace="default",
                    resolved_config={"protocol": "openai"},
                ),
                retrieval_config=RuntimeRetrievalConfig(
                    top_k=20,
                    score_threshold=0.7,
                    retrieval_mode="vector",
                ),
            )
        ]

    return QueryRuntimeSpec(
        knowledge_base_ids=knowledge_base_ids,
        query=query,
        route_mode=route_mode,
        knowledge_base_configs=knowledge_base_configs,
        direct_injection_budget=(
            DirectInjectionBudget(context_window=10000) if with_budget else None
        ),
    )


def _create_delete_test_data(db: Session, user: User) -> tuple[Kind, KnowledgeDocument]:
    kb = Kind(
        user_id=user.id,
        kind="KnowledgeBase",
        name="kb-rag-remote-mode",
        namespace="default",
        json={
            "spec": {
                "name": "RAG Remote Mode KB",
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                },
            }
        },
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)

    document = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=23,
        name="release-checklist",
        file_extension="md",
        file_size=128,
        status=DocumentStatus.ENABLED,
        user_id=user.id,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="file",
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return kb, document


def test_internal_retrieve_preserves_response_shape(
    test_client: TestClient,
) -> None:
    """Test that internal retrieve endpoint returns correct response shape."""
    with (
        patch(
            "app.api.endpoints.internal.rag.RagRuntimeResolver.build_query_runtime_spec",
            return_value=_make_runtime_spec(with_remote_configs=True),
        ),
        patch(
            "app.services.rag.remote_gateway.RemoteRagGateway.query",
            new_callable=AsyncMock,
            return_value=COMMON_QUERY_RESULT,
        ) as mock_query,
    ):
        response = test_client.post(
            "/api/internal/rag/retrieve",
            json={
                "query": "release checklist",
                "knowledge_base_ids": [1],
                "route_mode": "rag_retrieval",
            },
        )

    assert response.status_code == 200
    assert response.json() == EXPECTED_QUERY_RESPONSE
    mock_query.assert_awaited_once()


def test_run_document_indexing_uses_remote_gateway() -> None:
    """Test that document indexing uses RemoteRagGateway."""
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    kb_index_info = SimpleNamespace(index_owner_user_id=3, summary_enabled=False)

    with (
        patch(
            "app.services.knowledge.indexing.resolve_kb_index_info",
            return_value=kb_index_info,
        ),
        patch(
            "app.services.knowledge.indexing.RagRuntimeResolver.build_index_runtime_spec",
            return_value=object(),
        ) as mock_build_runtime_spec,
        patch(
            "app.services.rag.remote_gateway.RemoteRagGateway.index_document",
            new_callable=AsyncMock,
            return_value={
                "status": "success",
                "indexed_count": 2,
                "index_name": "kb-1",
            },
        ) as mock_gateway,
    ):
        result = run_document_indexing(
            knowledge_base_id="1",
            attachment_id=2,
            retriever_name="retriever-1",
            retriever_namespace="default",
            embedding_model_name="embedding-1",
            embedding_model_namespace="default",
            user_id=3,
            user_name="tester",
            document_id=4,
            kb_index_info=kb_index_info,
            trigger_summary=False,
            db=db,
        )

    mock_gateway.assert_awaited_once_with(
        mock_build_runtime_spec.return_value,
        db=db,
    )
    assert result == {
        "status": "success",
        "reason": None,
        "document_id": 4,
        "knowledge_base_id": "1",
        "indexed_count": 2,
        "index_name": "kb-1",
        "chunks_data": None,
    }


def test_delete_document_uses_remote_gateway(
    test_db: Session,
    test_user: User,
) -> None:
    """Test that document deletion uses RemoteRagGateway."""
    kb, document = _create_delete_test_data(test_db, test_user)

    with (
        patch.object(
            KnowledgeService,
            "_assert_can_manage_document",
            return_value=None,
        ),
        patch.object(
            context_service,
            "delete_context",
            return_value=True,
        ),
        patch(
            "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
            return_value=object(),
        ) as mock_build_delete_runtime_spec,
        patch(
            "app.services.rag.remote_gateway.RemoteRagGateway.delete_document_index",
            new_callable=AsyncMock,
            return_value={"status": "success"},
        ) as mock_gateway,
    ):
        result = KnowledgeService.delete_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
        )

    assert result.success is True
    assert result.kb_id == kb.id
    mock_build_delete_runtime_spec.assert_called_once_with(
        db=test_db,
        knowledge_base_id=kb.id,
        document_ref=str(document.id),
        index_owner_user_id=test_user.id,
    )
    mock_gateway.assert_awaited_once_with(
        mock_build_delete_runtime_spec.return_value,
        db=test_db,
    )

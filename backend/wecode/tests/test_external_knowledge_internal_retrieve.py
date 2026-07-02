# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.api.endpoints.internal.rag import (
    InternalRetrieveRequest,
    RetrievePersistenceContext,
    internal_retrieve,
)
from app.services.knowledge.protected_mediation import (
    ProtectedKnowledgeMediationResponse,
    RestrictedSafeSummaryResult,
)
from app.services.rag.sources import ExternalKnowledgeRef, retrieval_source_registry
from wecode.config.external_knowledge_config import external_knowledge_settings
from wecode.service.external_knowledge.client import ApKnowledgeMcpClient
from wecode.service.external_knowledge.providers.ap import (
    SEARCH_CONTENT_TOOL,
    ApExternalKnowledgeProvider,
)

pytestmark = pytest.mark.usefixtures("configure_external_knowledge")


@pytest.mark.asyncio
async def test_internal_retrieve_merges_ap_records(
    test_db: Session,
):
    retrieval_source_registry.register(
        ApExternalKnowledgeProvider(external_knowledge_settings)
    )

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        return {
            "query": arguments["query"],
            "total": 1,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "matched content",
                    "title": "Plan.pdf",
                    "score": 0.8,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                }
            ],
        }

    with (
        patch.object(
            ApExternalKnowledgeProvider,
            "_resolve_employee_id",
            return_value="230473",
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        response = await internal_retrieve(
            InternalRetrieveRequest(
                query="plan",
                user_id=1,
                external_knowledge_refs=[
                    ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")
                ],
            ),
            db=test_db,
        )

    body = response.model_dump()
    assert body["total"] == 1
    assert body["records"][0]["source_type"] == "ap"
    assert body["records"][0]["source_id"] == "kb-1"
    assert body["records"][0]["source_uri"] == "ap://kb-1/doc-1"
    assert body["source_summaries"][0]["provider"] == "ap"


@pytest.mark.asyncio
async def test_internal_retrieve_blocks_ap_when_ap_knowledge_is_not_configured(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(external_knowledge_settings, "AP_KNOWLEDGE_SYSTEM_TOKEN", "")
    retrieval_source_registry.register(
        ApExternalKnowledgeProvider(external_knowledge_settings)
    )
    mock_resolve_employee = MagicMock(return_value="230473")
    mock_call = AsyncMock()

    with (
        patch.object(
            ApExternalKnowledgeProvider,
            "_resolve_employee_id",
            mock_resolve_employee,
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", mock_call),
    ):
        response = await internal_retrieve(
            InternalRetrieveRequest(
                query="plan",
                user_id=1,
                external_knowledge_refs=[
                    ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")
                ],
            ),
            db=test_db,
        )

    body = response.model_dump()
    assert body["records"] == []
    assert body["source_summaries"][0]["provider"] == "ap"
    assert body["source_summaries"][0]["ignored_source_ids"] == ["kb-1"]
    mock_resolve_employee.assert_not_called()
    mock_call.assert_not_called()


@pytest.mark.asyncio
async def test_internal_retrieve_returns_ap_records_normally_without_internal_restricted_records(
    test_db: Session,
):
    retrieval_source_registry.register(
        ApExternalKnowledgeProvider(external_knowledge_settings)
    )

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        return {
            "query": arguments["query"],
            "total": 1,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "external restricted mix content",
                    "title": "Plan.pdf",
                    "score": 0.8,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                }
            ],
        }

    with (
        patch.object(
            ApExternalKnowledgeProvider,
            "_resolve_employee_id",
            return_value="230473",
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ),
    ):
        response = await internal_retrieve(
            InternalRetrieveRequest(
                query="plan",
                user_id=1,
                external_knowledge_refs=[
                    ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")
                ],
                persistence_context=RetrievePersistenceContext(
                    user_subtask_id=1,
                    user_id=1,
                    restricted_mode=True,
                ),
            ),
            db=test_db,
        )

    body = response.model_dump()
    assert body["mode"] == "rag_retrieval"
    assert body["total"] == 1
    assert body["records"][0]["source_type"] == "ap"
    assert body["records"][0]["source_uri"] == "ap://kb-1/doc-1"
    assert body["source_summaries"][0]["provider"] == "ap"


@pytest.mark.asyncio
async def test_internal_retrieve_separates_ap_records_in_restricted_mixed_mode(
    test_db: Session,
):
    retrieval_source_registry.register(
        ApExternalKnowledgeProvider(external_knowledge_settings)
    )

    async def fake_call(self, name, arguments, employee_id):
        assert employee_id == "230473"
        assert name == SEARCH_CONTENT_TOOL
        return {
            "query": arguments["query"],
            "total": 1,
            "searched_knowledge_base_ids": ["kb-1"],
            "ignored_knowledge_base_ids": [],
            "warnings": [],
            "records": [
                {
                    "content": "external restricted mix content",
                    "title": "Plan.pdf",
                    "score": 0.8,
                    "knowledge_base_id": "kb-1",
                    "knowledge_base_name": "Quarterly",
                    "document_id": "doc-1",
                }
            ],
        }

    mediated_response = ProtectedKnowledgeMediationResponse(
        retrieval_mode="rag_retrieval",
        restricted_safe_summary=RestrictedSafeSummaryResult(
            decision="answer",
            reason="ok",
            summary="Safe internal summary",
            observations=[],
            risks=[],
            recommended_actions=[],
            answer_guidance="Use the summary only.",
            confidence="medium",
        ),
        answer_contract="Do not quote.",
        message="Protected KB material was analyzed internally.",
        total=1,
        total_estimated_tokens=12,
        records=[
            {
                "content": "internal mediated content",
                "title": "Internal.pdf",
                "knowledge_base_id": 1,
                "document_id": 10,
            }
        ],
    )

    with (
        patch.object(
            ApExternalKnowledgeProvider,
            "_resolve_employee_id",
            return_value="230473",
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
        patch(
            "app.api.endpoints.internal.rag._execute_scoped_retrieve",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [
                    {
                        "content": "secret raw content",
                        "title": "Internal.pdf",
                        "knowledge_base_id": 1,
                        "document_id": 10,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 12,
            },
        ),
        patch(
            "app.api.endpoints.internal.rag.protected_knowledge_mediator.transform",
            new_callable=AsyncMock,
            return_value=mediated_response,
        ),
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ),
    ):
        response = await internal_retrieve(
            InternalRetrieveRequest(
                query="plan",
                user_id=1,
                knowledge_base_scopes=[
                    {
                        "knowledge_base_id": 1,
                        "scope_restricted": False,
                        "document_ids": [],
                    }
                ],
                external_knowledge_refs=[
                    ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")
                ],
                persistence_context=RetrievePersistenceContext(
                    user_subtask_id=1,
                    user_id=1,
                    restricted_mode=True,
                ),
            ),
            db=test_db,
        )

    body = response.model_dump()
    assert body["mode"] == "mixed_restricted_retrieval"
    assert body["total"] == 2
    assert "records" not in body
    assert body["restricted_safe_summary"]["summary"] == "Safe internal summary"
    assert body["external_records"][0]["content"] == "external restricted mix content"
    assert body["external_records"][0]["source_type"] == "ap"
    assert body["external_records"][0]["source_uri"] == "ap://kb-1/doc-1"
    assert body["source_summaries"][0]["provider"] == "ap"


@pytest.mark.asyncio
async def test_internal_retrieve_degrades_when_ap_provider_fails(
    test_db: Session,
):
    retrieval_source_registry.register(
        ApExternalKnowledgeProvider(external_knowledge_settings)
    )

    async def fake_call(self, name, arguments, employee_id):
        raise RuntimeError("AP is unavailable")

    with (
        patch.object(
            ApExternalKnowledgeProvider,
            "_resolve_employee_id",
            return_value="230473",
        ),
        patch.object(ApKnowledgeMcpClient, "call_tool", fake_call),
    ):
        response = await internal_retrieve(
            InternalRetrieveRequest(
                query="plan",
                user_id=1,
                external_knowledge_refs=[
                    ExternalKnowledgeRef(provider="ap", mode="explicit", id="kb-1")
                ],
            ),
            db=test_db,
        )

    body = response.model_dump()
    assert body["records"] == []
    assert body["source_summaries"][0]["provider"] == "ap"
    assert body["source_summaries"][0]["ignored_source_ids"] == ["kb-1"]

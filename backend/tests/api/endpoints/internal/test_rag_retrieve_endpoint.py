# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import ANY, AsyncMock, patch


def test_internal_retrieve_returns_restricted_safe_summary(test_client):
    payload = {
        "query": "What risks do you see?",
        "knowledge_base_ids": [1],
        "runtime_context": {
            "context_window": 10000,
            "used_context_tokens": 100,
            "reserved_output_tokens": 2048,
            "context_buffer_ratio": 0.1,
            "max_direct_chunks": 500,
        },
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": True,
        },
        "mediation_context": {
            "current_model_name": "main-model",
            "current_model_namespace": "default",
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [
                    {
                        "content": "secret",
                        "title": "doc",
                        "knowledge_base_id": 1,
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 33,
            },
        ),
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
        patch(
            "app.api.endpoints.internal.rag.protected_knowledge_mediator.transform",
            new_callable=AsyncMock,
            return_value={
                "mode": "restricted_safe_summary",
                "retrieval_mode": "rag_retrieval",
                "restricted_safe_summary": {
                    "decision": "answer",
                    "reason": "ok",
                    "summary": "High-level diagnosis",
                    "observations": [],
                    "risks": [],
                    "recommended_actions": [],
                    "answer_guidance": "Stay abstract",
                    "confidence": "medium",
                },
                "answer_contract": "Do not quote.",
                "message": "Protected KB material was analyzed internally.",
                "total": 1,
                "total_estimated_tokens": 33,
            },
        ) as mock_transform,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "restricted_safe_summary"
    assert body["retrieval_mode"] == "rag_retrieval"
    mock_persist.assert_called_once()
    mock_transform.assert_awaited_once()


def test_internal_retrieve_keeps_user_subtask_id_out_of_gateway(test_client):
    payload = {
        "query": "How should we proceed?",
        "knowledge_base_ids": [1],
        "persistence_context": {
            "user_subtask_id": 11,
            "user_id": 7,
            "restricted_mode": False,
        },
    }

    with (
        patch(
            "app.api.endpoints.internal.rag.LocalRagGateway.query",
            new_callable=AsyncMock,
            return_value={
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        ) as mock_query,
        patch(
            "app.api.endpoints.internal.rag.retrieval_persistence_service.persist_retrieval_result"
        ) as mock_persist,
    ):
        response = test_client.post("/api/internal/rag/retrieve", json=payload)

    assert response.status_code == 200
    mock_query.assert_awaited_once_with(ANY, db=ANY)
    mock_persist.assert_called_once()

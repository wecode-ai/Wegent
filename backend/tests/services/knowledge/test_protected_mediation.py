# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.knowledge.protected_mediation import (
    ProtectedKnowledgeMediationService,
    RestrictedSafeSummaryResult,
)


@pytest.mark.asyncio
async def test_mediator_uses_current_model_identity_first():
    service = ProtectedKnowledgeMediationService()

    with (
        patch.object(
            service._model_resolver,
            "load_knowledge_base_snapshots",
            return_value=[
                {
                    "id": 1,
                    "name": "KB-1",
                    "summary_model_ref": {},
                }
            ],
        ) as mock_load_snapshots,
        patch.object(
            service._model_resolver,
            "resolve_model_config",
            return_value={"model_id": "gpt-4o"},
        ) as mock_resolve,
        patch.object(
            service,
            "_summarize_records",
            AsyncMock(
                return_value=RestrictedSafeSummaryResult(
                    decision="answer",
                    reason="ok",
                    summary="High-level diagnosis",
                    observations=[],
                    risks=[],
                    recommended_actions=[],
                    answer_guidance="Stay abstract",
                    confidence="medium",
                )
            ),
        ),
    ):
        db = MagicMock()
        result = await service.transform(
            db=db,
            query="What is broken?",
            retrieval_mode="rag_retrieval",
            records=[
                {
                    "content": "secret",
                    "title": "doc",
                    "knowledge_base_id": 1,
                }
            ],
            mediation_context={
                "current_model_name": "my-model",
                "current_model_namespace": "default",
            },
            knowledge_base_ids=[1],
        )

    mock_load_snapshots.assert_called_once_with(
        db=db,
        knowledge_base_ids=[1],
    )
    mock_resolve.assert_called_once_with(
        db=db,
        mediation_context={
            "current_model_name": "my-model",
            "current_model_namespace": "default",
        },
        knowledge_base_ids=[1],
        knowledge_base_snapshots=[
            {
                "id": 1,
                "name": "KB-1",
                "summary_model_ref": {},
            }
        ],
        user_id=None,
        user_name="system",
    )
    assert result.mode == "restricted_safe_summary"
    assert result.restricted_safe_summary.summary == "High-level diagnosis"


@pytest.mark.asyncio
async def test_mediator_records_fallback_trace_metadata() -> None:
    service = ProtectedKnowledgeMediationService()

    with (
        patch.object(
            service._model_resolver,
            "load_knowledge_base_snapshots",
            return_value=[],
        ),
        patch.object(
            service._model_resolver,
            "resolve_model_config",
            return_value={},
        ),
        patch.object(
            service,
            "_summarize_records",
            AsyncMock(
                return_value=RestrictedSafeSummaryResult(
                    decision="refuse",
                    reason="safe_summary_model_unavailable",
                    summary="Unavailable",
                    observations=[],
                    risks=[],
                    recommended_actions=[],
                    answer_guidance="Stay abstract",
                    confidence="low",
                )
            ),
        ),
        patch(
            "app.services.knowledge.protected_mediation.set_span_attribute"
        ) as mock_set_span_attribute,
        patch(
            "app.services.knowledge.protected_mediation.add_span_event"
        ) as mock_add_span_event,
    ):
        result = await service.transform(
            db=MagicMock(),
            query="What is broken?",
            retrieval_mode="rag_retrieval",
            records=[
                {
                    "content": "secret",
                    "title": "doc",
                    "knowledge_base_id": 1,
                }
            ],
            mediation_context=None,
            knowledge_base_ids=[1],
        )

    assert result.restricted_safe_summary.reason == "safe_summary_model_unavailable"
    assert mock_set_span_attribute.call_args_list == [
        (("knowledge.selected_model", "unresolved"),),
        (("knowledge.fallback_used", True),),
    ]
    mock_add_span_event.assert_called_once_with(
        "knowledge.model_fallback",
        {"reason": "safe_summary_model_unavailable"},
    )


@pytest.mark.asyncio
async def test_mediator_info_log_redacts_model_generated_reason(caplog) -> None:
    service = ProtectedKnowledgeMediationService()
    unsafe_reason = "contains sensitive original content"

    with (
        patch.object(
            service._model_resolver,
            "load_knowledge_base_snapshots",
            return_value=[],
        ),
        patch.object(
            service._model_resolver,
            "resolve_model_config",
            return_value={"model_id": "gpt-4o"},
        ),
        patch.object(
            service,
            "_summarize_records",
            AsyncMock(
                return_value=RestrictedSafeSummaryResult(
                    decision="refuse",
                    reason=unsafe_reason,
                    summary="Unavailable",
                    observations=[],
                    risks=[],
                    recommended_actions=[],
                    answer_guidance="Stay abstract",
                    confidence="low",
                )
            ),
        ),
        caplog.at_level(
            logging.INFO,
            logger="app.services.knowledge.protected_mediation",
        ),
    ):
        await service.transform(
            db=MagicMock(),
            query="What is broken?",
            retrieval_mode="rag_retrieval",
            records=[
                {
                    "content": "secret",
                    "title": "doc",
                    "knowledge_base_id": 1,
                }
            ],
            mediation_context=None,
            knowledge_base_ids=[1],
        )

    assert "Safe summary completed" in caplog.text
    assert unsafe_reason not in caplog.text

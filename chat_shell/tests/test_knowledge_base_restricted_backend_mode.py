# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock, patch

import pytest

from chat_shell.tools.builtin import KnowledgeBaseTool


@pytest.mark.asyncio
async def test_restricted_tool_forwards_backend_safe_summary():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        tool_access_mode="restricted_search_only",
        user_id=7,
        user_subtask_id=11,
    )

    with (
        patch.object(
            tool,
            "_retrieve_with_strategy_from_all_kbs",
            AsyncMock(
                return_value=(
                    "restricted_safe_summary",
                    {
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
                        "total_estimated_tokens": 10,
                    },
                )
            ),
        ),
        patch.object(
            tool,
            "_get_kb_info",
            AsyncMock(
                return_value={
                    "items": [
                        {
                            "id": 1,
                            "name": "Test KB",
                            "rag_enabled": True,
                            "max_calls_per_conversation": 10,
                            "exempt_calls_before_check": 5,
                        }
                    ]
                }
            ),
        ),
    ):
        result = json.loads(await tool._arun("what risks?"))

    assert result["mode"] == "restricted_safe_summary"
    assert result["restricted_safe_summary"]["summary"] == "High-level diagnosis"
    assert result["results"] == []
    assert result["sources"] == []


@pytest.mark.asyncio
async def test_mixed_restricted_tool_formats_external_records_separately():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        external_knowledge_refs=[
            {"provider": "demo", "mode": "explicit", "id": "kb-1"}
        ],
        tool_access_mode="restricted_search_only",
        user_id=7,
        user_subtask_id=11,
    )

    with (
        patch.object(
            tool,
            "_retrieve_with_strategy_from_all_kbs",
            AsyncMock(
                return_value=(
                    "mixed_restricted_retrieval",
                    {
                        "mode": "mixed_restricted_retrieval",
                        "retrieval_mode": "rag_retrieval",
                        "restricted_safe_summary": {
                            "decision": "answer",
                            "reason": "ok",
                            "summary": "High-level internal diagnosis",
                            "observations": [],
                            "risks": [],
                            "recommended_actions": [],
                            "answer_guidance": "Use only this summary for internal KB.",
                            "confidence": "medium",
                        },
                        "answer_contract": "Do not quote internal KB.",
                        "message": "Protected KB material was analyzed internally.",
                        "total": 2,
                        "records": [
                            {
                                "content": "secret raw content",
                                "title": "Internal Secret",
                                "score": 0.9,
                                "knowledge_base_id": 1,
                            }
                        ],
                        "external_records": [
                            {
                                "content": "External authorized content",
                                "title": "External Plan.pdf",
                                "score": 0.8,
                                "source_type": "demo",
                                "source_id": "kb-1",
                                "source_uri": "demo://kb-1/doc-1",
                                "source_name": "External Quarterly",
                            }
                        ],
                        "source_summaries": [
                            {
                                "provider": "demo",
                                "searched_source_ids": ["kb-1"],
                                "ignored_source_ids": [],
                                "source_statuses": [
                                    {
                                        "provider": "demo",
                                        "source_id": "kb-1",
                                        "source_name": "External Quarterly",
                                        "status": "no_hit",
                                        "record_count": 1,
                                        "citation_count": 0,
                                        "mode": "rag_retrieval",
                                    }
                                ],
                            }
                        ],
                    },
                )
            ),
        ),
        patch.object(
            tool,
            "_get_kb_info",
            AsyncMock(
                return_value={
                    "items": [
                        {
                            "id": 1,
                            "name": "Test KB",
                            "rag_enabled": True,
                            "max_calls_per_conversation": 10,
                            "exempt_calls_before_check": 5,
                        }
                    ]
                }
            ),
        ),
    ):
        raw_output = await tool._arun("what risks?")
        result = json.loads(raw_output)

    assert "secret raw content" not in raw_output
    assert result["mode"] == "mixed_restricted_retrieval"
    assert (
        result["restricted_internal"]["restricted_safe_summary"]["summary"]
        == "High-level internal diagnosis"
    )
    assert result["results"][0]["content"] == "External authorized content"
    assert result["results"][0]["source"] == "External Plan.pdf"
    assert result["sources"][0]["title"] == "External Plan.pdf"
    assert result["sources"][0]["source_uri"] == "demo://kb-1/doc-1"
    assert result["retrieval_summary"]["searched_source_ids"] == ["kb-1"]
    external_status = next(
        status
        for status in result["retrieval_summary"]["source_statuses"]
        if status["provider"] == "demo" and status["source_id"] == "kb-1"
    )
    assert external_status["status"] == "hit"
    assert external_status["citation_count"] == 1

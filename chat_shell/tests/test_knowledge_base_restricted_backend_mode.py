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

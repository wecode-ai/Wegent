# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin import KnowledgeBaseTool


def test_knowledge_base_input_supports_document_names():
    from chat_shell.tools.builtin.knowledge_base import KnowledgeBaseInput

    payload = KnowledgeBaseInput(
        query="checklist",
        max_results=5,
        document_names=["release.md"],
    )

    assert payload.document_names == ["release.md"]


@pytest.mark.asyncio
async def test_http_mode_forwards_document_names_and_ids():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1, 2],
        user_id=7,
    )
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "mode": "rag_retrieval",
        "records": [],
        "total": 0,
        "total_estimated_tokens": 0,
    }

    with (
        patch("httpx.AsyncClient") as mock_client,
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
        post = AsyncMock(return_value=mock_response)
        mock_client.return_value.__aenter__.return_value.post = post

        await tool._arun(
            query="release checklist",
            max_results=8,
            document_ids=[101],
            document_names=["release.md"],
        )

    payload = post.call_args.kwargs["json"]
    assert payload["document_ids"] == [101]
    assert payload["document_names"] == ["release.md"]


@pytest.mark.asyncio
async def test_arun_preserves_backend_scoped_search_error_message():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        user_id=7,
    )

    with (
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
        patch.object(
            tool,
            "_retrieve_with_strategy_from_all_kbs",
            AsyncMock(
                return_value=(
                    "rag_retrieval",
                    {
                        "mode": "rag_retrieval",
                        "records": [],
                        "total": 0,
                        "message": "Document names not found in the selected knowledge bases. Use kb_ls to inspect available documents first.",
                    },
                )
            ),
        ),
    ):
        result = json.loads(await tool._arun(query="release checklist"))

    assert result["message"].startswith("Document names not found")


@pytest.mark.asyncio
async def test_arun_passes_scoped_filters_without_mutating_tool_defaults():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        user_id=7,
        document_ids=[999],
        document_names=["default.md"],
    )

    async def _fake_retrieve(**kwargs):
        assert kwargs["document_ids"] == [101]
        assert kwargs["document_names"] == ["release.md"]
        assert tool.document_ids == [999]
        assert tool.document_names == ["default.md"]
        return (
            "rag_retrieval",
            {
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            },
        )

    with (
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
        patch.object(
            tool,
            "_retrieve_with_strategy_from_all_kbs",
            AsyncMock(side_effect=_fake_retrieve),
        ),
    ):
        await tool._arun(
            query="release checklist",
            document_ids=[101],
            document_names=["release.md"],
        )

    assert tool.document_ids == [999]
    assert tool.document_names == ["default.md"]

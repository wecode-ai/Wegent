# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin import KnowledgeBaseTool, ScopedKnowledgeBaseTool
from shared.models.knowledge import KnowledgeBaseScope


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
async def test_arun_unscoped_passes_call_filters_without_mutating_tool_defaults():
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


@pytest.mark.asyncio
async def test_unrestricted_scopes_do_not_block_per_call_document_filters():
    """Unrestricted per-KB scopes should preserve legacy document filter behavior."""
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        knowledge_base_scopes=[
            KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=False)
        ],
        db_session=MagicMock(),
    )

    with (
        patch.object(
            tool,
            "_retrieve_with_scopes_package_mode",
            AsyncMock(),
        ) as scoped_retrieve,
        patch.object(
            tool,
            "_retrieve_with_strategy_via_http",
            AsyncMock(
                return_value={
                    "mode": "rag_retrieval",
                    "records": [],
                    "total": 0,
                    "total_estimated_tokens": 0,
                }
            ),
        ) as http_retrieve,
    ):
        await tool._retrieve_with_strategy_from_all_kbs(
            query="release checklist",
            max_results=8,
            document_ids=[101],
            document_names=["release.md"],
        )

    scoped_retrieve.assert_not_awaited()
    http_retrieve.assert_awaited_once()
    assert http_retrieve.await_args.kwargs["document_ids"] == [101]
    assert http_retrieve.await_args.kwargs["document_names"] == ["release.md"]


def test_scoped_tool_schema_hides_document_filters():
    """Scoped search should not expose document override arguments to the model."""
    schema = ScopedKnowledgeBaseTool().args_schema.model_json_schema()

    assert "document_ids" not in schema["properties"]
    assert "document_names" not in schema["properties"]


@pytest.mark.asyncio
async def test_scoped_arun_rejects_per_call_document_filters():
    """Scoped search must reject attempts to override the configured scope."""
    tool = ScopedKnowledgeBaseTool(
        knowledge_base_ids=[1],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=1,
                scope_restricted=True,
                document_ids=[101],
            )
        ],
        user_id=7,
    )

    result = json.loads(await tool._arun(query="release checklist", document_ids=[999]))

    assert result["error_code"] == "document_scope_violation"


@pytest.mark.asyncio
async def test_scoped_arun_ignores_instance_legacy_document_filters():
    """Configured scope documents must not be mistaken for per-call filters."""
    tool = ScopedKnowledgeBaseTool(
        knowledge_base_ids=[1],
        document_ids=[101],
        document_names=["legacy.md"],
        knowledge_base_scopes=[
            KnowledgeBaseScope(
                knowledge_base_id=1,
                scope_restricted=True,
                document_ids=[101],
            )
        ],
        user_id=7,
    )

    async def _fake_retrieve(**kwargs):
        assert kwargs["document_ids"] == []
        assert kwargs["document_names"] == []
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
                            "name": "Scoped KB",
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
        result = json.loads(await tool._arun(query="release checklist"))

    assert result["count"] == 0
    assert "error" not in result

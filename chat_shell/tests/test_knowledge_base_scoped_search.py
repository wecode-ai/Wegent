# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import sys
from types import ModuleType, SimpleNamespace
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


@pytest.mark.asyncio
async def test_default_kb_search_ignores_per_call_document_filters():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        default_knowledge_base_ids=[1],
        knowledge_base_scopes=[
            KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=False)
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
                            "name": "Default KB",
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


@pytest.mark.asyncio
async def test_default_kb_without_rag_does_not_suggest_exploration_tools():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1],
        default_knowledge_base_ids=[1],
        user_id=7,
    )

    with patch.object(
        tool,
        "_get_kb_info",
        AsyncMock(
            return_value={
                "items": [
                    {
                        "id": 1,
                        "name": "Default KB",
                        "rag_enabled": False,
                        "max_calls_per_conversation": 10,
                        "exempt_calls_before_check": 5,
                    }
                ]
            }
        ),
    ):
        result = json.loads(await tool._arun(query="release checklist"))

    assert result["error_code"] == "rag_not_configured_default_search_only"
    assert "knowledge_base_search cannot retrieve content" in result["message"]
    assert "kb_ls" not in result["message"]
    assert "kb_head" not in result["message"]
    assert "Use kb_ls" not in result["suggestion"]
    assert "use kb_ls" not in result["suggestion"]
    assert "then use kb_head" not in result["suggestion"]
    assert "do not expose kb_ls or kb_head" in result["suggestion"]


@pytest.mark.asyncio
async def test_mixed_default_and_explicit_kbs_without_rag_suggests_explicit_kb():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1, 2],
        default_knowledge_base_ids=[1],
        user_id=7,
    )

    with patch.object(
        tool,
        "_get_kb_info",
        AsyncMock(
            return_value={
                "items": [
                    {
                        "id": 1,
                        "name": "Default KB",
                        "rag_enabled": False,
                        "max_calls_per_conversation": 10,
                        "exempt_calls_before_check": 5,
                    },
                    {
                        "id": 2,
                        "name": "Explicit KB",
                        "rag_enabled": False,
                        "max_calls_per_conversation": 10,
                        "exempt_calls_before_check": 5,
                    },
                ]
            }
        ),
    ):
        result = json.loads(await tool._arun(query="release checklist"))

    assert result["error_code"] == "rag_not_configured"
    assert "kb_ls(knowledge_base_id=2)" in result["suggestion"]
    assert "kb_ls(knowledge_base_id=1)" not in result["suggestion"]


@pytest.mark.asyncio
async def test_mixed_default_and_explicit_kbs_split_per_call_filters():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1, 2, 3],
        default_knowledge_base_ids=[1],
        knowledge_base_scopes=[
            KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=False),
            KnowledgeBaseScope(knowledge_base_id=2, scope_restricted=False),
            KnowledgeBaseScope(knowledge_base_id=3, scope_restricted=False),
        ],
        user_id=7,
    )
    calls: list[dict] = []

    async def _fake_retrieve(**kwargs):
        active_kb_ids = kwargs["knowledge_base_ids"]
        calls.append(
            {
                "knowledge_base_ids": list(active_kb_ids),
                "document_ids": kwargs["document_ids"],
                "document_names": kwargs["document_names"],
            }
        )
        records = [
            {
                "knowledge_base_id": kb_id,
                "content": f"result-{kb_id}",
                "score": 0.9 - index * 0.1,
            }
            for index, kb_id in enumerate(active_kb_ids)
        ]
        return {
            "mode": "rag_retrieval",
            "records": records,
            "total": len(records),
            "total_estimated_tokens": len(records),
        }

    with patch.object(
        tool,
        "_retrieve_with_strategy_via_http",
        AsyncMock(side_effect=_fake_retrieve),
    ):
        mode, result = await tool._retrieve_with_strategy_from_all_kbs(
            query="release checklist",
            max_results=8,
            document_ids=[201, 301],
            document_names=["b1.md", "c1.md"],
        )

    assert mode == "rag_only"
    assert [record["knowledge_base_id"] for record in result["records"]] == [1, 2, 3]
    assert calls == [
        {
            "knowledge_base_ids": [1],
            "document_ids": None,
            "document_names": None,
        },
        {
            "knowledge_base_ids": [2, 3],
            "document_ids": [201, 301],
            "document_names": ["b1.md", "c1.md"],
        },
    ]
    assert tool.knowledge_base_ids == [1, 2, 3]
    assert tool.default_knowledge_base_ids == [1]


@pytest.mark.asyncio
async def test_explicit_empty_kb_ids_do_not_fall_back_to_tool_kbs():
    tool = KnowledgeBaseTool(knowledge_base_ids=[1, 2], user_id=7)

    with patch.object(
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
    ) as retrieve:
        await tool._retrieve_with_strategy_from_all_kbs(
            query="release checklist",
            max_results=8,
            knowledge_base_ids=[],
        )

    assert retrieve.call_args.kwargs["knowledge_base_ids"] == []


@pytest.mark.asyncio
async def test_mixed_default_and_explicit_kbs_merge_sort_and_truncate_results():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1, 2],
        default_knowledge_base_ids=[1],
        knowledge_base_scopes=[
            KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=False),
            KnowledgeBaseScope(knowledge_base_id=2, scope_restricted=False),
        ],
        user_id=7,
    )

    async def _fake_retrieve(**kwargs):
        if kwargs["knowledge_base_ids"] == [1]:
            records = [
                {"knowledge_base_id": 1, "content": "default-high", "score": 0.95},
                {"knowledge_base_id": 1, "content": "default-low", "score": 0.2},
            ]
        else:
            records = [
                {"knowledge_base_id": 2, "content": "explicit-mid", "score": 0.8},
                {"knowledge_base_id": 2, "content": "explicit-low", "score": 0.1},
            ]
        return {
            "mode": "rag_retrieval",
            "records": records,
            "total": len(records),
            "total_estimated_tokens": len(records),
        }

    with patch.object(
        tool,
        "_retrieve_with_strategy_via_http",
        AsyncMock(side_effect=_fake_retrieve),
    ):
        _mode, result = await tool._retrieve_with_strategy_from_all_kbs(
            query="release checklist",
            max_results=2,
            document_ids=[201],
        )

    assert [
        (record["knowledge_base_id"], record["content"]) for record in result["records"]
    ] == [
        (1, "default-high"),
        (2, "explicit-mid"),
    ]
    assert result["total"] == 2


@pytest.mark.asyncio
async def test_scoped_package_mediation_uses_active_scope_kb_ids():
    tool = KnowledgeBaseTool(
        knowledge_base_ids=[1, 2],
        knowledge_base_scopes=[
            KnowledgeBaseScope(knowledge_base_id=1, scope_restricted=False),
            KnowledgeBaseScope(knowledge_base_id=2, scope_restricted=False),
        ],
        tool_access_mode="restricted_search_only",
        db_session=MagicMock(),
        user_id=7,
    )
    active_scopes = [KnowledgeBaseScope(knowledge_base_id=2, scope_restricted=False)]
    retrieval_service = MagicMock()
    retrieval_service.retrieve_with_routing = AsyncMock(
        return_value={
            "mode": "rag_retrieval",
            "records": [{"knowledge_base_id": 2, "content": "active"}],
            "total": 1,
            "total_estimated_tokens": 1,
        }
    )
    mediator = MagicMock()
    mediator.transform = AsyncMock(
        return_value=SimpleNamespace(
            model_dump=lambda: {
                "mode": "rag_retrieval",
                "records": [{"knowledge_base_id": 2, "content": "mediated"}],
                "total": 1,
                "total_estimated_tokens": 1,
            }
        )
    )
    app_module = ModuleType("app")
    services_module = ModuleType("app.services")
    rag_module = ModuleType("app.services.rag")
    retrieval_module = ModuleType("app.services.rag.retrieval_service")
    retrieval_module.RetrievalService = MagicMock(return_value=retrieval_service)
    knowledge_module = ModuleType("app.services.knowledge")
    mediation_module = ModuleType("app.services.knowledge.protected_mediation")
    mediation_module.protected_knowledge_mediator = mediator

    with patch.dict(
        sys.modules,
        {
            "app": app_module,
            "app.services": services_module,
            "app.services.rag": rag_module,
            "app.services.rag.retrieval_service": retrieval_module,
            "app.services.knowledge": knowledge_module,
            "app.services.knowledge.protected_mediation": mediation_module,
        },
    ):
        await tool._retrieve_with_scopes_package_mode(
            query="release checklist",
            max_results=8,
            route_mode="auto",
            knowledge_base_scopes=active_scopes,
        )

    retrieval_service.retrieve_with_routing.assert_awaited_once()
    assert retrieval_service.retrieve_with_routing.call_args.kwargs[
        "knowledge_base_ids"
    ] == [2]
    mediator.transform.assert_awaited_once()
    assert mediator.transform.call_args.kwargs["knowledge_base_ids"] == [2]


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

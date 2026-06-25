# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin.knowledge_listing import (
    KbHeadTool,
    KbLsTool,
    KnowledgeListDocumentsTool,
)
from shared.models.knowledge import KnowledgeBaseScope


class TestKbLsTool:
    @pytest.mark.asyncio
    async def test_http_mode_lists_docs_with_pagination(self) -> None:
        """HTTP mode should pass offset/limit and surface pagination metadata."""
        tool = KbLsTool(knowledge_base_ids=[3])
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "documents": [
                {
                    "id": 101,
                    "name": "doc-101",
                    "file_extension": "md",
                    "file_size": 2048,
                    "short_summary": "summary",
                    "is_active": True,
                }
            ],
            "total": 5,
            "returned_count": 1,
            "offset": 2,
            "limit": 1,
            "has_more": True,
        }

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__.return_value.post = post

            result = await tool._arun(knowledge_base_id=3, offset=2, limit=1)

        post.assert_awaited_once()
        args, kwargs = post.await_args
        assert args == ("http://backend/api/internal/rag/list-docs",)
        assert kwargs["json"] == {"knowledge_base_id": 3, "offset": 2, "limit": 1}
        auth_header = kwargs["headers"]["Authorization"]
        assert auth_header.startswith("Bearer ")
        assert auth_header.removeprefix("Bearer ").strip()

        data = json.loads(result)
        assert data["total"] == 5
        assert data["returned_count"] == 1
        assert data["offset"] == 2
        assert data["limit"] == 1
        assert data["has_more"] is True
        assert data["documents"][0]["id"] == 101

    @pytest.mark.asyncio
    async def test_http_mode_forwards_scoped_list_docs(self) -> None:
        """Scoped listing should pass per-KB scopes to Backend."""
        tool = KbLsTool(
            knowledge_base_ids=[3],
            knowledge_base_scopes=[
                KnowledgeBaseScope(
                    knowledge_base_id=3,
                    scope_restricted=True,
                    document_ids=[101],
                )
            ],
        )
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "documents": [],
            "total": 0,
            "returned_count": 0,
            "offset": 0,
            "limit": 20,
            "has_more": False,
        }

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__.return_value.post = post

            await tool._arun(knowledge_base_id=3)

        payload = post.call_args.kwargs["json"]
        assert payload["knowledge_base_scopes"] == [
            {
                "knowledge_base_id": 3,
                "scope_restricted": True,
                "document_ids": [101],
            }
        ]

    @pytest.mark.asyncio
    async def test_package_mode_rejects_kb_outside_scope(self) -> None:
        """Package mode should fail closed when scopes omit the requested KB."""
        fake_app = types.ModuleType("app")
        fake_models = types.ModuleType("app.models")
        fake_knowledge = types.ModuleType("app.models.knowledge")
        fake_knowledge.KnowledgeDocument = type(
            "KnowledgeDocument",
            (),
            {"kind_id": MagicMock()},
        )
        tool = KbLsTool(
            knowledge_base_ids=[3, 4],
            knowledge_base_scopes=[
                KnowledgeBaseScope(
                    knowledge_base_id=3,
                    scope_restricted=True,
                    document_ids=[101],
                )
            ],
            db_session=MagicMock(),
        )

        with patch.dict(
            sys.modules,
            {
                "app": fake_app,
                "app.models": fake_models,
                "app.models.knowledge": fake_knowledge,
            },
        ):
            result = json.loads(
                await tool._list_docs_package_mode(
                    knowledge_base_id=4, offset=0, limit=20
                )
            )

        assert result["error_code"] == "document_scope_violation"


class TestKnowledgeListDocumentsTool:
    @pytest.mark.asyncio
    async def test_lists_internal_and_external_documents_together(self) -> None:
        """Mounted internal and external sources should be visible in one listing."""
        tool = KnowledgeListDocumentsTool(
            knowledge_base_ids=[107],
            external_knowledge_refs=[
                {
                    "provider": "demo",
                    "id": "demo-kb-1",
                    "name": "External Demo",
                    "scope": "organization",
                    "mode": "explicit",
                }
            ],
            user_id=2,
            user_name="wuhua3",
            auth_token="user-token",
        )
        internal_response = MagicMock()
        internal_response.status_code = 200
        internal_response.json.return_value = {
            "documents": [
                {
                    "id": 501,
                    "name": "api-reference.md",
                    "file_extension": "md",
                    "file_size": 128,
                    "short_summary": "internal summary",
                    "is_active": True,
                }
            ],
            "total": 1,
            "returned_count": 1,
            "offset": 0,
            "limit": 20,
            "has_more": False,
        }
        external_response = MagicMock()
        external_response.status_code = 200
        external_response.json.return_value = {
            "documents": [
                {
                    "provider": "demo",
                    "source_id": "demo-kb-1",
                    "source_name": "External Demo",
                    "document_id": "document:demo-doc-1",
                    "title": "external-summary.csv",
                    "node_id": "document:demo-doc-1",
                    "file_extension": "csv",
                }
            ],
            "total_returned": 1,
            "warnings": [],
        }

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(side_effect=[internal_response, external_response])
            mock_client.return_value.__aenter__.return_value.post = post

            result = json.loads(await tool._arun())

        assert post.await_count == 2
        assert post.await_args_list[0].args == (
            "http://backend/api/internal/rag/list-docs",
        )
        assert post.await_args_list[0].kwargs["json"] == {
            "knowledge_base_id": 107,
            "offset": 0,
            "limit": 20,
        }
        assert post.await_args_list[1].args == (
            "http://backend/api/internal/knowledge/list-documents",
        )
        assert post.await_args_list[1].kwargs["json"] == {
            "external_knowledge_refs": [
                {
                    "provider": "demo",
                    "id": "demo-kb-1",
                    "name": "External Demo",
                    "scope": "organization",
                    "mode": "explicit",
                }
            ],
            "user_id": 2,
            "limit": 20,
            "offset": 0,
            "user_name": "wuhua3",
        }
        assert result["internal_returned"] == 1
        assert result["external_returned"] == 1
        assert result["pagination_scope"] == "per_source"
        assert result["must_include_all_selected_sources"] is True
        assert "selected sources with zero documents" in result["answer_hint"]
        assert result["selected_sources"] == [
            {
                "provider": "internal",
                "source_id": "107",
                "source_name": "KB-107",
                "document_count": 1,
                "documents": [
                    {
                        "document_id": 501,
                        "title": "api-reference.md",
                        "node_id": "document:501",
                        "parent_id": None,
                        "file_extension": "md",
                        "source_uri": None,
                    }
                ],
            },
            {
                "provider": "demo",
                "source_id": "demo-kb-1",
                "source_name": "External Demo",
                "scope": "organization",
                "mode": "explicit",
                "document_count": 1,
                "documents": [
                    {
                        "document_id": "document:demo-doc-1",
                        "title": "external-summary.csv",
                        "node_id": "document:demo-doc-1",
                        "parent_id": None,
                        "file_extension": "csv",
                        "source_uri": None,
                    }
                ],
            },
        ]
        assert result["documents"] == [
            {
                "provider": "internal",
                "source_id": "107",
                "source_name": "KB-107",
                "document_id": 501,
                "title": "api-reference.md",
                "node_id": "document:501",
                "parent_id": None,
                "mime_type": None,
                "file_extension": "md",
                "source_uri": None,
                "summary": "internal summary",
            },
            {
                "provider": "demo",
                "source_id": "demo-kb-1",
                "source_name": "External Demo",
                "document_id": "document:demo-doc-1",
                "title": "external-summary.csv",
                "node_id": "document:demo-doc-1",
                "file_extension": "csv",
            },
        ]

    @pytest.mark.asyncio
    async def test_surfaces_external_listing_error_when_internal_documents_exist(self) -> None:
        """Partial listing success should still report failed external sources."""
        tool = KnowledgeListDocumentsTool(
            knowledge_base_ids=[107],
            external_knowledge_refs=[{"provider": "demo", "id": "demo-kb-1"}],
            user_id=2,
            auth_token="user-token",
        )
        internal_response = MagicMock()
        internal_response.status_code = 200
        internal_response.json.return_value = {
            "documents": [{"id": 501, "name": "api-reference.md"}],
        }
        external_response = MagicMock()
        external_response.status_code = 503
        external_response.text = "provider unavailable"

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(side_effect=[internal_response, external_response])
            mock_client.return_value.__aenter__.return_value.post = post

            result = json.loads(await tool._arun())

        assert result["internal_returned"] == 1
        assert result["external_returned"] == 0
        assert result["warnings"] == [
            {
                "type": "external_listing_failed",
                "message": "Failed to list knowledge documents",
                "status_code": 503,
            }
        ]

    def test_description_prefers_unified_listing_over_kb_ls(self) -> None:
        """Tool metadata should route file-list requests away from internal-only kb_ls."""
        description = KnowledgeListDocumentsTool().description

        assert "Prefer this over kb_ls" in description
        assert "kb_ls only lists internal knowledge bases" in description
        assert "sources with zero documents" in description

    @pytest.mark.asyncio
    async def test_external_listing_error_remains_json_response(self) -> None:
        """Provider listing errors should not break the tool response shape."""
        tool = KnowledgeListDocumentsTool(
            external_knowledge_refs=[{"provider": "demo", "id": "demo-kb-1"}],
            user_id=2,
        )
        external_response = MagicMock()
        external_response.status_code = 503
        external_response.text = "provider unavailable"

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(return_value=external_response)
            mock_client.return_value.__aenter__.return_value.post = post

            result = json.loads(await tool._arun())

        assert result == {
            "error": "Failed to list knowledge documents",
            "status_code": 503,
        }


class TestKbHeadTool:
    @pytest.mark.asyncio
    async def test_http_mode_reads_docs_via_backend_batch_endpoint(self) -> None:
        """HTTP mode should delegate reading and persistence to Backend /read-docs."""
        tool = KbHeadTool(
            knowledge_base_ids=[3, 4],
            user_id=7,
            user_subtask_id=8,
        )
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "documents": [
                {
                    "id": 101,
                    "name": "doc-101",
                    "content": "content",
                    "total_length": 100,
                    "offset": 12,
                    "returned_length": 20,
                    "has_more": True,
                    "kb_id": 3,
                }
            ],
            "total": 1,
        }

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__.return_value.post = post

            result = await tool._arun(document_ids=[101], offset=12, limit=20)

        post.assert_awaited_once()
        args, kwargs = post.await_args
        assert args == ("http://backend/api/internal/rag/read-docs",)
        assert kwargs["json"] == {
            "document_ids": [101],
            "offset": 12,
            "limit": 20,
            "knowledge_base_ids": [3, 4],
            "persistence_context": {
                "user_subtask_id": 8,
                "user_id": 7,
                "restricted_mode": False,
            },
        }
        auth_header = kwargs["headers"]["Authorization"]
        assert auth_header.startswith("Bearer ")
        assert auth_header.removeprefix("Bearer ").strip()

        data = json.loads(result)
        assert data["documents"][0]["id"] == 101
        assert data["documents"][0]["offset"] == 12

    @pytest.mark.asyncio
    async def test_http_mode_skips_persistence_context_without_valid_user(self) -> None:
        """Backend persistence metadata should be omitted when user identity is absent."""
        tool = KbHeadTool(
            knowledge_base_ids=[3],
            user_id=0,
            user_subtask_id=8,
        )
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"documents": [], "total": 0}

        with (
            patch(
                "chat_shell.tools.builtin.knowledge_listing._get_backend_url",
                return_value="http://backend",
            ),
            patch("httpx.AsyncClient") as mock_client,
        ):
            post = AsyncMock(return_value=mock_response)
            mock_client.return_value.__aenter__.return_value.post = post

            await tool._arun(document_ids=[101], offset=0, limit=50)

        post.assert_awaited_once()
        payload = post.call_args.kwargs["json"]
        assert payload == {
            "document_ids": [101],
            "offset": 0,
            "limit": 50,
            "knowledge_base_ids": [3],
        }

    @pytest.mark.asyncio
    async def test_arun_rejects_requests_without_kb_scope(self) -> None:
        """Tool should fail closed when no KB scope is configured."""
        tool = KbHeadTool(
            knowledge_base_ids=[],
            user_id=7,
            user_subtask_id=8,
        )

        result = await tool._arun(document_ids=[101], offset=0, limit=20)

        assert json.loads(result) == {
            "error": "No accessible knowledge bases configured"
        }

    @pytest.mark.asyncio
    async def test_arun_rejects_out_of_scope_document_ids(self) -> None:
        """Scoped-only kb_head should reject out-of-scope documents before IO."""
        tool = KbHeadTool(
            knowledge_base_ids=[3],
            knowledge_base_scopes=[
                KnowledgeBaseScope(
                    knowledge_base_id=3,
                    scope_restricted=True,
                    document_ids=[101],
                )
            ],
            user_id=7,
            user_subtask_id=8,
        )

        result = json.loads(await tool._arun(document_ids=[999]))

        assert result["error_code"] == "document_scope_violation"

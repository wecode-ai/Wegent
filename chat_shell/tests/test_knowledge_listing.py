# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from chat_shell.tools.builtin.knowledge_listing import KbHeadTool


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

        post.assert_awaited_once_with(
            "http://backend/api/internal/rag/read-docs",
            json={
                "document_ids": [101],
                "offset": 12,
                "limit": 20,
                "knowledge_base_ids": [3, 4],
                "persistence_context": {
                    "user_subtask_id": 8,
                    "user_id": 7,
                    "restricted_mode": False,
                },
            },
        )

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

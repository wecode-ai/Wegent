# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

import pytest


@pytest.mark.unit
class TestGetAllChunksFromKnowledgeBase:
    @pytest.mark.asyncio
    async def test_get_all_chunks_without_user_auth_check(self):
        """Internal all-chunks should work without passing a request user."""
        from app.services.rag.retrieval_service import RetrievalService

        kb = MagicMock()
        kb.id = 123
        kb.name = "KB"
        kb.namespace = "team-a"
        kb.user_id = 42
        kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "retriever-a",
                    "retriever_namespace": "default",
                }
            }
        }

        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = kb

        mock_backend = MagicMock()
        mock_backend.get_index_name.return_value = "kb-index"
        mock_backend.get_all_chunks.return_value = [
            {"content": "chunk", "title": "doc-1", "doc_ref": "1"}
        ]

        with patch(
            "app.services.rag.retrieval_service.retriever_kinds_service.get_retriever",
            return_value=MagicMock(),
        ):
            with patch(
                "app.services.rag.retrieval_service.create_storage_backend",
                return_value=mock_backend,
            ):
                result = await RetrievalService().get_all_chunks_from_knowledge_base(
                    knowledge_base_id=123,
                    db=db,
                    max_chunks=50,
                    query="debug query",
                )

        assert result == [{"content": "chunk", "title": "doc-1", "doc_ref": "1"}]
        mock_backend.get_index_name.assert_called_once_with("123", user_id=42)
        mock_backend.get_all_chunks.assert_called_once_with(
            knowledge_id="123",
            max_chunks=50,
            user_id=42,
        )

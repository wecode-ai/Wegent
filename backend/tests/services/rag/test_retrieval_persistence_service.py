# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from unittest.mock import MagicMock, patch

import pytest

from app.services.context.context_service import context_service
from app.services.rag.retrieval_persistence_service import RetrievalPersistenceService


@pytest.mark.unit
class TestRetrievalPersistenceService:
    def setup_method(self) -> None:
        self.service = RetrievalPersistenceService()

    def test_build_extracted_text_includes_content_for_normal_mode(self) -> None:
        """Normal persistence should keep chunk content and sources."""
        result = self.service._build_extracted_text(
            kb_id=1,
            chunks=[
                {
                    "content": "test content",
                    "source": "doc.md",
                    "score": 0.85,
                    "knowledge_base_id": 1,
                    "source_index": 1,
                }
            ],
            sources=[{"index": 1, "title": "doc.md", "kb_id": 1}],
            restricted_mode=False,
        )

        data = json.loads(result)
        assert data["chunks"][0]["content"] == "test content"
        assert data["chunks"][0]["source"] == "doc.md"
        assert data["sources"][0]["title"] == "doc.md"

    def test_build_extracted_text_omits_content_for_restricted_mode(self) -> None:
        """Restricted persistence should redact raw chunk content."""
        result = self.service._build_extracted_text(
            kb_id=1,
            chunks=[
                {
                    "content": "sensitive original content",
                    "source": "Source 1",
                    "score": 0.85,
                    "knowledge_base_id": 1,
                    "source_index": 1,
                }
            ],
            sources=[{"index": 1, "title": "Source 1", "kb_id": 1}],
            restricted_mode=True,
        )

        data = json.loads(result)
        assert data["restricted_mode"] is True
        assert "original content withheld" in data["message"].lower()
        assert "content" not in data["chunks"][0]
        assert "sensitive original content" not in result

    def test_persist_retrieval_result_creates_context_for_missing_record(self) -> None:
        """Persistence should auto-create KB context when it does not exist."""
        db = MagicMock()
        records = [
            {
                "content": "chunk 1",
                "title": "doc.md",
                "score": 0.9,
                "knowledge_base_id": 7,
            },
            {
                "content": "chunk 2",
                "title": "doc.md",
                "score": 0.8,
                "knowledge_base_id": 7,
            },
        ]

        mock_get_context_map = MagicMock(return_value={})
        mock_create_context = MagicMock(return_value=MagicMock(id=101))

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            create_knowledge_base_context_with_result=mock_create_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=12,
                user_id=34,
                query="search query",
                mode="rag_retrieval",
                records=records,
                restricted_mode=False,
            )

        mock_create_context.assert_called_once()
        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=12,
            knowledge_ids=[7],
        )
        result_data = mock_create_context.call_args.kwargs["result_data"]
        assert result_data["query"] == "search query"
        assert result_data["injection_mode"] == "rag_retrieval"
        assert result_data["chunks_count"] == 2
        assert len(result_data["sources"]) == 1
        extracted = json.loads(result_data["extracted_text"])
        assert len(extracted["chunks"]) == 2
        assert extracted["chunks"][0]["source_index"] == 1

    def test_persist_retrieval_result_updates_existing_context_for_direct_injection(
        self,
    ) -> None:
        """Direct injection persistence should update context without extracted text."""
        db = MagicMock()
        records = [
            {
                "content": "full content",
                "title": "doc.md",
                "score": None,
                "knowledge_base_id": 9,
            }
        ]
        existing_context = MagicMock(id=88)

        mock_get_context_map = MagicMock(return_value={9: existing_context})
        mock_update_context = MagicMock()

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            update_knowledge_base_retrieval_result=mock_update_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=66,
                user_id=77,
                query="search query",
                mode="direct_injection",
                records=records,
                restricted_mode=True,
            )

        mock_update_context.assert_called_once()
        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=66,
            knowledge_ids=[9],
        )
        update_kwargs = mock_update_context.call_args.kwargs
        assert update_kwargs["context_id"] == 88
        assert update_kwargs["extracted_text"] == ""
        assert update_kwargs["restricted_mode"] is True
        assert update_kwargs["sources"][0]["title"] == "Source 1"

    def test_persist_retrieval_result_skips_zero_user_id(self) -> None:
        """Persistence should skip sentinel user_id=0."""
        db = MagicMock()

        mock_get_context_map = MagicMock()
        mock_create_context = MagicMock()
        mock_update_context = MagicMock()

        with patch.multiple(
            context_service,
            get_knowledge_base_context_map_by_subtask=mock_get_context_map,
            create_knowledge_base_context_with_result=mock_create_context,
            update_knowledge_base_retrieval_result=mock_update_context,
        ):
            self.service.persist_retrieval_result(
                db=db,
                user_subtask_id=12,
                user_id=0,
                query="search query",
                mode="rag_retrieval",
                records=[
                    {
                        "content": "chunk 1",
                        "title": "doc.md",
                        "score": 0.9,
                        "knowledge_base_id": 7,
                    }
                ],
                restricted_mode=False,
            )

        mock_get_context_map.assert_not_called()
        mock_create_context.assert_not_called()
        mock_update_context.assert_not_called()

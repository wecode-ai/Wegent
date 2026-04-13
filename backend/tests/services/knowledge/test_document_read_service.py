# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services.context.context_service import context_service
from app.services.knowledge.document_read_service import DocumentReadService


@pytest.mark.unit
class TestDocumentReadService:
    def setup_method(self) -> None:
        self.service = DocumentReadService()

    def test_read_documents_persists_once_per_knowledge_base(self) -> None:
        """kb_head persistence should batch documents by KB within one tool call."""
        db = MagicMock()
        documents = {
            11: SimpleNamespace(id=11, name="doc-11", attachment_id=101, kind_id=1),
            12: SimpleNamespace(id=12, name="doc-12", attachment_id=102, kind_id=1),
            21: SimpleNamespace(id=21, name="doc-21", attachment_id=201, kind_id=2),
        }
        attachments = {
            101: SimpleNamespace(id=101, extracted_text="abcdefghijk"),
            102: SimpleNamespace(id=102, extracted_text="lmnopqrstuv"),
            201: SimpleNamespace(id=201, extracted_text="wxyz0123456"),
        }
        existing_context = MagicMock(id=900)
        mock_get_context_map = MagicMock()
        mock_create_context = MagicMock()
        mock_update_context = MagicMock()

        with (
            patch.object(self.service, "_load_documents", return_value=documents),
            patch.object(
                self.service,
                "_load_attachment_contexts",
                return_value=attachments,
            ),
            patch.multiple(
                context_service,
                get_knowledge_base_context_map_by_subtask=mock_get_context_map,
                create_knowledge_base_context_with_result=mock_create_context,
                update_knowledge_base_kb_head_result=mock_update_context,
            ),
        ):
            mock_get_context_map.return_value = {2: existing_context}

            results = self.service.read_documents(
                db=db,
                document_ids=[11, 12, 21],
                offset=2,
                limit=4,
                knowledge_base_ids=[1, 2],
                user_subtask_id=77,
                user_id=88,
            )

        assert [result["id"] for result in results] == [11, 12, 21]
        assert [result["content"] for result in results] == ["cdef", "nopq", "yz01"]
        assert [result["offset"] for result in results] == [2, 2, 2]

        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=77,
            knowledge_ids=[1, 2],
        )
        mock_create_context.assert_called_once_with(
            db=db,
            subtask_id=77,
            knowledge_id=1,
            user_id=88,
            tool_type="kb_head",
            result_data={
                "document_ids": [11, 12],
                "offset": 2,
                "limit": 4,
            },
        )
        mock_update_context.assert_called_once_with(
            db=db,
            context_id=900,
            document_ids=[21],
            offset=2,
            limit=4,
        )

    def test_read_documents_skips_invalid_results_during_persistence(self) -> None:
        """Missing and denied documents should not be persisted."""
        db = MagicMock()
        documents = {
            11: SimpleNamespace(id=11, name="doc-11", attachment_id=101, kind_id=1),
            21: SimpleNamespace(id=21, name="doc-21", attachment_id=201, kind_id=3),
        }
        attachments = {
            101: SimpleNamespace(id=101, extracted_text="abcdefghijk"),
            201: SimpleNamespace(id=201, extracted_text="lmnopqrstuv"),
        }
        mock_get_context_map = MagicMock()
        mock_create_context = MagicMock()
        mock_update_context = MagicMock()

        with (
            patch.object(self.service, "_load_documents", return_value=documents),
            patch.object(
                self.service,
                "_load_attachment_contexts",
                return_value=attachments,
            ),
            patch.multiple(
                context_service,
                get_knowledge_base_context_map_by_subtask=mock_get_context_map,
                create_knowledge_base_context_with_result=mock_create_context,
                update_knowledge_base_kb_head_result=mock_update_context,
            ),
        ):
            mock_get_context_map.return_value = {}

            results = self.service.read_documents(
                db=db,
                document_ids=[11, 99, 21],
                offset=0,
                limit=5,
                knowledge_base_ids=[1],
                user_subtask_id=77,
                user_id=88,
            )

        assert results[0]["id"] == 11
        assert results[1] == {
            "id": 99,
            "error": "Document not found",
            "error_code": "DOCUMENT_NOT_FOUND",
        }
        assert (
            results[2]["error"]
            == "Access denied: document not in allowed knowledge bases"
        )
        assert results[2]["error_code"] == "DOCUMENT_ACCESS_DENIED"

        mock_get_context_map.assert_called_once_with(
            db=db,
            subtask_id=77,
            knowledge_ids=[1],
        )
        mock_create_context.assert_called_once_with(
            db=db,
            subtask_id=77,
            knowledge_id=1,
            user_id=88,
            tool_type="kb_head",
            result_data={
                "document_ids": [11],
                "offset": 0,
                "limit": 5,
            },
        )
        mock_update_context.assert_not_called()

    def test_read_documents_skips_persistence_for_zero_user_id(self) -> None:
        """Sentinel user_id=0 should not persist kb_head usage."""
        db = MagicMock()
        documents = {
            11: SimpleNamespace(id=11, name="doc-11", attachment_id=101, kind_id=1),
        }
        attachments = {
            101: SimpleNamespace(id=101, extracted_text="abcdefghijk"),
        }

        with (
            patch.object(self.service, "_load_documents", return_value=documents),
            patch.object(
                self.service,
                "_load_attachment_contexts",
                return_value=attachments,
            ),
            patch.object(self.service, "_persist_kb_head_usage") as mock_persist,
        ):
            results = self.service.read_documents(
                db=db,
                document_ids=[11],
                offset=0,
                limit=5,
                knowledge_base_ids=[1],
                user_subtask_id=77,
                user_id=0,
            )

        assert results[0]["id"] == 11
        mock_persist.assert_not_called()

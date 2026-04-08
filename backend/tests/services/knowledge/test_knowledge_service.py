# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.models.knowledge import KnowledgeDocument
from app.services.context import context_service
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.mark.unit
class TestKnowledgeServiceUpdateDocumentContent:
    def test_update_document_content_overwrites_attachment_binary(self) -> None:
        """Editable documents should update attachment storage before reindexing."""
        db = MagicMock()
        document = SimpleNamespace(
            id=1,
            kind_id=10,
            source_type="text",
            file_extension="md",
            attachment_id=20,
            name="release-notes",
            file_size=12,
        )
        knowledge_base = SimpleNamespace(namespace="default")
        attachment = SimpleNamespace(
            id=20,
            original_filename="release-notes.md",
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base

        attachment_query = MagicMock()
        attachment_query.filter.return_value.first.return_value = attachment

        db.query.side_effect = [kb_query, attachment_query]

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                context_service, "overwrite_attachment"
            ) as mock_overwrite_attachment,
        ):
            result = KnowledgeService.update_document_content(
                db=db,
                document_id=document.id,
                content="# Updated release notes",
                user_id=99,
            )

        assert result is document
        assert document.file_size == len("# Updated release notes".encode("utf-8"))
        mock_overwrite_attachment.assert_called_once_with(
            db=db,
            context_id=20,
            user_id=99,
            filename="release-notes.md",
            binary_data="# Updated release notes".encode("utf-8"),
        )
        db.refresh.assert_called_once_with(document)


@pytest.mark.unit
class TestKnowledgeServiceResolveDocumentIdsByNames:
    def test_resolve_document_ids_by_names_returns_only_active_docs_in_scope(
        self, test_db, test_user
    ) -> None:
        """Document-name resolution should ignore inactive and out-of-scope rows."""
        active_doc = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        inactive_doc = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=False,
            source_type="file",
        )
        other_kb_doc = KnowledgeDocument(
            kind_id=11,
            attachment_id=0,
            name="release.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add_all([active_doc, inactive_doc, other_kb_doc])
        test_db.commit()

        resolved_ids = KnowledgeService.resolve_document_ids_by_names(
            db=test_db,
            knowledge_base_ids=[10],
            document_names=["release.md"],
        )

        assert resolved_ids == [active_doc.id]


@pytest.mark.unit
class TestKnowledgeServiceGetDocumentPromptStats:
    def test_get_document_prompt_stats_counts_only_active_spreadsheets(
        self, test_db, test_user
    ) -> None:
        """Spreadsheet count should reflect searchable spreadsheet documents only."""
        active_csv = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="active-report.csv",
            file_extension="csv",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        inactive_xlsx = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="inactive-report.xlsx",
            file_extension="xlsx",
            file_size=10,
            user_id=test_user.id,
            is_active=False,
            source_type="file",
        )
        active_markdown = KnowledgeDocument(
            kind_id=10,
            attachment_id=0,
            name="guide.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            is_active=True,
            source_type="file",
        )
        test_db.add_all([active_csv, inactive_xlsx, active_markdown])
        test_db.commit()

        stats = KnowledgeService.get_document_prompt_stats(
            db=test_db,
            knowledge_base_ids=[10],
        )

        assert stats[10] == {
            "total_document_count": 3,
            "searchable_document_count": 2,
            "spreadsheet_document_count": 1,
        }


@pytest.mark.unit
class TestKnowledgeServiceDeleteDocument:
    def test_delete_document_routes_cleanup_with_kb_owner_user_id(self) -> None:
        db = MagicMock()
        document = SimpleNamespace(
            id=8,
            kind_id=10,
            attachment_id=20,
        )
        knowledge_base = SimpleNamespace(
            id=10,
            user_id=42,
            namespace="default",
            json={
                "spec": {
                    "retrievalConfig": {
                        "retriever_name": "retriever-a",
                        "retriever_namespace": "default",
                    }
                }
            },
        )

        kb_query = MagicMock()
        kb_query.filter.return_value.first.return_value = knowledge_base
        db.query.return_value = kb_query
        delete_runtime_spec = object()
        mock_gateway = MagicMock()
        mock_gateway.delete_document_index = MagicMock()

        with (
            patch.object(KnowledgeService, "get_document", return_value=document),
            patch.object(
                KnowledgeService,
                "_assert_can_manage_document",
                return_value=None,
            ),
            patch.object(
                KnowledgeService,
                "_update_document_count_cache",
                return_value=None,
            ),
            patch.object(
                context_service,
                "delete_context",
                return_value=True,
            ),
            patch(
                "app.services.rag.gateway_factory.get_delete_gateway",
                return_value=mock_gateway,
            ),
            patch(
                "app.services.rag.runtime_resolver.RagRuntimeResolver.build_delete_runtime_spec",
                return_value=delete_runtime_spec,
            ) as mock_build_delete_runtime_spec,
            patch(
                "asyncio.run",
                return_value={"status": "success"},
            ),
        ):
            KnowledgeService.delete_document(
                db=db,
                document_id=8,
                user_id=7,
            )

        mock_build_delete_runtime_spec.assert_called_once_with(
            db=db,
            knowledge_base_id=10,
            document_ref="8",
            index_owner_user_id=42,
        )

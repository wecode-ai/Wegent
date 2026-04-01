# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

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

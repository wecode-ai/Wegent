# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.knowledge import DocumentStatus, KnowledgeDocument
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.context.context_service import context_service
from app.services.knowledge.document_read_service import DocumentReadService
from app.services.knowledge.document_text_sources import (
    DocumentTextSources,
    load_document_text_sources,
)


def _loaded_sources(documents, attachments):
    """Represent authorized loader results for read/persistence unit contracts."""
    return {
        document_id: DocumentTextSources(
            original=attachments.get(document.attachment_id),
            converted=attachments.get(
                getattr(document, "converted_attachment_id", None)
            ),
            content_readable=True,
        )
        for document_id, document in documents.items()
    }


@pytest.mark.parametrize(
    "converted_text,foreign_reference,expected",
    [
        ("", None, "Original body."),
        (" \n\t\u2003", None, "Original body."),
        (" " * 4096 + "Converted body.", None, " " * 4096 + "Converted body."),
        ("", "original", ""),
        ("Private converted body.", "converted", "Original body."),
        ("Legacy converted body.", "legacy", "Legacy converted body."),
        ("Scanned PDF converted body.", "legacy-only", "Scanned PDF converted body."),
        ("String reference must not replace original.", "string-ref", "Original body."),
        ("Boolean reference must not replace original.", "bool-ref", "Original body."),
        (
            "Oversized reference must not break reads.",
            "oversized-ref",
            "Original body.",
        ),
    ],
    ids=[
        "empty",
        "whitespace",
        "late-converted-body",
        "foreign-original",
        "foreign-converted",
        "legacy-converted",
        "legacy-converted-only",
        "numeric_string_ref",
        "boolean_ref",
        "oversized_ref",
    ],
)
def test_stored_converted_text_selection_uses_full_usable_body(
    test_db: Session,
    test_user,
    test_admin_user,
    converted_text: str,
    foreign_reference: str | None,
    expected: str,
) -> None:
    original = SubtaskContext(
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name="original.md",
        extracted_text="Original body.",
    )
    converted = SubtaskContext(
        user_id=test_user.id,
        context_type=ContextType.ATTACHMENT.value,
        name="converted.md",
        extracted_text=converted_text,
    )
    if foreign_reference == "legacy-only":
        original.extracted_text = ""
    if foreign_reference == "original":
        original.user_id = test_admin_user.id
    elif foreign_reference == "converted":
        converted.user_id = test_admin_user.id
    test_db.add_all([original, converted])
    test_db.flush()
    document = KnowledgeDocument(
        user_id=test_user.id,
        kind_id=42,
        attachment_id=original.id,
        source_config=(
            {}
            if foreign_reference == "original"
            else {"converted_attachment_id": converted.id}
        ),
        name="Guide",
        file_extension="md",
        is_active=True,
        status=DocumentStatus.ENABLED,
    )
    if foreign_reference == "string-ref":
        document.source_config = {"converted_attachment_id": str(converted.id)}
    elif foreign_reference == "bool-ref":
        document.source_config = {"converted_attachment_id": True}
    elif foreign_reference == "oversized-ref":
        document.source_config = {"converted_attachment_id": 2**80}
    test_db.add(document)
    test_db.flush()

    result = DocumentReadService().read_documents(
        test_db, document_ids=[document.id], knowledge_base_ids=[42]
    )[0]

    assert result["content"] == expected
    assert result["total_length"] == len(expected)
    assert result["returned_length"] == len(expected)
    metadata = load_document_text_sources(test_db, [document], include_text=False)[
        document.id
    ]
    assert metadata.content_readable is bool(expected.strip())
    assert metadata.select_text() is None
    if foreign_reference in {"string-ref", "bool-ref"}:
        sources = load_document_text_sources(test_db, [document])[document.id]
        assert sources.converted is None
        assert sources.original.id == original.id


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
                return_value=_loaded_sources(documents, attachments),
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
                return_value=_loaded_sources(documents, attachments),
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
                return_value=_loaded_sources(documents, attachments),
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

    def test_read_documents_prefers_converted_attachment_content(self) -> None:
        """Converted Markdown is preferred over the original attachment's text."""
        db = MagicMock()
        documents = {
            11: SimpleNamespace(
                id=11,
                name="doc-11",
                attachment_id=101,
                kind_id=1,
                converted_attachment_id=201,
            ),
        }
        attachments = {
            101: SimpleNamespace(id=101, extracted_text="ORIGINAL_PDF_TEXT"),
            201: SimpleNamespace(id=201, extracted_text="# Converted Markdown"),
        }

        with (
            patch.object(self.service, "_load_documents", return_value=documents),
            patch.object(
                self.service,
                "_load_attachment_contexts",
                return_value=_loaded_sources(documents, attachments),
            ),
        ):
            results = self.service.read_documents(
                db=db,
                document_ids=[11],
                knowledge_base_ids=[1],
            )

        assert results[0]["id"] == 11
        assert results[0]["content"] == "# Converted Markdown"
        assert results[0]["total_length"] == len("# Converted Markdown")

    def test_read_documents_falls_back_to_original_when_no_converted(self) -> None:
        """Without a converted attachment, the original extracted_text is used."""
        db = MagicMock()
        documents = {
            11: SimpleNamespace(
                id=11,
                name="doc-11",
                attachment_id=101,
                kind_id=1,
                converted_attachment_id=None,
            ),
        }
        attachments = {
            101: SimpleNamespace(id=101, extracted_text="ORIGINAL_TEXT"),
        }

        with (
            patch.object(self.service, "_load_documents", return_value=documents),
            patch.object(
                self.service,
                "_load_attachment_contexts",
                return_value=_loaded_sources(documents, attachments),
            ),
        ):
            results = self.service.read_documents(
                db=db,
                document_ids=[11],
                knowledge_base_ids=[1],
            )

        assert results[0]["content"] == "ORIGINAL_TEXT"

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Binary source refreshes retain a parseable attachment filename."""

from io import BytesIO
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from docx import Document
from openpyxl import Workbook
from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.context import context_service
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_document_providers import ExternalDocumentContent
from app.services.knowledge.index_state_machine import mark_document_index_succeeded
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import knowledge_orchestrator


def binary_body(extension: str, marker: str) -> bytes:
    body = BytesIO()
    if extension == "xlsx":
        workbook = Workbook()
        workbook.active["A1"] = marker
        workbook.save(body)
    elif extension == "docx":
        document = Document()
        document.add_paragraph(marker)
        document.save(body)
    else:
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=100)
        page = writer.pages[0]
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            }
        )
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})}
        )
        stream = DecodedStreamObject()
        stream.set_data(f"BT /F1 12 Tf 10 50 Td ({marker}) Tj ET".encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        writer.write(body)
    return body.getvalue()


@pytest.fixture
def binary_copy(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> KnowledgeDocument:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(
            name="Binary refresh",
            retrieval_config={
                "retriever_name": "test-retriever",
                "embedding_config": {"model_name": "test-embedding"},
            },
        ),
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.delay",
        MagicMock(return_value=SimpleNamespace(id="index-task")),
    )
    return KnowledgeService.create_external_document(
        test_db,
        kb_id,
        test_user.id,
        name="Original copy",
        external_provider="dingtalk",
        external_resource_id="binary-source",
        folder_id=0,
        external_meta={"title": "Original copy"},
    )


@pytest.fixture
def published_binary_copy(
    test_db: Session,
    test_user: User,
    binary_copy: KnowledgeDocument,
    extension: str,
) -> KnowledgeDocument:
    knowledge_orchestrator.attach_external_document_content(
        test_db,
        binary_copy,
        test_user,
        ExternalDocumentContent(
            name="Original copy",
            file_extension=extension,
            content=binary_body(extension, "old-body-marker"),
        ),
        generation=binary_copy.index_generation,
    )
    assert mark_document_index_succeeded(
        test_db, binary_copy.id, binary_copy.index_generation
    )
    return binary_copy


@pytest.mark.parametrize("extension", ["xlsx", "docx", "pdf"])
@pytest.mark.parametrize("source_title", ["", "   ", "Renamed source"])
def test_binary_refresh_uses_copy_name_when_source_title_is_blank(
    test_db: Session,
    test_user: User,
    published_binary_copy: KnowledgeDocument,
    dispatched: list[int],
    extension: str,
    source_title: str,
) -> None:
    previous_attachment_id = published_binary_copy.attachment_id
    refresh = external_document_import_service.refresh_existing_document(
        test_db, published_binary_copy
    )
    assert refresh.started

    result = knowledge_orchestrator.attach_external_document_content(
        test_db,
        published_binary_copy,
        test_user,
        ExternalDocumentContent(
            name=source_title,
            file_extension=extension,
            content=binary_body(extension, "refreshed-body-marker"),
        ),
        generation=published_binary_copy.index_generation,
    )

    document = KnowledgeService.get_document(
        test_db, published_binary_copy.id, test_user.id
    )
    assert document is not None
    attachment = context_service.get_context(
        test_db, document.attachment_id, test_user.id
    )
    expected_name = source_title if source_title.strip() else "Original copy"
    assert result["scheduled"] is True
    assert document.name == expected_name
    assert document.file_extension == extension
    assert document.attachment_id != previous_attachment_id
    assert attachment.original_filename == f"{expected_name}.{extension}"
    assert attachment.status == "ready"
    assert "refreshed-body-marker" in attachment.extracted_text
    assert "old-body-marker" not in attachment.extracted_text

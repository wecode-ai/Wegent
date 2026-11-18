# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Summary contracts for external knowledge directory listings."""

from typing import Optional

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.knowledge.external_nodes import (
    list_direct_nodes,
    list_recursive_nodes,
)


def _add_attachment(db: Session, user_id: int, text: str) -> SubtaskContext:
    attachment = SubtaskContext(
        user_id=user_id,
        name="guide.md",
        context_type=ContextType.ATTACHMENT.value,
        extracted_text=text,
        text_length=len(text),
        binary_data=b"original file bytes",
        image_base64="original image data",
        type_data={
            "original_filename": "guide.md",
            "file_extension": ".md",
            "file_size": 123,
            "mime_type": "text/markdown",
            "storage_key": "attachments/guide.md",
        },
    )
    db.add(attachment)
    db.flush()
    return attachment


def _add_document(
    db: Session,
    user_id: int,
    *,
    summary: object = None,
    text: Optional[str] = None,
    converted_text: Optional[str] = None,
    folder_id: int = 0,
) -> KnowledgeDocument:
    attachment = _add_attachment(db, user_id, text) if text is not None else None
    source_config = {}
    if converted_text is not None:
        converted = _add_attachment(db, user_id, converted_text)
        source_config["converted_attachment_id"] = converted.id
    document = KnowledgeDocument(
        kind_id=42,
        user_id=user_id,
        attachment_id=attachment.id if attachment is not None else 0,
        folder_id=folder_id,
        name="Setup guide",
        file_extension="md",
        file_size=123,
        is_active=True,
        summary=summary,
        source_config=source_config,
    )
    db.add(document)
    db.flush()
    return document


def test_direct_nodes_expose_stored_summary_and_leave_folders_null(
    test_db: Session, test_user
) -> None:
    test_db.add_all(
        [
            KnowledgeFolder(kind_id=42, parent_id=0, name="Guides"),
            KnowledgeDocument(
                kind_id=42,
                user_id=test_user.id,
                attachment_id=0,
                folder_id=0,
                name="Setup guide",
                file_extension="txt",
                summary={
                    "short_summary": "Configure the board and connect to Wi-Fi.",
                    "status": "completed",
                },
            ),
        ]
    )
    test_db.flush()

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)
    folder, document = [node.model_dump() for node in result.items]

    assert document["short_summary"] == "Configure the board and connect to Wi-Fi."
    assert document["summary_status"] == "completed"
    assert folder["short_summary"] is None
    assert folder["summary_status"] is None


def test_missing_summary_uses_first_meaningful_paragraph(
    test_db: Session, test_user
) -> None:
    _add_document(
        test_db,
        test_user.id,
        summary={"status": "pending", "short_summary": None},
        text=(
            "\n# Setup guide\n\n---\n\n"
            "Connect the board to your computer.\n"
            "Install the serial driver.\n\n"
            "This later paragraph should not appear."
        ),
    )

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)
    node = result.items[0]

    assert node.short_summary == (
        "Connect the board to your computer. Install the serial driver."
    )
    assert node.summary_status == "pending"


@pytest.mark.parametrize(
    "summary,expected_summary,expected_status",
    [
        (None, None, None),
        ({}, None, None),
        ("not an object", None, None),
        ([{"short_summary": "not a summary object"}], None, None),
        (False, None, None),
        ({"short_summary": 123, "status": []}, None, None),
        ({"short_summary": {}, "status": 123}, None, None),
        ({"short_summary": " \n\t ", "status": " "}, None, None),
        ({"short_summary": "A saved summary", "status": None}, "A saved summary", None),
        ({"short_summary": None, "status": "completed"}, None, "completed"),
        ({"status": "pending"}, None, "pending"),
        ({"status": "generating"}, None, "generating"),
        ({"short_summary": None, "status": "failed"}, None, "failed"),
    ],
)
def test_summary_json_is_optional_and_malformed_fields_do_not_break_browsing(
    test_db: Session, test_user, summary, expected_summary, expected_status
) -> None:
    _add_document(test_db, test_user.id, summary=summary)

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert result.items[0].short_summary == expected_summary
    assert result.items[0].summary_status == expected_status


@pytest.mark.parametrize(
    "status", ["completed", "pending", "generating", "failed", None]
)
def test_saved_summary_takes_precedence_regardless_of_generation_state(
    test_db: Session, test_user, status
) -> None:
    _add_document(
        test_db,
        test_user.id,
        summary={"short_summary": "The saved overview.", "status": status},
        text="This parsed paragraph must not replace the saved overview.",
    )

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert result.items[0].short_summary == "The saved overview."
    assert result.items[0].summary_status == status


def test_saved_summary_is_bounded_even_when_stored_json_contains_huge_text(
    test_db: Session, test_user
) -> None:
    _add_document(
        test_db,
        test_user.id,
        summary={"short_summary": "Saved " + "A" * 20000, "status": "completed"},
        text="Do not replace the saved summary with this paragraph.",
    )

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert len(result.items[0].short_summary) == 300
    assert result.items[0].short_summary == "Saved " + "A" * 294
    assert result.items[0].summary_status == "completed"


@pytest.mark.parametrize("status", ["completed", "pending", "failed", None])
def test_fallback_does_not_claim_summary_generation_completed(
    test_db: Session, test_user, status
) -> None:
    _add_document(
        test_db,
        test_user.id,
        summary={"short_summary": None, "status": status},
        text="A parsed overview is available.\n\nDetails follow.",
    )

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert result.items[0].short_summary == "A parsed overview is available."
    assert result.items[0].summary_status == status


def test_fallback_skips_front_matter_and_fenced_code(
    test_db: Session, test_user
) -> None:
    _add_document(
        test_db,
        test_user.id,
        text=(
            "---\nowner: Tools\n---\n\n# Guide\n\n"
            "```python\nraise RuntimeError('example')\n```\n\n"
            "Use the guide to configure your board.\n\nFurther details."
        ),
    )

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert result.items[0].short_summary == "Use the guide to configure your board."
    assert result.items[0].summary_status is None


@pytest.mark.parametrize(
    "text,expected",
    [
        ("", None),
        ("\n# Heading\n\n---\n", None),
        (" " * 4096 + "A paragraph beyond the bounded prefix.", None),
        ("A" * 20000, "A" * 300),
    ],
)
def test_fallback_is_bounded_and_empty_parsed_text_stays_null(
    test_db: Session, test_user, text, expected
) -> None:
    _add_document(test_db, test_user.id, text=text)

    result = list_direct_nodes(test_db, 42, 0, True, limit=20, offset=0)

    assert result.items[0].short_summary == expected
    assert result.items[0].content_readable == bool(text)


@pytest.mark.parametrize("mode", ["direct", "root", "subtree"])
def test_listings_batch_original_and_converted_prefixes_without_loading_blobs(
    test_db: Session, test_user, mode: str
) -> None:
    folder = KnowledgeFolder(kind_id=42, parent_id=0, name="Guides")
    test_db.add(folder)
    test_db.flush()
    folder_id = folder.id
    full_text = "Original parsed overview.\n\n" + "Long body. " * 5000
    first_document = _add_document(
        test_db, test_user.id, text=full_text, folder_id=folder_id
    )
    original_attachment_id = first_document.attachment_id
    converted_document = _add_document(
        test_db,
        test_user.id,
        text="Original text loses to the converted content.",
        converted_text="# Converted\n\nConverted parsed overview.\n\nDetails.",
        folder_id=folder_id,
    )
    converted_document_id = converted_document.id
    empty_conversion = _add_document(
        test_db,
        test_user.id,
        text="Original text remains useful when conversion is empty.",
        converted_text="",
        folder_id=folder_id,
    )
    empty_conversion_id = empty_conversion.id
    test_db.expunge_all()
    connection = test_db.connection()
    attachment_reads = []

    def record_attachment_read(_conn, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT") and (
            "subtask_contexts" in statement
        ):
            attachment_reads.append((statement.lower(), parameters))

    event.listen(connection, "before_cursor_execute", record_attachment_read)
    try:
        if mode == "direct":
            nodes = list_direct_nodes(
                test_db, 42, folder_id, True, limit=20, offset=0
            ).items
        else:
            nodes, warnings = list_recursive_nodes(
                test_db, 42, 0 if mode == "root" else folder_id, True
            )
            assert warnings == []
        if mode == "root":
            assert nodes[0].short_summary is None
            assert nodes[0].summary_status is None
            nodes = nodes[0].children
    finally:
        event.remove(connection, "before_cursor_execute", record_attachment_read)

    by_id = {node.raw_id: node for node in nodes}
    assert by_id[converted_document_id].short_summary == "Converted parsed overview."
    assert by_id[empty_conversion_id].short_summary == (
        "Original text remains useful when conversion is empty."
    )
    assert all(node.content_readable and node.downloadable for node in nodes)
    assert all(node.previewable and node.mime_type == "text/markdown" for node in nodes)
    assert all(node.file_extension == "md" and node.file_size == 123 for node in nodes)
    assert len(attachment_reads) == 1
    statement, parameters = attachment_reads[0]
    assert "substr(subtask_contexts.extracted_text" in statement
    assert 4096 in parameters
    assert "binary_data" not in statement
    assert "image_base64" not in statement
    original = test_db.get(SubtaskContext, original_attachment_id)
    assert original.extracted_text == full_text
    assert original.binary_data == b"original file bytes"


def test_recursive_orphan_document_also_has_a_fallback(
    test_db: Session, test_user
) -> None:
    document = _add_document(
        test_db, test_user.id, folder_id=9999, text="An orphan's parsed overview."
    )

    nodes, warnings = list_recursive_nodes(test_db, 42, 0, True)

    assert nodes[0].raw_id == document.id
    assert nodes[0].orphan is True
    assert nodes[0].short_summary == "An orphan's parsed overview."
    assert warnings == [f"Document {document.id} references missing folder 9999"]

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.rag.content_refs import build_content_ref_for_attachment


def _create_attachment_context(test_db, attachment_id: int = 101) -> SubtaskContext:
    context = SubtaskContext(
        id=attachment_id,
        subtask_id=0,
        user_id=7,
        context_type=ContextType.ATTACHMENT.value,
        name="release-notes.md",
        status=ContextStatus.READY.value,
        type_data={
            "original_filename": "release-notes.md",
            "file_extension": ".md",
            "file_size": 42,
            "mime_type": "text/markdown",
            "storage_backend": "mysql",
            "storage_key": "attachments/release-notes.md",
        },
    )
    test_db.add(context)
    test_db.commit()
    return context


def test_build_content_ref_for_attachment_returns_backend_stream_ref(test_db) -> None:
    context = _create_attachment_context(test_db)

    content_ref = build_content_ref_for_attachment(
        db=test_db,
        attachment_id=context.id,
    )

    assert content_ref.kind == "backend_attachment_stream"
    assert content_ref.url.endswith(f"/api/internal/rag/content/{context.id}")
    assert content_ref.auth_token


def test_build_content_ref_for_attachment_prefers_presigned_url(test_db) -> None:
    context = _create_attachment_context(test_db, attachment_id=102)

    with patch(
        "app.services.rag.content_refs.context_service.get_attachment_url",
        return_value="https://storage.example.com/presigned/object",
    ):
        content_ref = build_content_ref_for_attachment(
            db=test_db,
            attachment_id=context.id,
        )

    assert content_ref.kind == "presigned_url"
    assert content_ref.url == "https://storage.example.com/presigned/object"

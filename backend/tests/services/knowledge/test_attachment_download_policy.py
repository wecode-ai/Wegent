# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for KB policy enforcement at generic attachment exits."""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.services.knowledge import attachment_download_policy
from app.services.knowledge.document_download_policy import (
    DocumentDownloadDisabledError,
)


def _knowledge_document(test_db: Session, *, attachment_id: int) -> KnowledgeDocument:
    knowledge_base = Kind(
        user_id=1,
        kind="KnowledgeBase",
        name="protected-kb",
        namespace="default",
        json={"spec": {"allowDocumentDownload": False}},
        is_active=True,
    )
    test_db.add(knowledge_base)
    test_db.flush()

    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=attachment_id,
        name="protected.txt",
        file_extension="txt",
        file_size=1,
        user_id=1,
    )
    test_db.add(document)
    test_db.flush()
    return document


def test_unrelated_attachment_skips_knowledge_download_policy(
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    def fail_if_called(db: Session, knowledge_base: Kind) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(
        attachment_download_policy,
        "require_document_download_allowed",
        fail_if_called,
    )

    attachment_download_policy.require_attachment_download_allowed(
        test_db,
        attachment_id=101,
        mime_type="application/pdf",
        purpose="download",
    )

    assert called is False


def test_protected_document_attachment_is_blocked_for_download(
    test_db: Session,
) -> None:
    _knowledge_document(test_db, attachment_id=102)

    with pytest.raises(DocumentDownloadDisabledError):
        attachment_download_policy.require_attachment_download_allowed(
            test_db,
            attachment_id=102,
            mime_type="application/pdf",
            purpose="download",
        )


def test_protected_video_is_allowed_only_for_playback(
    test_db: Session,
) -> None:
    _knowledge_document(test_db, attachment_id=103)

    attachment_download_policy.require_attachment_download_allowed(
        test_db,
        attachment_id=103,
        mime_type="video/mp4",
        purpose="playback",
    )

    with pytest.raises(DocumentDownloadDisabledError):
        attachment_download_policy.require_attachment_download_allowed(
            test_db,
            attachment_id=103,
            mime_type="video/mp4",
            purpose="executor",
        )

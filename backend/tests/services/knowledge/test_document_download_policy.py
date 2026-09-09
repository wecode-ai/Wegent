# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for original knowledge-document download protection."""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.knowledge.document_download_policy import (
    DocumentDownloadDisabledError,
    is_original_download_allowed,
    require_document_download_allowed,
)


def _knowledge_base(*, namespace: str, allow_document_download: bool | None) -> Kind:
    now = datetime.utcnow()
    return Kind(
        user_id=1,
        kind="KnowledgeBase",
        name=f"kb-{namespace}",
        namespace=namespace,
        json={
            "spec": (
                {"allowDocumentDownload": allow_document_download}
                if allow_document_download is not None
                else {}
            )
        },
        is_active=True,
        created_at=now,
        updated_at=now,
    )


def test_configuration_disables_original_download_for_personal_kb(
    test_db: Session,
) -> None:
    knowledge_base = _knowledge_base(namespace="default", allow_document_download=False)

    assert is_original_download_allowed(test_db, knowledge_base) is False
    with pytest.raises(DocumentDownloadDisabledError):
        require_document_download_allowed(test_db, knowledge_base)


def test_missing_configuration_allows_original_download_in_open_source(
    test_db: Session,
) -> None:
    knowledge_base = _knowledge_base(namespace="company", allow_document_download=None)

    assert is_original_download_allowed(test_db, knowledge_base) is True
    require_document_download_allowed(test_db, knowledge_base)

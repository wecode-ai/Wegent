# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the document-scoped browser download endpoints."""

from types import SimpleNamespace
from typing import NoReturn

import pytest
from fastapi import HTTPException

from app.api.endpoints import knowledge
from app.services.knowledge.external_document_access import (
    DocumentDownloadToken,
    ExternalDocumentAccessError,
    ExternalDocumentFile,
)


def test_download_token_is_issued_for_the_requested_knowledge_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_get_document_file_or_raise(db: object, **kwargs: object) -> None:
        captured.update(kwargs)

    def fake_create_document_download_token(**kwargs: object) -> str:
        captured["token_kwargs"] = kwargs
        return "token-12"

    monkeypatch.setattr(
        knowledge, "get_document_file_or_raise", fake_get_document_file_or_raise
    )
    monkeypatch.setattr(
        knowledge,
        "create_document_download_token",
        fake_create_document_download_token,
    )

    response = knowledge.create_knowledge_document_download_token(
        document_id=12,
        current_user=SimpleNamespace(id=7),
        db=object(),
    )

    assert captured["user_id"] == 7
    assert captured["document_id"] == 12
    assert captured["disposition"] == "attachment"
    assert captured["token_kwargs"] == {
        "user_id": 7,
        "document_id": 12,
        "disposition": "attachment",
    }
    assert response["download_token"] == "token-12"


def test_document_download_rechecks_the_document_scoped_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        knowledge,
        "verify_document_download_token",
        lambda token: DocumentDownloadToken(
            user_id=7, document_id=12, disposition="attachment"
        ),
    )
    monkeypatch.setattr(
        knowledge,
        "load_document_file_or_raise",
        lambda db, **kwargs: ExternalDocumentFile(
            content=b"document-body",
            media_type="text/plain",
            content_disposition='attachment; filename="document.txt"',
        ),
    )

    response = knowledge.download_knowledge_document(
        document_id=12,
        download_token="token-12",
        db=object(),
    )

    assert response.status_code == 200
    assert response.body == b"document-body"
    assert response.headers["cache-control"] == "private, no-store"
    assert (
        response.headers["content-disposition"] == 'attachment; filename="document.txt"'
    )


def test_document_download_rejects_a_disabled_knowledge_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        knowledge,
        "verify_document_download_token",
        lambda token: DocumentDownloadToken(
            user_id=7, document_id=12, disposition="attachment"
        ),
    )

    def raise_disabled(db: object, **kwargs: object) -> NoReturn:
        raise ExternalDocumentAccessError(
            "Document download is disabled", "DOCUMENT_DOWNLOAD_DISABLED"
        )

    monkeypatch.setattr(knowledge, "load_document_file_or_raise", raise_disabled)

    with pytest.raises(HTTPException) as exc_info:
        knowledge.download_knowledge_document(
            document_id=12,
            download_token="token-12",
            db=object(),
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == {
        "code": "DOCUMENT_DOWNLOAD_DISABLED",
        "message": "Document download is disabled",
    }

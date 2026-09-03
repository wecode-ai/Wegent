# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Route-level regression tests for KB policy at attachment binary exits.

The service-level policy tests prove the decision logic; these tests prove the
HTTP exits (download, download-token, playback, executor, public share) keep
calling it, including the re-check of tokens issued before a policy flip.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints.adapter import attachments
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.user import User
from app.services.context import context_service

ORIGINAL_BYTES = b"original-document-bytes"


def _create_kb_document_attachment(
    test_db: Session,
    *,
    user_id: int,
    filename: str,
    allow_document_download: bool | None,
) -> tuple[Kind, int]:
    """Create a KB with one document-backed attachment; return (KB, id)."""
    spec = (
        {}
        if allow_document_download is None
        else {"allowDocumentDownload": allow_document_download}
    )
    knowledge_base = Kind(
        user_id=user_id,
        kind="KnowledgeBase",
        name="policy-routes-kb",
        namespace="default",
        json={"spec": spec},
        is_active=True,
    )
    test_db.add(knowledge_base)
    test_db.flush()

    context, _ = context_service.upload_attachment(
        db=test_db,
        user_id=user_id,
        filename=filename,
        binary_data=ORIGINAL_BYTES,
    )
    test_db.add(
        KnowledgeDocument(
            kind_id=knowledge_base.id,
            attachment_id=context.id,
            name=filename,
            file_extension=filename.rsplit(".", 1)[-1],
            file_size=len(ORIGINAL_BYTES),
            user_id=user_id,
        )
    )
    test_db.commit()
    return knowledge_base, context.id


def _protect(knowledge_base: Kind, test_db: Session) -> None:
    """Flip an existing KB to download-disabled and persist it."""
    knowledge_base.json = {
        "spec": {**knowledge_base.json.get("spec", {}), "allowDocumentDownload": False}
    }
    test_db.commit()


def _assert_download_disabled(response) -> None:
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "DOCUMENT_DOWNLOAD_DISABLED"


def test_download_rejected_for_protected_kb_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    _, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="protected.txt",
        allow_document_download=False,
    )

    response = test_client.get(
        f"/api/attachments/{attachment_id}/download",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    _assert_download_disabled(response)


def test_download_token_creation_rejected_for_protected_kb_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    _, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="protected.txt",
        allow_document_download=False,
    )

    response = test_client.post(
        f"/api/attachments/{attachment_id}/download-token",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    _assert_download_disabled(response)


def test_issued_download_token_is_rechecked_when_policy_is_disabled(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    knowledge_base, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="flip.txt",
        allow_document_download=None,
    )
    monkeypatch.setattr(
        attachments,
        "_load_stored_attachment_binary_data",
        lambda attachment_id: ORIGINAL_BYTES,
    )

    token_response = test_client.post(
        f"/api/attachments/{attachment_id}/download-token",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert token_response.status_code == 200
    download_token = token_response.json()["download_token"]

    allowed_response = test_client.get(
        f"/api/attachments/{attachment_id}/download",
        params={"download_token": download_token},
    )
    assert allowed_response.status_code == 200
    assert allowed_response.content == ORIGINAL_BYTES

    _protect(knowledge_base, test_db)

    blocked_response = test_client.get(
        f"/api/attachments/{attachment_id}/download",
        params={"download_token": download_token},
    )
    _assert_download_disabled(blocked_response)


def test_playback_allowed_but_download_rejected_for_protected_video(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    _, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="protected.mp4",
        allow_document_download=False,
    )

    playback_response = test_client.get(
        f"/api/attachments/{attachment_id}/playback",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert playback_response.status_code == 200
    assert "download_token=" in playback_response.json()["playback_url"]

    download_response = test_client.get(
        f"/api/attachments/{attachment_id}/download",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    _assert_download_disabled(download_response)


def test_executor_download_rejected_for_protected_kb_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    _, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="protected.txt",
        allow_document_download=False,
    )

    response = test_client.get(
        f"/api/attachments/{attachment_id}/executor-download",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    _assert_download_disabled(response)


def test_public_share_creation_rejected_for_protected_kb_document(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    _, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="protected.txt",
        allow_document_download=False,
    )

    response = test_client.post(
        f"/api/attachments/{attachment_id}/public-share",
        headers={"Authorization": f"Bearer {test_token}"},
    )

    _assert_download_disabled(response)


def test_shared_download_rechecks_policy_after_share_token_issued(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
) -> None:
    knowledge_base, attachment_id = _create_kb_document_attachment(
        test_db,
        user_id=test_user.id,
        filename="flip.txt",
        allow_document_download=None,
    )
    share_token = attachments._generate_public_share_token(attachment_id)

    _protect(knowledge_base, test_db)

    response = test_client.get(
        "/api/attachments/download/shared",
        params={"token": share_token},
    )

    _assert_download_disabled(response)

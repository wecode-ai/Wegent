# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise external document preview through the real HTTP and storage paths."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.context import context_service
from app.services.knowledge.knowledge_service import KnowledgeService

BODY = "# 原文\n索引失败仍然可读。"


@pytest.fixture
def external_document(test_db: Session, test_user: User) -> KnowledgeDocument:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="preview-kb")
    )
    attachment, _ = context_service.upload_attachment(
        db=test_db,
        user_id=test_user.id,
        filename="online-document.md",
        binary_data=BODY.encode("utf-8"),
        subtask_id=0,
    )
    document = KnowledgeDocument(
        kind_id=kb_id,
        user_id=test_user.id,
        name="Online document",
        file_extension="md",
        file_size=len(BODY.encode("utf-8")),
        attachment_id=attachment.id,
        source_type="external",
        external_source=KnowledgeDocumentExternalSource(
            kind_id=kb_id,
            external_provider="dingtalk",
            external_resource_id="preview-node",
        ),
        index_status=DocumentIndexStatus.FAILED,
        index_generation=2,
        is_active=False,
    )
    test_db.add(document)
    test_db.commit()
    return document


@pytest.mark.parametrize("scoped", [True, False], ids=["kb-detail", "detail"])
@pytest.mark.parametrize("index_status", ["failed", "indexing", "success"])
def test_stored_body_is_readable_independently_of_index_status(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    external_document: KnowledgeDocument,
    scoped: bool,
    index_status: str,
) -> None:
    external_document.index_status = DocumentIndexStatus(index_status)
    external_document.is_active = index_status == "success"
    test_db.commit()
    prefix = (
        f"/api/knowledge-bases/{external_document.kind_id}/documents"
        if scoped
        else "/api/knowledge-documents"
    )
    response = test_client.get(
        f"{prefix}/{external_document.id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"include_summary": False},
    )

    assert response.status_code == 200, response.text
    assert response.json()["content"] == BODY
    assert response.json()["content_length"] == len(BODY)

    listing = test_client.get(
        f"/api/knowledge-bases/{external_document.kind_id}/documents",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert listing.status_code == 200
    item = next(d for d in listing.json()["items"] if d["id"] == external_document.id)
    assert item["index_status"] == index_status
    assert item["is_active"] is (index_status == "success")


@pytest.mark.parametrize("missing", [True, False], ids=["missing", "empty"])
def test_unavailable_attachment_does_not_return_empty_success(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    external_document: KnowledgeDocument,
    missing: bool,
) -> None:
    attachment = test_db.get(SubtaskContext, external_document.attachment_id)
    if missing:
        test_db.delete(attachment)
    else:
        attachment.extracted_text = ""
    test_db.commit()

    response = test_client.get(
        f"/api/knowledge-bases/{external_document.kind_id}"
        f"/documents/{external_document.id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"include_summary": False},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Document content is not ready for preview"


def test_placeholder_cannot_be_previewed(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    external_document: KnowledgeDocument,
) -> None:
    external_document.attachment_id = 0
    external_document.index_status = DocumentIndexStatus.QUEUED
    test_db.commit()

    response = test_client.get(
        f"/api/knowledge-documents/{external_document.id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"include_summary": False},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Document content is not ready for preview"


def test_stored_body_remains_private(
    test_client: TestClient,
    test_db: Session,
    external_document: KnowledgeDocument,
) -> None:
    other = User(user_name="preview-other", password_hash="unused", is_active=True)
    test_db.add(other)
    test_db.commit()
    token = create_access_token(data={"sub": other.user_name})

    response = test_client.get(
        f"/api/knowledge-documents/{external_document.id}/detail",
        headers={"Authorization": f"Bearer {token}"},
        params={"include_summary": False},
    )

    assert response.status_code == 403
    assert BODY not in response.text


@pytest.mark.parametrize("offset,expected", [(0, "# 原"), (100, "")])
def test_failed_index_body_supports_pagination(
    test_client: TestClient,
    test_token: str,
    external_document: KnowledgeDocument,
    offset: int,
    expected: str,
) -> None:
    response = test_client.get(
        f"/api/knowledge-bases/{external_document.kind_id}"
        f"/documents/{external_document.id}/detail",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"include_summary": False, "offset": offset, "limit": 3},
    )

    assert response.status_code == 200
    assert response.json()["content"] == expected
    assert response.json()["content_length"] == len(BODY)


def test_preview_does_not_allow_enabling_failed_document(
    test_client: TestClient,
    test_token: str,
    external_document: KnowledgeDocument,
) -> None:
    response = test_client.put(
        f"/api/knowledge-documents/{external_document.id}",
        headers={"Authorization": f"Bearer {test_token}"},
        json={"status": "enabled"},
    )

    assert response.status_code == 403

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP authentication contract for the restored Python knowledge entrypoints."""

import pytest


@pytest.mark.parametrize(
    "path",
    [
        "/api/knowledge/documents/1/content",
        "/api/knowledge/documents?knowledge_base_id=1",
        "/api/knowledge-bases/1/document-protection",
        "/api/knowledge-bases/1/folders",
        "/api/knowledge-bases/1/documents/1/detail",
        "/api/knowledge-bases/1/artifacts",
        "/api/wiki/connections",
        "/api/share/KnowledgeBase/1/my-permission",
    ],
)
def test_restored_entrypoint_requires_authentication(test_client, path):
    response = test_client.get(path)
    assert response.status_code == 401


@pytest.mark.parametrize("allowed", [True, False])
def test_document_protection_is_private_and_includes_watermark(
    test_client, test_db, test_user, test_token, allowed
):
    from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeBaseUpdate
    from app.services.knowledge.knowledge_service import KnowledgeService

    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="protection")
    )
    KnowledgeService.update_knowledge_base(
        test_db,
        kb_id,
        test_user.id,
        KnowledgeBaseUpdate(allow_document_download=allowed),
    )
    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/document-protection",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json() == {
        "original_download_allowed": allowed,
        "watermark_text": None if allowed else test_user.user_name,
    }


def test_my_permission_returns_owner_and_missing_contract(
    test_client, test_db, test_user, test_token
):
    from app.schemas.knowledge import KnowledgeBaseCreate
    from app.services.knowledge.knowledge_service import KnowledgeService

    kb_id = KnowledgeService.create_knowledge_base(
        test_db, test_user.id, KnowledgeBaseCreate(name="permission")
    )
    headers = {"Authorization": f"Bearer {test_token}"}
    response = test_client.get(
        f"/api/share/KnowledgeBase/{kb_id}/my-permission", headers=headers
    )
    assert response.status_code == 200
    assert response.json() == {
        "has_access": True,
        "is_creator": True,
        "role": "Owner",
        "pending_request": None,
    }
    missing = test_client.get(
        "/api/share/KnowledgeBase/999999/my-permission", headers=headers
    )
    assert missing.status_code == 200
    assert missing.json() == {
        "has_access": False,
        "is_creator": False,
        "role": None,
        "pending_request": None,
    }


@pytest.mark.parametrize("role", [None, "RestrictedAnalyst"])
def test_restored_http_readers_preserve_denied_and_restricted_access(
    test_client, test_db, test_user, test_token, role
):
    from app.core.security import get_password_hash
    from app.models.resource_member import ResourceMember
    from app.models.user import User
    from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeDocumentCreate
    from app.services.knowledge.knowledge_service import KnowledgeService

    owner = User(
        user_name="private-owner",
        email="private-owner@example.com",
        password_hash=get_password_hash("test-password"),
        is_active=True,
    )
    test_db.add(owner)
    test_db.flush()
    kb_id = KnowledgeService.create_knowledge_base(
        test_db, owner.id, KnowledgeBaseCreate(name="private")
    )
    document = KnowledgeService.create_document(
        test_db,
        kb_id,
        owner.id,
        KnowledgeDocumentCreate(
            name="secret.md", source_type="text", file_extension="md"
        ),
    )
    if role:
        test_db.add(
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=kb_id,
                entity_type="user",
                entity_id=str(test_user.id),
                role=role,
                status="approved",
                invited_by_user_id=owner.id,
                reviewed_by_user_id=owner.id,
                share_link_id=0,
                copied_resource_id=0,
            )
        )
        test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}
    for path, status in [
        (f"/api/knowledge/documents/{document.id}/content", 403),
        (f"/api/knowledge/documents?knowledge_base_id={kb_id}", 404),
        (f"/api/knowledge-bases/{kb_id}/document-protection", 404),
        (f"/api/knowledge-bases/{kb_id}/folders", 404),
        (f"/api/knowledge-bases/{kb_id}/documents/{document.id}/detail", 403),
        (f"/api/knowledge-bases/{kb_id}/artifacts", 404),
    ]:
        response = test_client.get(path, headers=headers)
        assert response.status_code == status, (path, response.text)
    permission = test_client.get(
        f"/api/share/KnowledgeBase/{kb_id}/my-permission", headers=headers
    )
    assert permission.status_code == 200
    assert permission.json()["has_access"] is False
    assert permission.json()["is_creator"] is False
    assert permission.json()["role"] is None

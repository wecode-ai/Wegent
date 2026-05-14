# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Integration tests for knowledge base creation with initial members."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.user import User


@pytest.fixture
def kb_owner(test_db: Session) -> User:
    """Create a knowledge base owner user."""
    user = User(
        user_name="kb_owner",
        password_hash=get_password_hash("ownerpass123"),
        email="kb_owner@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture
def kb_owner_token(kb_owner: User) -> str:
    """Create JWT token for the KB owner."""
    return create_access_token(data={"sub": kb_owner.user_name})


@pytest.fixture
def target_user(test_db: Session) -> User:
    """Create a target user to be added as a member."""
    user = User(
        user_name="target_user",
        password_hash=get_password_hash("targetpass"),
        email="target@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture
def namespace(test_db: Session, kb_owner: User) -> Namespace:
    """Create a namespace for entity-type member tests."""
    ns = Namespace(
        name="test-ns",
        display_name="Test Namespace",
        owner_user_id=kb_owner.id,
        level="group",
        is_active=True,
    )
    test_db.add(ns)
    test_db.commit()
    test_db.refresh(ns)
    return ns


@pytest.mark.api
class TestKnowledgeBaseInitialMembers:
    """Tests for creating a knowledge base with initial members."""

    def test_create_kb_with_user_members_success(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        target_user: User,
    ):
        """Creating a KB with valid user initial members should succeed."""
        response = test_client.post(
            "/api/knowledge-bases",
            json={
                "name": "kb-with-members",
                "retrieval_config": {"retriever_name": "test"},
                "members": [
                    {
                        "entity_type": "user",
                        "entity_id": str(target_user.id),
                        "role": "Developer",
                    }
                ],
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 201
        data = response.json()
        kb_id = data["id"]

        # Verify member was added
        members_resp = test_client.get(
            f"/api/share/KnowledgeBase/{kb_id}/members",
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert members_resp.status_code == 200
        members = members_resp.json()["members"]
        assert any(
            m["user_id"] == target_user.id and m["role"] == "Developer" for m in members
        )

    def test_create_kb_with_namespace_member_success(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        namespace: Namespace,
    ):
        """Creating a KB with a namespace entity member should succeed."""
        response = test_client.post(
            "/api/knowledge-bases",
            json={
                "name": "kb-with-ns-member",
                "retrieval_config": {"retriever_name": "test"},
                "members": [
                    {
                        "entity_type": "namespace",
                        "entity_id": str(namespace.id),
                        "role": "Maintainer",
                    }
                ],
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 201
        data = response.json()
        kb_id = data["id"]

        # Verify entity member was added
        members_resp = test_client.get(
            f"/api/share/KnowledgeBase/{kb_id}/members",
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert members_resp.status_code == 200
        members = members_resp.json()["members"]
        assert any(
            m["entity_type"] == "namespace"
            and m["entity_id"] == str(namespace.id)
            and m["role"] == "Maintainer"
            for m in members
        )

    def test_create_kb_with_invalid_user_id_fails(
        self,
        test_client: TestClient,
        kb_owner_token: str,
    ):
        """Creating a KB with an invalid user ID should return 400."""
        response = test_client.post(
            "/api/knowledge-bases",
            json={
                "name": "kb-invalid-user",
                "retrieval_config": {"retriever_name": "test"},
                "members": [
                    {
                        "entity_type": "user",
                        "entity_id": "not_a_number",
                        "role": "Reporter",
                    }
                ],
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 400
        assert "Invalid user ID" in response.json()["detail"]

    def test_create_kb_with_duplicate_members_fails(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        target_user: User,
    ):
        """Creating a KB with duplicate initial members should return 400."""
        response = test_client.post(
            "/api/knowledge-bases",
            json={
                "name": "kb-dup-members",
                "retrieval_config": {"retriever_name": "test"},
                "members": [
                    {
                        "entity_type": "user",
                        "entity_id": str(target_user.id),
                        "role": "Developer",
                    },
                    {
                        "entity_type": "user",
                        "entity_id": str(target_user.id),
                        "role": "Reporter",
                    },
                ],
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert "Failed to add some members" in detail

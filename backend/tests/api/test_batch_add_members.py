# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Integration tests for batch add members API endpoint.

Tests the POST /share/{resource_type}/{resource_id}/members/batch endpoint
for knowledge base multi-user permission management.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
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
    from app.core.security import create_access_token

    return create_access_token(data={"sub": kb_owner.user_name})


@pytest.fixture
def target_users(test_db: Session) -> list[User]:
    """Create multiple target users to be added as members."""
    users = []
    for i in range(3):
        user = User(
            user_name=f"target_user_{i}",
            password_hash=get_password_hash(f"target{i}pass"),
            email=f"target_{i}@example.com",
            is_active=True,
        )
        test_db.add(user)
        users.append(user)
    test_db.commit()
    for u in users:
        test_db.refresh(u)
    return users


@pytest.fixture
def inactive_user(test_db: Session) -> User:
    """Create an inactive user for negative testing."""
    user = User(
        user_name="inactive_target",
        password_hash=get_password_hash("inactive123"),
        email="inactive_target@example.com",
        is_active=False,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture
def knowledge_base(test_db: Session, kb_owner: User) -> Kind:
    """Create a test knowledge base owned by kb_owner."""
    kb = Kind(
        user_id=kb_owner.id,
        kind="KnowledgeBase",
        name="test-kb",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": "test-kb", "namespace": "default"},
            "spec": {"description": "Test knowledge base"},
        },
        is_active=True,
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)
    return kb


@pytest.mark.api
class TestBatchAddMembers:
    """Integration tests for batch add members endpoint."""

    def test_batch_add_multiple_users_success(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Adding multiple valid users in batch should succeed for all."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [{"user_id": u.id, "role": "Reporter"} for u in target_users]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["succeeded"]) == len(target_users)
        assert len(data["failed"]) == 0

        # Verify all members have correct role
        succeeded_user_ids = {m["user_id"] for m in data["succeeded"]}
        for u in target_users:
            assert u.id in succeeded_user_ids

        for member in data["succeeded"]:
            assert member["role"] == "Reporter"
            assert member["status"] == "approved"

    def test_batch_add_with_different_roles(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Adding users with different roles should assign correctly."""
        roles = ["Maintainer", "Developer", "Reporter"]
        members = [
            {"user_id": target_users[i].id, "role": roles[i]}
            for i in range(len(target_users))
        ]
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={"members": members},
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["succeeded"]) == 3
        assert len(data["failed"]) == 0

        # Verify roles match
        role_map = {m["user_id"]: m["role"] for m in data["succeeded"]}
        for i, u in enumerate(target_users):
            assert role_map[u.id] == roles[i]

    def test_batch_add_partial_failure_with_invalid_user(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        target_users: list[User],
        inactive_user: User,
    ):
        """Batch with mix of valid and invalid users returns partial results."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Reporter"},
                    {"user_id": inactive_user.id, "role": "Reporter"},
                    {"user_id": 99999, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["succeeded"]) == 1
        assert len(data["failed"]) == 2

        assert data["succeeded"][0]["user_id"] == target_users[0].id

        failed_user_ids = {f["user_id"] for f in data["failed"]}
        assert inactive_user.id in failed_user_ids
        assert 99999 in failed_user_ids

    def test_batch_add_self_should_fail(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        kb_owner: User,
        target_users: list[User],
    ):
        """Adding self as member should fail for that entry only."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": kb_owner.id, "role": "Maintainer"},
                    {"user_id": target_users[0].id, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["succeeded"]) == 1
        assert len(data["failed"]) == 1
        assert data["failed"][0]["user_id"] == kb_owner.id
        assert "yourself" in data["failed"][0]["error"].lower()

    def test_batch_add_duplicate_user_should_fail_on_second_call(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Adding a user who already has access should fail for that entry."""
        # First add a user - assert this succeeds before testing duplicate
        first_response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert first_response.status_code == 200
        first_data = first_response.json()
        assert any(m["user_id"] == target_users[0].id for m in first_data["succeeded"])

        # Second add should fail for the already-added user
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Developer"},
                    {"user_id": target_users[1].id, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["succeeded"]) == 1
        assert len(data["failed"]) == 1
        assert data["failed"][0]["user_id"] == target_users[0].id
        assert "already" in data["failed"][0]["error"].lower()

    def test_batch_add_requires_authentication(
        self,
        test_client: TestClient,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Batch add without token should return 401."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Reporter"},
                ]
            },
        )
        assert response.status_code == 401

    def test_batch_add_requires_manage_permission(
        self,
        test_client: TestClient,
        test_db: Session,
        test_user: User,
        test_token: str,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Non-owner without manage permission should be denied (403 because user lacks permission)."""
        # Add test_user as a Reporter member (APPROVED) so _get_resource can find the KB,
        # but check_permission(Maintainer) returns False -> triggers 403 instead of 404.
        reporter_member = ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=knowledge_base.id,
            user_id=test_user.id,
            role="Reporter",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=knowledge_base.user_id,
            share_link_id=0,
            reviewed_by_user_id=knowledge_base.user_id,
            copied_resource_id=0,
        )
        test_db.add(reporter_member)
        test_db.commit()

        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {test_token}"},
        )
        # Returns 403 because the user does not have manage permission (Reporter < Maintainer)
        assert response.status_code == 403

    def test_batch_add_empty_members_returns_validation_error(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
    ):
        """Empty members list should return 422 validation error."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members/batch",
            json={"members": []},
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 422

    def test_batch_add_nonexistent_resource_returns_404(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        target_users: list[User],
    ):
        """Batch add to nonexistent KB should return 404."""
        response = test_client.post(
            "/api/share/KnowledgeBase/99999/members/batch",
            json={
                "members": [
                    {"user_id": target_users[0].id, "role": "Reporter"},
                ]
            },
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 404


@pytest.mark.api
class TestSingleAddMember:
    """Integration tests for existing single add member endpoint to ensure compatibility."""

    def test_single_add_member_still_works(
        self,
        test_client: TestClient,
        kb_owner_token: str,
        knowledge_base: Kind,
        target_users: list[User],
    ):
        """Existing single add member endpoint should continue to work."""
        response = test_client.post(
            f"/api/share/KnowledgeBase/{knowledge_base.id}/members",
            json={"user_id": target_users[0].id, "role": "Developer"},
            headers={"Authorization": f"Bearer {kb_owner_token}"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["user_id"] == target_users[0].id
        assert data["role"] == "Developer"
        assert data["status"] == "approved"

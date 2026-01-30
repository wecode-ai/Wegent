# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for knowledge base permission service.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge_permission import (
    ApprovalStatus,
    KnowledgeBasePermission,
    PermissionLevel,
)
from app.models.user import User
from app.schemas.knowledge_permission import (
    PermissionAction,
    PermissionLevelUpdate,
    PermissionRequestCreate,
)
from app.services.knowledge.knowledge_permission_service import (
    KnowledgePermissionService,
)


@pytest.fixture
def test_user(test_db: Session):
    """Create a test user."""
    user = User(
        user_name="testuser",
        email="test@example.com",
        password_hash="hashed_password",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def test_kb_owner(test_db: Session):
    """Create a test user who owns a knowledge base."""
    user = User(
        user_name="kbowner",
        email="owner@example.com",
        password_hash="hashed_password",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def test_knowledge_base(test_db: Session, test_kb_owner: User):
    """Create a test knowledge base."""
    kb = Kind(
        kind="KnowledgeBase",
        user_id=test_kb_owner.id,
        namespace="default",
        json={
            "spec": {
                "name": "Test Knowledge Base",
                "description": "Test description",
            }
        },
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


@pytest.fixture
def test_requester(test_db: Session):
    """Create a test user who requests access."""
    user = User(
        user_name="requester",
        email="requester@example.com",
        password_hash="hashed_password",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


class TestKnowledgePermissionService:
    """Test cases for KnowledgePermissionService."""

    def test_check_permission_owner(self, db: Session, test_knowledge_base: Kind, test_kb_owner: User):
        """Test permission check for KB owner."""
        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, test_knowledge_base.id, test_kb_owner.id
        )

        assert has_access is True
        assert permission_level == PermissionLevel.MANAGE
        assert is_owner is True

    def test_check_permission_no_access(self, db: Session, test_knowledge_base: Kind, test_user: User):
        """Test permission check for user without access."""
        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, test_knowledge_base.id, test_user.id
        )

        assert has_access is False
        assert permission_level is None
        assert is_owner is False

    def test_check_permission_approved_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test permission check for user with approved permission."""
        # Create approved permission
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_access is True
        assert permission_level == PermissionLevel.VIEW
        assert is_owner is False

    def test_check_permission_pending_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test permission check for user with pending permission."""
        # Create pending permission
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_access is False
        assert permission_level is None
        assert is_owner is False

    def test_check_manage_permission_owner(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User
    ):
        """Test manage permission check for owner."""
        has_manage = KnowledgePermissionService.check_manage_permission(
            db, test_knowledge_base.id, test_kb_owner.id
        )

        assert has_manage is True

    def test_check_manage_permission_approved_manage_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test manage permission check for user with manage permission."""
        # Create approved permission with manage level
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.MANAGE.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_manage = KnowledgePermissionService.check_manage_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_manage is True

    def test_check_manage_permission_approved_view_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test manage permission check for user with view permission."""
        # Create approved permission with view level
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_manage = KnowledgePermissionService.check_manage_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_manage is False

    def test_check_edit_permission_owner(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User
    ):
        """Test edit permission check for owner."""
        has_edit = KnowledgePermissionService.check_edit_permission(
            db, test_knowledge_base.id, test_kb_owner.id
        )

        assert has_edit is True

    def test_check_edit_permission_approved_edit_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test edit permission check for user with edit permission."""
        # Create approved permission with edit level
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.EDIT.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_edit = KnowledgePermissionService.check_edit_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_edit is True

    def test_check_edit_permission_approved_view_user(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test edit permission check for user with view permission."""
        # Create approved permission with view level
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        has_edit = KnowledgePermissionService.check_edit_permission(
            db, test_knowledge_base.id, test_requester.id
        )

        assert has_edit is False

    def test_request_access_new_request(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test requesting access for the first time."""
        data = PermissionRequestCreate(permission_level=PermissionLevel.VIEW)

        permission = KnowledgePermissionService.request_access(
            db, test_knowledge_base.id, test_requester.id, data
        )

        assert permission.knowledge_base_id == test_knowledge_base.id
        assert permission.user_id == test_requester.id
        assert permission.permission_level == PermissionLevel.VIEW.value
        assert permission.approval_status == ApprovalStatus.PENDING.value
        assert permission.requested_by == test_requester.id

    def test_request_access_duplicate_pending(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test requesting access when there's already a pending request."""
        # Create existing pending request
        existing = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=test_requester.id,
        )
        db.add(existing)
        db.commit()

        # Request again with different permission level
        data = PermissionRequestCreate(permission_level=PermissionLevel.EDIT)
        permission = KnowledgePermissionService.request_access(
            db, test_knowledge_base.id, test_requester.id, data
        )

        # Should update existing pending request
        assert permission.id == existing.id
        assert permission.permission_level == PermissionLevel.EDIT.value

    def test_request_access_already_approved(
        self, db: Session, test_knowledge_base: Kind, test_requester: User
    ):
        """Test requesting access when user already has approved access."""
        # Create approved permission
        existing = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(existing)
        db.commit()

        data = PermissionRequestCreate(permission_level=PermissionLevel.EDIT)

        with pytest.raises(ValueError, match="already has access"):
            KnowledgePermissionService.request_access(
                db, test_knowledge_base.id, test_requester.id, data
            )

    def test_request_access_owner_cannot_request(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User
    ):
        """Test that owner cannot request access to their own KB."""
        data = PermissionRequestCreate(permission_level=PermissionLevel.VIEW)

        with pytest.raises(ValueError, match="Owner cannot request"):
            KnowledgePermissionService.request_access(
                db, test_knowledge_base.id, test_kb_owner.id, data
            )

    def test_approve_request(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test approving a permission request."""
        # Create pending request
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        data = PermissionAction(action="approve", permission_level=PermissionLevel.EDIT)

        updated = KnowledgePermissionService.approve_or_reject_request(
            db, test_knowledge_base.id, permission.id, test_kb_owner.id, data
        )

        assert updated.approval_status == ApprovalStatus.APPROVED.value
        assert updated.permission_level == PermissionLevel.EDIT.value
        assert updated.approved_by == test_kb_owner.id

    def test_reject_request(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test rejecting a permission request."""
        # Create pending request
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        data = PermissionAction(action="reject")

        updated = KnowledgePermissionService.approve_or_reject_request(
            db, test_knowledge_base.id, permission.id, test_kb_owner.id, data
        )

        assert updated.approval_status == ApprovalStatus.REJECTED.value
        assert updated.approved_by == test_kb_owner.id

    def test_remove_permission(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test removing a user's permission."""
        # Create approved permission
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        KnowledgePermissionService.remove_permission(
            db, test_knowledge_base.id, permission.id, test_kb_owner.id
        )

        # Verify permission is deleted
        deleted = (
            db.query(KnowledgeBasePermission)
            .filter(KnowledgeBasePermission.id == permission.id)
            .first()
        )
        assert deleted is None

    def test_remove_permission_owner_cannot_be_removed(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User
    ):
        """Test that owner's permission cannot be removed."""
        # Try to remove owner's permission (which doesn't exist in permissions table)
        # This should fail because we check if user_id matches kb.user_id
        with pytest.raises(ValueError, match="Cannot remove owner"):
            # Create a fake permission record for owner
            fake_permission = KnowledgeBasePermission(
                knowledge_base_id=test_knowledge_base.id,
                user_id=test_kb_owner.id,
                permission_level=PermissionLevel.MANAGE.value,
                approval_status=ApprovalStatus.APPROVED.value,
                requested_by=test_kb_owner.id,
            )
            db.add(fake_permission)
            db.commit()

            KnowledgePermissionService.remove_permission(
                db, test_knowledge_base.id, fake_permission.id, test_kb_owner.id
            )

    def test_update_permission_level(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test updating a user's permission level."""
        # Create approved permission
        permission = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=test_requester.id,
        )
        db.add(permission)
        db.commit()

        data = PermissionLevelUpdate(permission_level=PermissionLevel.MANAGE)

        updated = KnowledgePermissionService.update_permission_level(
            db, test_knowledge_base.id, permission.id, test_kb_owner.id, data
        )

        assert updated.permission_level == PermissionLevel.MANAGE.value

    def test_list_permissions(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test listing permissions for a knowledge base."""
        # Create multiple permissions
        for i in range(3):
            user = User(
                user_name=f"user{i}",
                email=f"user{i}@example.com",
                password_hash="hashed_password",
            )
            db.add(user)
            db.flush()

            permission = KnowledgeBasePermission(
                knowledge_base_id=test_knowledge_base.id,
                user_id=user.id,
                permission_level=PermissionLevel.VIEW.value,
                approval_status=ApprovalStatus.APPROVED.value,
                requested_by=user.id,
            )
            db.add(permission)

        db.commit()

        permissions, total = KnowledgePermissionService.list_permissions(
            db, test_knowledge_base.id, test_kb_owner.id
        )

        assert total == 3
        assert len(permissions) == 3

    def test_list_permissions_filter_by_status(
        self, db: Session, test_knowledge_base: Kind, test_kb_owner: User, test_requester: User
    ):
        """Test listing permissions filtered by status."""
        # Create pending permission
        pending = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=test_requester.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=test_requester.id,
        )
        db.add(pending)

        # Create approved permission
        approved_user = User(
            user_name="approveduser",
            email="approved@example.com",
            password_hash="hashed_password",
        )
        db.add(approved_user)
        db.flush()

        approved = KnowledgeBasePermission(
            knowledge_base_id=test_knowledge_base.id,
            user_id=approved_user.id,
            permission_level=PermissionLevel.VIEW.value,
            approval_status=ApprovalStatus.APPROVED.value,
            requested_by=approved_user.id,
        )
        db.add(approved)
        db.commit()

        # List pending permissions
        pending_permissions, pending_total = KnowledgePermissionService.list_permissions(
            db, test_knowledge_base.id, test_kb_owner.id, status=ApprovalStatus.PENDING
        )

        assert pending_total == 1
        assert len(pending_permissions) == 1
        assert pending_permissions[0].id == pending.id

        # List approved permissions
        approved_permissions, approved_total = KnowledgePermissionService.list_permissions(
            db, test_knowledge_base.id, test_kb_owner.id, status=ApprovalStatus.APPROVED
        )

        assert approved_total == 1
        assert len(approved_permissions) == 1
        assert approved_permissions[0].id == approved.id
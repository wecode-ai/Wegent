# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base permission service.

Provides business logic for knowledge base sharing and permission management.
"""

import logging
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge_permission import (
    KnowledgeBasePermission,
    PermissionLevel,
    PermissionStatus,
)
from app.models.user import User
from app.schemas.knowledge_permission import (
    ApprovedPermissionsByLevel,
    MyPermissionResponse,
    PendingPermissionInfo,
    PendingRequestInfo,
    PermissionAddRequest,
    PermissionApplyRequest,
    PermissionApplyResponse,
)
from app.schemas.knowledge_permission import PermissionLevel as SchemaPermissionLevel
from app.schemas.knowledge_permission import (
    PermissionListResponse,
    PermissionResponse,
    PermissionReviewRequest,
    PermissionReviewResponse,
)
from app.schemas.knowledge_permission import PermissionStatus as SchemaPermissionStatus
from app.schemas.knowledge_permission import (
    PermissionUpdateRequest,
    PermissionUserInfo,
    ReviewAction,
)
from app.services.group_permission import get_effective_role_in_group

logger = logging.getLogger(__name__)


class KnowledgePermissionService:
    """Service for managing knowledge base permissions."""

    # ============== Permission Level Utilities ==============

    @staticmethod
    def get_permission_priority(level: PermissionLevel) -> int:
        """Get priority value for permission level (higher = more permissions)."""
        priority_map = {
            PermissionLevel.VIEW: 1,
            PermissionLevel.EDIT: 2,
            PermissionLevel.MANAGE: 3,
        }
        return priority_map.get(level, 0)

    @staticmethod
    def has_permission(
        user_level: Optional[PermissionLevel],
        required_level: PermissionLevel,
    ) -> bool:
        """Check if user's permission level meets the required level."""
        if user_level is None:
            return False
        user_priority = KnowledgePermissionService.get_permission_priority(user_level)
        required_priority = KnowledgePermissionService.get_permission_priority(
            required_level
        )
        return user_priority >= required_priority

    # ============== Permission Check Methods ==============

    @staticmethod
    def get_user_kb_permission(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> Tuple[bool, Optional[PermissionLevel], bool]:
        """
        Get user's permission for a knowledge base.

        Returns:
            Tuple of (has_access, permission_level, is_creator)
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            return False, None, False

        # Check if user is creator
        if kb.user_id == user_id:
            return True, PermissionLevel.MANAGE, True

        # Check explicit permission in knowledge_base_permissions table
        explicit_perm = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
                KnowledgeBasePermission.user_id == user_id,
                KnowledgeBasePermission.status == PermissionStatus.APPROVED,
            )
            .first()
        )

        if explicit_perm:
            return True, explicit_perm.permission_level, False

        # For team knowledge bases, check group permission
        if kb.namespace != "default":
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is not None:
                # Map group role to permission level
                # Owner/Maintainer -> manage, Developer -> edit, Reporter -> view
                role_mapping = {
                    "Owner": PermissionLevel.MANAGE,
                    "Maintainer": PermissionLevel.MANAGE,
                    "Developer": PermissionLevel.EDIT,
                    "Reporter": PermissionLevel.VIEW,
                }
                return True, role_mapping.get(role, PermissionLevel.VIEW), False

        return False, None, False

    @staticmethod
    def can_manage_permissions(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """Check if user can manage permissions for a knowledge base."""
        has_access, level, is_creator = (
            KnowledgePermissionService.get_user_kb_permission(
                db, knowledge_base_id, user_id
            )
        )
        if is_creator:
            return True
        return has_access and level == PermissionLevel.MANAGE

    # ============== Permission Apply ==============

    @staticmethod
    def apply_permission(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        request: PermissionApplyRequest,
    ) -> PermissionApplyResponse:
        """
        Apply for knowledge base access permission.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Applicant user ID
            request: Permission apply request

        Returns:
            PermissionApplyResponse

        Raises:
            ValueError: If validation fails
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        # Check if user is the creator
        if kb.user_id == user_id:
            raise ValueError("Creator already has full access to this knowledge base")

        # Check existing permission record
        existing = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
                KnowledgeBasePermission.user_id == user_id,
            )
            .first()
        )

        now = datetime.now()

        if existing:
            if existing.status == PermissionStatus.APPROVED:
                raise ValueError("You already have access to this knowledge base")
            if existing.status == PermissionStatus.PENDING:
                raise ValueError(
                    "You already have a pending request for this knowledge base"
                )
            # Rejected status - allow reapply by updating the record
            existing.permission_level = PermissionLevel(request.permission_level.value)
            existing.status = PermissionStatus.PENDING
            existing.requested_at = now
            existing.reviewed_at = None
            existing.reviewed_by = None
            existing.updated_at = now
            db.flush()
            perm = existing
            message = "Permission request resubmitted successfully"
        else:
            # Create new permission request
            perm = KnowledgeBasePermission(
                knowledge_base_id=knowledge_base_id,
                user_id=user_id,
                permission_level=PermissionLevel(request.permission_level.value),
                status=PermissionStatus.PENDING,
                requested_at=now,
                created_at=now,
                updated_at=now,
            )
            db.add(perm)
            db.flush()
            message = "Permission request submitted successfully"

        return PermissionApplyResponse(
            id=perm.id,
            knowledge_base_id=perm.knowledge_base_id,
            permission_level=SchemaPermissionLevel(perm.permission_level.value),
            status=SchemaPermissionStatus(perm.status.value),
            requested_at=perm.requested_at,
            message=message,
        )

    # ============== Permission Review ==============

    @staticmethod
    def review_permission(
        db: Session,
        knowledge_base_id: int,
        permission_id: int,
        reviewer_id: int,
        request: PermissionReviewRequest,
    ) -> PermissionReviewResponse:
        """
        Review a permission request (approve or reject).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            permission_id: Permission record ID
            reviewer_id: Reviewer user ID
            request: Review request

        Returns:
            PermissionReviewResponse

        Raises:
            ValueError: If validation fails
        """
        # Check reviewer has manage permission
        if not KnowledgePermissionService.can_manage_permissions(
            db, knowledge_base_id, reviewer_id
        ):
            raise ValueError("You don't have permission to manage this knowledge base")

        # Get the permission record
        perm = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
            )
            .first()
        )

        if not perm:
            raise ValueError("Permission request not found")

        if perm.status != PermissionStatus.PENDING:
            raise ValueError("Permission request is not pending")

        now = datetime.now()

        if request.action == ReviewAction.APPROVE:
            # Use the requested level or the one specified in review
            final_level = (
                PermissionLevel(request.permission_level.value)
                if request.permission_level
                else perm.permission_level
            )
            perm.permission_level = final_level
            perm.status = PermissionStatus.APPROVED
            message = "Permission request approved"
        else:  # REJECT
            perm.status = PermissionStatus.REJECTED
            message = "Permission request rejected"

        perm.reviewed_at = now
        perm.reviewed_by = reviewer_id
        perm.updated_at = now
        db.flush()

        return PermissionReviewResponse(
            id=perm.id,
            user_id=perm.user_id,
            permission_level=SchemaPermissionLevel(perm.permission_level.value),
            status=SchemaPermissionStatus(perm.status.value),
            reviewed_at=perm.reviewed_at,
            message=message,
        )

    # ============== Permission Management ==============

    @staticmethod
    def list_permissions(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> PermissionListResponse:
        """
        List all permissions for a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            PermissionListResponse grouped by status

        Raises:
            ValueError: If user doesn't have manage permission
        """
        # Check user has manage permission
        if not KnowledgePermissionService.can_manage_permissions(
            db, knowledge_base_id, user_id
        ):
            raise ValueError("You don't have permission to manage this knowledge base")

        # Get all permissions for this KB
        permissions = (
            db.query(KnowledgeBasePermission)
            .filter(KnowledgeBasePermission.knowledge_base_id == knowledge_base_id)
            .all()
        )

        # Get user info for all users
        user_ids = [p.user_id for p in permissions]
        users = db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []
        user_map = {u.id: u for u in users}

        # Build response
        pending = []
        approved = ApprovedPermissionsByLevel()

        for perm in permissions:
            user = user_map.get(perm.user_id)
            user_info = PermissionUserInfo(
                id=perm.id,
                user_id=perm.user_id,
                username=user.user_name if user else f"User {perm.user_id}",
                email=user.email if user else None,
                permission_level=SchemaPermissionLevel(perm.permission_level.value),
                requested_at=perm.requested_at,
                reviewed_at=perm.reviewed_at,
                reviewed_by=perm.reviewed_by,
            )

            if perm.status == PermissionStatus.PENDING:
                pending.append(
                    PendingPermissionInfo(
                        id=perm.id,
                        user_id=perm.user_id,
                        username=user.user_name if user else f"User {perm.user_id}",
                        email=user.email if user else None,
                        permission_level=SchemaPermissionLevel(
                            perm.permission_level.value
                        ),
                        requested_at=perm.requested_at,
                    )
                )
            elif perm.status == PermissionStatus.APPROVED:
                if perm.permission_level == PermissionLevel.VIEW:
                    approved.view.append(user_info)
                elif perm.permission_level == PermissionLevel.EDIT:
                    approved.edit.append(user_info)
                elif perm.permission_level == PermissionLevel.MANAGE:
                    approved.manage.append(user_info)

        return PermissionListResponse(pending=pending, approved=approved)

    @staticmethod
    def add_permission(
        db: Session,
        knowledge_base_id: int,
        admin_user_id: int,
        request: PermissionAddRequest,
    ) -> PermissionResponse:
        """
        Directly add permission for a user (without request).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            admin_user_id: Admin user ID (who is adding)
            request: Permission add request (uses user_name to identify user)

        Returns:
            PermissionResponse

        Raises:
            ValueError: If validation fails
        """
        # Check admin has manage permission
        if not KnowledgePermissionService.can_manage_permissions(
            db, knowledge_base_id, admin_user_id
        ):
            raise ValueError("You don't have permission to manage this knowledge base")

        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        # Find user by user_name
        target_user = db.query(User).filter(User.user_name == request.user_name).first()
        if not target_user:
            raise ValueError(f"User '{request.user_name}' not found")

        # Can't add permission for the creator
        if kb.user_id == target_user.id:
            raise ValueError("Cannot add permission for the knowledge base creator")

        # Check existing permission
        existing = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
                KnowledgeBasePermission.user_id == target_user.id,
            )
            .first()
        )

        now = datetime.now()

        if existing:
            # Update existing permission
            existing.permission_level = PermissionLevel(request.permission_level.value)
            existing.status = PermissionStatus.APPROVED
            existing.reviewed_at = now
            existing.reviewed_by = admin_user_id
            existing.updated_at = now
            db.flush()
            perm = existing
        else:
            # Create new permission
            perm = KnowledgeBasePermission(
                knowledge_base_id=knowledge_base_id,
                user_id=target_user.id,
                permission_level=PermissionLevel(request.permission_level.value),
                status=PermissionStatus.APPROVED,
                requested_at=now,
                reviewed_at=now,
                reviewed_by=admin_user_id,
                created_at=now,
                updated_at=now,
            )
            db.add(perm)
            db.flush()

        return PermissionResponse(
            id=perm.id,
            knowledge_base_id=perm.knowledge_base_id,
            user_id=perm.user_id,
            permission_level=SchemaPermissionLevel(perm.permission_level.value),
            status=SchemaPermissionStatus(perm.status.value),
            requested_at=perm.requested_at,
            reviewed_at=perm.reviewed_at,
            reviewed_by=perm.reviewed_by,
            created_at=perm.created_at,
            updated_at=perm.updated_at,
        )

    @staticmethod
    def update_permission(
        db: Session,
        knowledge_base_id: int,
        permission_id: int,
        admin_user_id: int,
        request: PermissionUpdateRequest,
    ) -> PermissionResponse:
        """
        Update a user's permission level.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            permission_id: Permission record ID
            admin_user_id: Admin user ID
            request: Permission update request

        Returns:
            PermissionResponse

        Raises:
            ValueError: If validation fails
        """
        # Check admin has manage permission
        if not KnowledgePermissionService.can_manage_permissions(
            db, knowledge_base_id, admin_user_id
        ):
            raise ValueError("You don't have permission to manage this knowledge base")

        # Get the permission record
        perm = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
            )
            .first()
        )

        if not perm:
            raise ValueError("Permission record not found")

        if perm.status != PermissionStatus.APPROVED:
            raise ValueError("Can only update approved permissions")

        now = datetime.now()
        perm.permission_level = PermissionLevel(request.permission_level.value)
        perm.updated_at = now
        db.flush()

        return PermissionResponse(
            id=perm.id,
            knowledge_base_id=perm.knowledge_base_id,
            user_id=perm.user_id,
            permission_level=SchemaPermissionLevel(perm.permission_level.value),
            status=SchemaPermissionStatus(perm.status.value),
            requested_at=perm.requested_at,
            reviewed_at=perm.reviewed_at,
            reviewed_by=perm.reviewed_by,
            created_at=perm.created_at,
            updated_at=perm.updated_at,
        )

    @staticmethod
    def delete_permission(
        db: Session,
        knowledge_base_id: int,
        permission_id: int,
        admin_user_id: int,
    ) -> bool:
        """
        Delete (revoke) a user's permission.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            permission_id: Permission record ID
            admin_user_id: Admin user ID

        Returns:
            True if deleted successfully

        Raises:
            ValueError: If validation fails
        """
        # Check admin has manage permission
        if not KnowledgePermissionService.can_manage_permissions(
            db, knowledge_base_id, admin_user_id
        ):
            raise ValueError("You don't have permission to manage this knowledge base")

        # Get the permission record
        perm = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
            )
            .first()
        )

        if not perm:
            raise ValueError("Permission record not found")

        db.delete(perm)
        db.flush()
        return True

    # ============== Current User Permission ==============

    @staticmethod
    def get_my_permission(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> MyPermissionResponse:
        """
        Get current user's permission for a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Current user ID

        Returns:
            MyPermissionResponse
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            return MyPermissionResponse(
                has_access=False,
                permission_level=None,
                is_creator=False,
                pending_request=None,
            )

        # Check if user is creator
        is_creator = kb.user_id == user_id
        if is_creator:
            return MyPermissionResponse(
                has_access=True,
                permission_level=SchemaPermissionLevel.MANAGE,
                is_creator=True,
                pending_request=None,
            )

        # Check explicit permission
        explicit_perm = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == knowledge_base_id,
                KnowledgeBasePermission.user_id == user_id,
            )
            .first()
        )

        pending_request = None
        has_explicit_access = False
        explicit_level = None

        if explicit_perm:
            if explicit_perm.status == PermissionStatus.APPROVED:
                has_explicit_access = True
                explicit_level = SchemaPermissionLevel(
                    explicit_perm.permission_level.value
                )
            elif explicit_perm.status == PermissionStatus.PENDING:
                pending_request = PendingRequestInfo(
                    id=explicit_perm.id,
                    permission_level=SchemaPermissionLevel(
                        explicit_perm.permission_level.value
                    ),
                    requested_at=explicit_perm.requested_at,
                )

        # Check group permission for team KB
        group_level = None
        if kb.namespace != "default":
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is not None:
                role_mapping = {
                    "Owner": SchemaPermissionLevel.MANAGE,
                    "Maintainer": SchemaPermissionLevel.MANAGE,
                    "Developer": SchemaPermissionLevel.EDIT,
                    "Reporter": SchemaPermissionLevel.VIEW,
                }
                group_level = role_mapping.get(role)

        # Determine final access level (higher of explicit vs group)
        if has_explicit_access and group_level:
            # Take the higher permission
            explicit_priority = KnowledgePermissionService.get_permission_priority(
                PermissionLevel(explicit_level.value)
            )
            group_priority = KnowledgePermissionService.get_permission_priority(
                PermissionLevel(group_level.value)
            )
            final_level = (
                explicit_level if explicit_priority >= group_priority else group_level
            )
            return MyPermissionResponse(
                has_access=True,
                permission_level=final_level,
                is_creator=False,
                pending_request=None,
            )
        elif has_explicit_access:
            return MyPermissionResponse(
                has_access=True,
                permission_level=explicit_level,
                is_creator=False,
                pending_request=None,
            )
        elif group_level:
            return MyPermissionResponse(
                has_access=True,
                permission_level=group_level,
                is_creator=False,
                pending_request=pending_request,
            )
        else:
            return MyPermissionResponse(
                has_access=False,
                permission_level=None,
                is_creator=False,
                pending_request=pending_request,
            )

    # ============== Cleanup Methods ==============

    @staticmethod
    def delete_permissions_for_kb(
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Delete all permissions for a knowledge base (called when KB is deleted).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(KnowledgeBasePermission)
            .filter(KnowledgeBasePermission.knowledge_base_id == knowledge_base_id)
            .delete()
        )
        db.flush()
        return result

    @staticmethod
    def delete_permissions_for_user(
        db: Session,
        user_id: int,
    ) -> int:
        """
        Delete all permissions for a user (called when user is deleted).

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(KnowledgeBasePermission)
            .filter(KnowledgeBasePermission.user_id == user_id)
            .delete()
        )
        db.flush()
        return result

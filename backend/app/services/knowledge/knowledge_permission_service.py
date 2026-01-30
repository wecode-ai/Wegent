# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base permission service for managing access requests and permissions.
"""

from datetime import datetime
from typing import Optional

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
    PermissionResponse,
)
from app.services.webhook_notification import (
    KnowledgeAccessNotification,
    KnowledgeApprovalNotification,
    webhook_notification_service,
)


class KnowledgePermissionService:
    """Service for managing knowledge base permissions."""

    @staticmethod
    def get_knowledge_base(db: Session, kb_id: int) -> Optional[Kind]:
        """
        Get knowledge base by ID.

        Args:
            db: Database session
            kb_id: Knowledge base ID

        Returns:
            Kind object if found, None otherwise
        """
        return (
            db.query(Kind)
            .filter(Kind.id == kb_id, Kind.kind == "KnowledgeBase")
            .first()
        )

    @staticmethod
    def check_permission(
        db: Session, kb_id: int, user_id: int
    ) -> tuple[bool, Optional[PermissionLevel], bool]:
        """
        Check if user has access to a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID

        Returns:
            Tuple of (has_access, permission_level, is_owner)
        """
        kb = KnowledgePermissionService.get_knowledge_base(db, kb_id)
        if not kb:
            return False, None, False

        # Check if user is owner
        if kb.user_id == user_id:
            return True, PermissionLevel.MANAGE, True

        # Check if user has approved permission
        permission = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == kb_id,
                KnowledgeBasePermission.user_id == user_id,
                KnowledgeBasePermission.approval_status == ApprovalStatus.APPROVED,
            )
            .first()
        )

        if permission:
            return True, PermissionLevel(permission.permission_level), False

        return False, None, False

    @staticmethod
    def check_manage_permission(db: Session, kb_id: int, user_id: int) -> bool:
        """
        Check if user has manage permission (owner or approved with manage level).

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID

        Returns:
            True if user has manage permission, False otherwise
        """
        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, kb_id, user_id
        )
        return has_access and (is_owner or permission_level == PermissionLevel.MANAGE)

    @staticmethod
    def check_edit_permission(db: Session, kb_id: int, user_id: int) -> bool:
        """
        Check if user has edit permission (owner or approved with edit/manage level).

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID

        Returns:
            True if user has edit permission, False otherwise
        """
        has_access, permission_level, is_owner = KnowledgePermissionService.check_permission(
            db, kb_id, user_id
        )
        if not has_access:
            return False
        if is_owner:
            return True
        return permission_level in [PermissionLevel.EDIT, PermissionLevel.MANAGE]

    @staticmethod
    def request_access(
        db: Session, kb_id: int, user_id: int, data: PermissionRequestCreate
    ) -> KnowledgeBasePermission:
        """
        Request access to a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID requesting access
            data: Permission request data

        Returns:
            Created or updated permission record

        Raises:
            ValueError: If KB doesn't exist or user already has approved access
        """
        kb = KnowledgePermissionService.get_knowledge_base(db, kb_id)
        if not kb:
            raise ValueError("Knowledge base not found")

        # Check if user is owner
        if kb.user_id == user_id:
            raise ValueError("Owner cannot request access to their own knowledge base")

        # Check if user already has approved permission
        has_access, _, _ = KnowledgePermissionService.check_permission(db, kb_id, user_id)
        if has_access:
            raise ValueError("User already has access to this knowledge base")

        # Check if there's a pending request, update it instead of creating new one
        existing_pending = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == kb_id,
                KnowledgeBasePermission.user_id == user_id,
                KnowledgeBasePermission.approval_status == ApprovalStatus.PENDING,
            )
            .first()
        )

        if existing_pending:
            # Update existing pending request
            existing_pending.permission_level = data.permission_level.value
            db.commit()
            db.refresh(existing_pending)
            return existing_pending

        # Create new permission request
        permission = KnowledgeBasePermission(
            knowledge_base_id=kb_id,
            user_id=user_id,
            permission_level=data.permission_level.value,
            approval_status=ApprovalStatus.PENDING.value,
            requested_by=user_id,
        )
        db.add(permission)
        db.commit()
        db.refresh(permission)

        # Send webhook notification to KB owner
        try:
            requester = db.query(User).filter(User.id == user_id).first()
            if requester:
                notification = KnowledgeAccessNotification(
                    user_name=kb.user_id,  # KB owner's user ID for header replacement
                    event="knowledge_access_request",
                    kb_id=kb_id,
                    kb_name=kb.json.get("spec", {}).get("name", ""),
                    requester_user_id=user_id,
                    requester_user_name=requester.username,
                    requested_permission=data.permission_level.value,
                    request_time=permission.created_at.isoformat(),
                    detail_url=f"/knowledge/{kb_id}/permissions",
                )
                webhook_notification_service.send_knowledge_access_notification(notification)
        except Exception as e:
            # Log error but don't fail the request
            import logging

            logger = logging.getLogger(__name__)
            logger.error(f"Failed to send webhook notification: {e}")

        return permission

    @staticmethod
    def list_permissions(
        db: Session,
        kb_id: int,
        user_id: int,
        status: Optional[ApprovalStatus] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[KnowledgeBasePermission], int]:
        """
        List permissions for a knowledge base (only accessible to owner/managers).

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID requesting the list
            status: Optional filter by approval status
            page: Page number (1-based)
            page_size: Page size

        Returns:
            Tuple of (permissions list, total count)

        Raises:
            ValueError: If user doesn't have manage permission
        """
        # Check manage permission
        if not KnowledgePermissionService.check_manage_permission(db, kb_id, user_id):
            raise ValueError("User does not have permission to view permissions")

        query = db.query(KnowledgeBasePermission).filter(
            KnowledgeBasePermission.knowledge_base_id == kb_id
        )

        if status:
            query = query.filter(KnowledgeBasePermission.approval_status == status.value)

        # Get total count
        total = query.count()

        # Apply pagination
        permissions = (
            query.order_by(KnowledgeBasePermission.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )

        return permissions, total

    @staticmethod
    def approve_or_reject_request(
        db: Session,
        kb_id: int,
        permission_id: int,
        user_id: int,
        data: PermissionAction,
    ) -> KnowledgeBasePermission:
        """
        Approve or reject a permission request.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            permission_id: Permission record ID
            user_id: User ID approving/rejecting (must be owner/manager)
            data: Action data

        Returns:
            Updated permission record

        Raises:
            ValueError: If permission not found, user doesn't have manage permission,
                        or invalid action
        """
        # Check manage permission
        if not KnowledgePermissionService.check_manage_permission(db, kb_id, user_id):
            raise ValueError("User does not have permission to approve/reject requests")

        # Get permission record
        permission = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == kb_id,
            )
            .first()
        )

        if not permission:
            raise ValueError("Permission record not found")

        # Process action
        if data.action == "approve":
            if not data.permission_level:
                raise ValueError("permission_level is required for approve action")
            permission.approval_status = ApprovalStatus.APPROVED.value
            permission.permission_level = data.permission_level.value
            permission.approved_by = user_id
        elif data.action == "reject":
            permission.approval_status = ApprovalStatus.REJECTED.value
            permission.approved_by = user_id
        else:
            raise ValueError(f"Invalid action: {data.action}")

        db.commit()
        db.refresh(permission)

        # Send webhook notification to requester
        try:
            kb = KnowledgePermissionService.get_knowledge_base(db, kb_id)
            approver = db.query(User).filter(User.id == user_id).first()
            requester = db.query(User).filter(User.id == permission.user_id).first()

            if kb and approver and requester:
                event_type = (
                    "knowledge_access_approved"
                    if data.action == "approve"
                    else "knowledge_access_rejected"
                )
                notification = KnowledgeApprovalNotification(
                    user_name=requester.username,  # Requester's username for header replacement
                    event=event_type,
                    kb_id=kb_id,
                    kb_name=kb.json.get("spec", {}).get("name", ""),
                    user_id=permission.user_id,
                    user_name_str=requester.username,
                    permission_level=permission.permission_level,
                    approved_by=approver.username,
                    approved_time=permission.updated_at.isoformat(),
                    detail_url=f"/knowledge/{kb_id}",
                )
                webhook_notification_service.send_knowledge_approval_notification(notification)
        except Exception as e:
            # Log error but don't fail the operation
            import logging

            logger = logging.getLogger(__name__)
            logger.error(f"Failed to send webhook notification: {e}")

        return permission

    @staticmethod
    def remove_permission(
        db: Session, kb_id: int, permission_id: int, user_id: int
    ) -> KnowledgeBasePermission:
        """
        Remove a user's permission from a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            permission_id: Permission record ID
            user_id: User ID removing the permission (must be owner/manager)

        Returns:
            Deleted permission record

        Raises:
            ValueError: If permission not found, user doesn't have manage permission,
                        or trying to remove owner's permission
        """
        # Check manage permission
        if not KnowledgePermissionService.check_manage_permission(db, kb_id, user_id):
            raise ValueError("User does not have permission to remove permissions")

        # Get permission record
        permission = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == kb_id,
            )
            .first()
        )

        if not permission:
            raise ValueError("Permission record not found")

        # Get KB to check if trying to remove owner
        kb = KnowledgePermissionService.get_knowledge_base(db, kb_id)
        if kb and kb.user_id == permission.user_id:
            raise ValueError("Cannot remove owner's permission")

        # Delete permission
        db.delete(permission)
        db.commit()
        return permission

    @staticmethod
    def update_permission_level(
        db: Session,
        kb_id: int,
        permission_id: int,
        user_id: int,
        data: PermissionLevelUpdate,
    ) -> KnowledgeBasePermission:
        """
        Update a user's permission level.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            permission_id: Permission record ID
            user_id: User ID updating the permission (must be owner/manager)
            data: New permission level

        Returns:
            Updated permission record

        Raises:
            ValueError: If permission not found, user doesn't have manage permission,
                        or trying to update owner's permission
        """
        # Check manage permission
        if not KnowledgePermissionService.check_manage_permission(db, kb_id, user_id):
            raise ValueError("User does not have permission to update permissions")

        # Get permission record
        permission = (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.id == permission_id,
                KnowledgeBasePermission.knowledge_base_id == kb_id,
            )
            .first()
        )

        if not permission:
            raise ValueError("Permission record not found")

        # Get KB to check if trying to update owner
        kb = KnowledgePermissionService.get_knowledge_base(db, kb_id)
        if kb and kb.user_id == permission.user_id:
            raise ValueError("Cannot update owner's permission level")

        # Update permission level
        permission.permission_level = data.permission_level.value
        db.commit()
        db.refresh(permission)
        return permission

    @staticmethod
    def get_user_permission(
        db: Session, kb_id: int, user_id: int
    ) -> Optional[KnowledgeBasePermission]:
        """
        Get user's permission record for a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID

        Returns:
            Permission record if found, None otherwise
        """
        return (
            db.query(KnowledgeBasePermission)
            .filter(
                KnowledgeBasePermission.knowledge_base_id == kb_id,
                KnowledgeBasePermission.user_id == user_id,
            )
            .first()
        )

    @staticmethod
    def build_permission_response(
        db: Session, permission: KnowledgeBasePermission
    ) -> PermissionResponse:
        """
        Build permission response with user details.

        Args:
            db: Database session
            permission: Permission record

        Returns:
            Permission response with user details
        """
        # Get user details
        user = db.query(User).filter(User.id == permission.user_id).first()
        requested_by_user = (
            db.query(User).filter(User.id == permission.requested_by).first()
        )
        approved_by_user = None
        if permission.approved_by:
            approved_by_user = (
                db.query(User).filter(User.id == permission.approved_by).first()
            )

        return PermissionResponse(
            id=permission.id,
            knowledge_base_id=permission.knowledge_base_id,
            user_id=permission.user_id,
            user_name=user.username if user else None,
            user_email=user.email if user else None,
            permission_level=PermissionLevel(permission.permission_level),
            approval_status=ApprovalStatus(permission.approval_status),
            requested_by=permission.requested_by,
            requested_by_name=requested_by_user.username if requested_by_user else None,
            approved_by=permission.approved_by,
            approved_by_name=approved_by_user.username if approved_by_user else None,
            created_at=permission.created_at,
            updated_at=permission.updated_at,
        )
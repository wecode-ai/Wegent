# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission request service for knowledge base access approval workflow.

Provides functions to create, process, and manage permission requests.
Permission requests are now stored in the permissions table with status='pending'.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.permission import Permission, PermissionStatus
from app.models.user import User
from app.schemas.permission_request import (
    MyRequestsResponse,
    PendingRequestCountResponse,
    PermissionRequestCheckResponse,
    PermissionRequestCreate,
    PermissionRequestListResponse,
    PermissionRequestProcess,
    PermissionRequestResponse,
)
from app.services.knowledge.permission_service import (
    can_access_knowledge_base,
    can_manage_knowledge_base,
)

logger = logging.getLogger(__name__)


class PermissionRequestService:
    """Service for managing permission requests."""

    @staticmethod
    def create_request(
        db: Session,
        user_id: int,
        data: PermissionRequestCreate,
    ) -> PermissionRequestResponse:
        """
        Create a new permission request.

        Args:
            db: Database session
            user_id: Applicant user ID
            data: Request creation data

        Returns:
            Created permission request

        Raises:
            ValueError: If validation fails
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == data.kind_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found or has been deleted")

        # Check if it's a personal or external knowledge base (not group or organization)
        if kb.namespace == "organization":
            raise ValueError(
                "Organization knowledge base is accessible to all users, no request needed"
            )

        if kb.namespace != "default":
            raise ValueError(
                "Group knowledge base requires joining the group first. "
                "Please contact the group administrator."
            )

        # Check if user already has access
        if can_access_knowledge_base(db, user_id, kb):
            raise ValueError("You already have access to this knowledge base")

        # Check if user already has any permission (regardless of status)
        existing_permission = (
            db.query(Permission)
            .filter(
                Permission.kind_id == data.kind_id,
                Permission.resource_type == "knowledge_base",
                Permission.user_id == user_id,
            )
            .first()
        )

        if (
            existing_permission
            and existing_permission.status == PermissionStatus.PENDING
        ):
            raise ValueError(
                "You already have a pending request for this knowledge base"
            )

        if (
            existing_permission
            and existing_permission.status == PermissionStatus.APPROVED
        ):
            raise ValueError("You already have access to this knowledge base")

        if existing_permission:
            # Non-pending, non-approved status exists (e.g., disallow, cancelled, expired)
            # Update it to pending for a new request
            existing_permission.permission_type = data.requested_permission_type
            existing_permission.granted_by_user_id = kb.user_id
            existing_permission.granted_at = datetime.utcnow()
            existing_permission.status = PermissionStatus.PENDING
            existing_permission.is_active = False
            existing_permission.updated_at = datetime.utcnow()
            db.commit()
            db.refresh(existing_permission)

            logger.info(
                f"Permission request reactivated: user={user_id}, kb={data.kind_id}, "
                f"request_id={existing_permission.id}"
            )

            return PermissionRequestService._build_response(db, existing_permission)

        # Create the permission record with status='pending'
        request = Permission(
            kind_id=data.kind_id,
            resource_type="knowledge_base",
            user_id=user_id,
            permission_type=data.requested_permission_type,
            granted_by_user_id=kb.user_id,
            granted_at=datetime.utcnow(),
            status=PermissionStatus.PENDING,
            is_active=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

        db.add(request)
        db.commit()
        db.refresh(request)

        logger.info(
            f"Permission request created: user={user_id}, kb={data.kind_id}, "
            f"request_id={request.id}"
        )

        return PermissionRequestService._build_response(db, request)

    @staticmethod
    def process_request(
        db: Session,
        request_id: int,
        processor_user_id: int,
        data: PermissionRequestProcess,
    ) -> PermissionRequestResponse:
        """
        Process (approve/reject) a permission request.

        Args:
            db: Database session
            request_id: Request ID to process
            processor_user_id: User ID of the processor
            data: Processing data

        Returns:
            Updated permission request

        Raises:
            ValueError: If validation fails or permission denied
        """
        # Get the permission record
        permission = db.query(Permission).filter(Permission.id == request_id).first()

        if not permission:
            raise ValueError("Permission request not found")

        if permission.status != PermissionStatus.PENDING:
            raise ValueError(
                f"Request has already been processed (status: {permission.status.value})"
            )

        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == permission.kind_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            # KB was deleted, mark request as disallow
            permission.status = PermissionStatus.DISALLOW
            permission.updated_at = datetime.utcnow()
            db.commit()
            raise ValueError("Knowledge base has been deleted")

        if not kb.is_active:
            permission.status = PermissionStatus.DISALLOW
            permission.updated_at = datetime.utcnow()
            db.commit()
            raise ValueError("Knowledge base has been deleted")

        # Check if processor has manage permission
        processor = db.query(User).filter(User.id == processor_user_id).first()
        if not processor:
            raise ValueError("Processor user not found")

        if not can_manage_knowledge_base(db, processor, kb):
            raise ValueError(
                "You don't have permission to process requests for this knowledge base"
            )

        # Process the request
        if data.action == "approve":
            # Determine permission type to grant
            permission_type = data.granted_permission_type or permission.permission_type

            # Update permission record
            permission.permission_type = permission_type
            permission.granted_by_user_id = processor_user_id
            permission.granted_at = datetime.utcnow()
            permission.status = PermissionStatus.APPROVED
            permission.is_active = True
            logger.info(
                f"Permission request approved: request_id={request_id}, "
                f"user={permission.user_id}, kb={permission.kind_id}, "
                f"permission={permission_type}"
            )
        else:  # reject
            permission.status = PermissionStatus.DISALLOW
            permission.is_active = False
            logger.info(
                f"Permission request rejected: request_id={request_id}, "
                f"user={permission.user_id}, kb={permission.kind_id}"
            )

        permission.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(permission)

        return PermissionRequestService._build_response(db, permission)

    @staticmethod
    def cancel_request(
        db: Session,
        request_id: int,
        user_id: int,
    ) -> PermissionRequestResponse:
        """
        Cancel a pending permission request.

        Args:
            db: Database session
            request_id: Request ID to cancel
            user_id: User ID (must be the applicant)

        Returns:
            Updated permission request

        Raises:
            ValueError: If validation fails
        """
        permission = db.query(Permission).filter(Permission.id == request_id).first()

        if not permission:
            raise ValueError("Permission request not found")

        if permission.user_id != user_id:
            raise ValueError("You can only cancel your own requests")

        if permission.status != PermissionStatus.PENDING:
            raise ValueError(
                f"Cannot cancel request with status: {permission.status.value}"
            )

        permission.status = PermissionStatus.DISALLOW
        permission.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(permission)

        logger.info(f"Permission request cancelled: request_id={request_id}")

        return PermissionRequestService._build_response(db, permission)

    @staticmethod
    def get_pending_requests_for_kb(
        db: Session,
        kb_id: int,
        user_id: int,
    ) -> PermissionRequestListResponse:
        """
        Get pending permission requests for a knowledge base.

        Args:
            db: Database session
            kb_id: Knowledge base ID
            user_id: User ID (must have manage permission)

        Returns:
            List of pending requests

        Raises:
            ValueError: If permission denied
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == kb_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        # Check permission
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("User not found")

        if not can_manage_knowledge_base(db, user, kb):
            raise ValueError(
                "You don't have permission to view requests for this knowledge base"
            )

        requests = (
            db.query(Permission)
            .filter(
                Permission.kind_id == kb_id,
                Permission.resource_type == "knowledge_base",
                Permission.status == PermissionStatus.PENDING,
            )
            .order_by(Permission.created_at.desc())
            .all()
        )

        items = [PermissionRequestService._build_response(db, req) for req in requests]

        return PermissionRequestListResponse(total=len(items), items=items)

    @staticmethod
    def get_all_pending_requests_for_user(
        db: Session,
        user_id: int,
    ) -> PermissionRequestListResponse:
        """
        Get all pending permission requests that the user can process.

        This includes requests for all knowledge bases the user can manage.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of pending requests
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("User not found")

        # Get all knowledge bases the user can manage (personal KBs owned by user)
        personal_kb_ids = (
            db.query(Kind.id)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.namespace == "default",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .all()
        )
        personal_kb_ids = [kb_id for (kb_id,) in personal_kb_ids]

        # Get pending requests for these KBs
        requests = (
            db.query(Permission)
            .filter(
                Permission.kind_id.in_(personal_kb_ids),
                Permission.resource_type == "knowledge_base",
                Permission.status == PermissionStatus.PENDING,
            )
            .order_by(Permission.created_at.desc())
            .all()
        )

        items = [PermissionRequestService._build_response(db, req) for req in requests]

        return PermissionRequestListResponse(total=len(items), items=items)

    @staticmethod
    def get_pending_request_count(
        db: Session,
        user_id: int,
    ) -> PendingRequestCountResponse:
        """
        Get count of pending permission requests that the user can process.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Count of pending requests
        """
        # Get all knowledge bases the user can manage (personal KBs owned by user)
        personal_kb_ids = (
            db.query(Kind.id)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.namespace == "default",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .all()
        )
        personal_kb_ids = [kb_id for (kb_id,) in personal_kb_ids]

        if not personal_kb_ids:
            return PendingRequestCountResponse(count=0)

        count = (
            db.query(Permission)
            .filter(
                Permission.kind_id.in_(personal_kb_ids),
                Permission.resource_type == "knowledge_base",
                Permission.status == PermissionStatus.PENDING,
            )
            .count()
        )

        return PendingRequestCountResponse(count=count)

    @staticmethod
    def get_my_requests(
        db: Session,
        user_id: int,
        status: Optional[str] = None,
    ) -> MyRequestsResponse:
        """
        Get current user's permission requests.

        Args:
            db: Database session
            user_id: User ID
            status: Optional status filter

        Returns:
            List of user's requests
        """
        query = db.query(Permission).filter(
            Permission.user_id == user_id,
            Permission.resource_type == "knowledge_base",
        )

        if status:
            try:
                status_enum = PermissionStatus(status)
                query = query.filter(Permission.status == status_enum)
            except ValueError:
                pass  # Invalid status, ignore filter

        requests = query.order_by(Permission.created_at.desc()).all()

        items = [PermissionRequestService._build_response(db, req) for req in requests]

        return MyRequestsResponse(total=len(items), items=items)

    @staticmethod
    def check_pending_request(
        db: Session,
        user_id: int,
        kb_id: int,
    ) -> PermissionRequestCheckResponse:
        """
        Check if user has a pending request for a knowledge base.

        Args:
            db: Database session
            user_id: User ID
            kb_id: Knowledge base ID

        Returns:
            Check result with pending request if exists
        """
        request = (
            db.query(Permission)
            .filter(
                Permission.kind_id == kb_id,
                Permission.resource_type == "knowledge_base",
                Permission.user_id == user_id,
                Permission.status == PermissionStatus.PENDING,
            )
            .first()
        )

        if request:
            return PermissionRequestCheckResponse(
                has_pending_request=True,
                pending_request=PermissionRequestService._build_response(db, request),
            )

        return PermissionRequestCheckResponse(
            has_pending_request=False,
            pending_request=None,
        )

    @staticmethod
    def expire_requests_for_deleted_kb(
        db: Session,
        kb_id: int,
    ) -> int:
        """
        Mark all pending requests for a deleted knowledge base as disallow.

        Args:
            db: Database session
            kb_id: Knowledge base ID

        Returns:
            Number of requests expired
        """
        result = (
            db.query(Permission)
            .filter(
                Permission.kind_id == kb_id,
                Permission.resource_type == "knowledge_base",
                Permission.status == PermissionStatus.PENDING,
            )
            .update(
                {
                    Permission.status: PermissionStatus.DISALLOW,
                    Permission.updated_at: datetime.utcnow(),
                }
            )
        )

        db.commit()

        if result > 0:
            logger.info(
                f"Expired {result} pending permission requests for deleted KB {kb_id}"
            )

        return result

    @staticmethod
    def _build_response(
        db: Session,
        permission: Permission,
    ) -> PermissionRequestResponse:
        """
        Build a response object from a permission record.

        Args:
            db: Database session
            permission: Permission object

        Returns:
            Permission request response
        """
        # Get applicant info
        applicant = db.query(User).filter(User.id == permission.user_id).first()
        applicant_username = applicant.user_name if applicant else "Unknown"

        # Get processor info (granted_by_user_id)
        processor_username = None
        if permission.granted_by_user_id:
            processor = (
                db.query(User).filter(User.id == permission.granted_by_user_id).first()
            )
            processor_username = processor.user_name if processor else "Unknown"

        # Get KB info
        kb = (
            db.query(Kind)
            .filter(Kind.id == permission.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        kb_name = None
        kb_description = None
        kb_owner_username = None
        if kb:
            spec = kb.json.get("spec", {})
            kb_name = spec.get("name", kb.name)
            kb_description = spec.get("description")
            owner = db.query(User).filter(User.id == kb.user_id).first()
            kb_owner_username = owner.user_name if owner else "Unknown"

        return PermissionRequestResponse(
            id=permission.id,
            kind_id=permission.kind_id,
            resource_type=permission.resource_type,
            applicant_user_id=permission.user_id,
            applicant_username=applicant_username,
            requested_permission_type=permission.permission_type,
            request_reason=None,  # Not stored in permissions table
            status=permission.status,
            processed_by_user_id=permission.granted_by_user_id,
            processed_by_username=processor_username,
            processed_at=permission.granted_at,
            response_message=None,  # Not stored in permissions table
            created_at=permission.created_at,
            updated_at=permission.updated_at,
            kb_name=kb_name,
            kb_description=kb_description,
            kb_owner_username=kb_owner_username,
        )


# Singleton instance
permission_request_service = PermissionRequestService()

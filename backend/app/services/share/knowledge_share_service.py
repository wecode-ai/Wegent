# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Base share service for unified resource sharing.

Provides KnowledgeBase-specific implementation of the UnifiedShareService.
Includes permission check methods previously in KnowledgePermissionService.
"""

import logging
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import PermissionLevel, ResourceType, ShareLink
from app.models.user import User
from app.schemas.share import (
    KBShareInfoResponse,
    MyKBPermissionResponse,
    PendingRequestInfo,
)
from app.schemas.share import PermissionLevel as SchemaPermissionLevel
from app.services.group_permission import get_effective_role_in_group
from app.services.knowledge.knowledge_service import _is_organization_namespace
from app.services.share.base_service import UnifiedShareService
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

logger = logging.getLogger(__name__)


class KnowledgeShareService(UnifiedShareService):
    """
    KnowledgeBase-specific share service.

    Knowledge bases are shared directly without copying.
    Members get access based on their permission level.
    """

    def __init__(self) -> None:
        super().__init__(ResourceType.KNOWLEDGE_BASE)

    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[Kind]:
        """
        Fetch KnowledgeBase resource.

        For Knowledge Bases, we check if resource exists and user has access via:
        1. Creator (user_id matches)
        2. Explicit shared access (ResourceMember)
        3. Organization membership (for organization knowledge bases)
        4. Team membership (for team knowledge bases)
        """
        logger.info(
            f"[_get_resource] Fetching KnowledgeBase: resource_id={resource_id}, user_id={user_id}"
        )

        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            logger.warning(
                f"[_get_resource] KnowledgeBase not found: resource_id={resource_id}"
            )
            return None

        logger.info(
            f"[_get_resource] KnowledgeBase found: id={kb.id}, "
            f"kb.user_id={kb.user_id}, namespace={kb.namespace}"
        )

        # Check if user is creator
        if kb.user_id == user_id:
            logger.info(
                f"[_get_resource] User is creator: user_id={user_id} == kb.user_id={kb.user_id}"
            )
            return kb

        logger.warning(
            f"[_get_resource] User is NOT creator: user_id={user_id} != kb.user_id={kb.user_id}"
        )

        # Check if user has explicit shared access
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == resource_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )
        if member:
            logger.info(
                f"[_get_resource] User has explicit shared access: member_id={member.id}"
            )
            return kb

        logger.warning(f"[_get_resource] User has NO explicit shared access")

        # For organization knowledge bases, all authenticated users have access
        if _is_organization_namespace(db, kb.namespace):
            logger.info(
                f"[_get_resource] Organization KB - granting access to user_id={user_id}"
            )
            return kb

        # For team knowledge bases, check group permission
        if kb.namespace != "default":
            logger.info(
                f"[_get_resource] Checking team permission: namespace={kb.namespace}"
            )
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is not None:
                logger.info(f"[_get_resource] User has team role: role={role}")
                return kb
            logger.warning(
                f"[_get_resource] User has NO team role in namespace={kb.namespace}"
            )
        else:
            logger.info(
                f"[_get_resource] KnowledgeBase is personal (namespace=default)"
            )

        logger.error(
            f"[_get_resource] User has NO access to KnowledgeBase: "
            f"resource_id={resource_id}, user_id={user_id}, "
            f"kb.user_id={kb.user_id}, namespace={kb.namespace}"
        )
        return None  # Only return KB for authorized users

    def _get_resource_name(self, resource: Kind) -> str:
        """Get KnowledgeBase display name."""
        return resource.name

    def _get_resource_owner_id(self, resource: Kind) -> int:
        """Get KnowledgeBase owner user ID."""
        return resource.user_id

    @trace_sync(
        span_name="knowledge_share.get_share_url_base",
        tracer_name="backend.services.share",
    )
    def _get_share_url_base(self) -> str:
        """Get base URL for KnowledgeBase share links."""

        # Use TASK_SHARE_BASE_URL consistent with Task sharing
        base_url = getattr(settings, "TASK_SHARE_BASE_URL", "http://localhost:3000")
        share_url = f"{base_url}/shared/knowledge"

        # Record tracing information
        add_span_event(
            "share_url_resolved",
            {"config_source": "TASK_SHARE_BASE_URL", "base_url": base_url},
        )
        set_span_attribute("share.base_url", share_url)

        return share_url

    def _on_member_approved(
        self, db: Session, member: ResourceMember, resource: Kind
    ) -> Optional[int]:
        """
        Hook called when a KnowledgeBase member is approved.

        For Knowledge Bases, we don't copy anything - members get direct access
        based on their permission level.
        """
        # No copy needed for Knowledge Bases
        logger.info(
            f"KnowledgeBase member approved: user={member.user_id}, "
            f"kb={resource.id}, permission={member.permission_level}"
        )
        return None

    # =========================================================================
    # Permission Check Methods (integrated from KnowledgePermissionService)
    # =========================================================================

    @staticmethod
    def get_permission_priority(level: str) -> int:
        """Get priority value for permission level (higher = more permissions)."""
        priority_map = {
            PermissionLevel.VIEW.value: 1,
            PermissionLevel.EDIT.value: 2,
            PermissionLevel.MANAGE.value: 3,
        }
        return priority_map.get(level, 0)

    def get_user_kb_permission(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> Tuple[bool, Optional[str], bool]:
        """
        Get user's permission for a knowledge base.

        Priority: creator > explicit permission (ResourceMember) > group permission

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
            return True, PermissionLevel.MANAGE.value, True

        # Check explicit permission in resource_members table
        explicit_perm = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == knowledge_base_id,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )

        if explicit_perm:
            return True, explicit_perm.permission_level, False

        # For organization knowledge bases, all authenticated users have VIEW access
        if _is_organization_namespace(db, kb.namespace):
            return True, PermissionLevel.VIEW.value, False

        # For team knowledge bases, check group permission
        if kb.namespace != "default":
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is not None:
                # Map group role to permission level
                # Owner/Maintainer -> manage, Developer -> edit, Reporter -> view
                role_mapping = {
                    "Owner": PermissionLevel.MANAGE.value,
                    "Maintainer": PermissionLevel.MANAGE.value,
                    "Developer": PermissionLevel.EDIT.value,
                    "Reporter": PermissionLevel.VIEW.value,
                }
                return True, role_mapping.get(role, PermissionLevel.VIEW.value), False

        return False, None, False

    def can_manage_permissions(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """Check if user can manage permissions for a knowledge base."""
        has_access, level, is_creator = self.get_user_kb_permission(
            db, knowledge_base_id, user_id
        )
        if is_creator:
            return True
        return has_access and level == PermissionLevel.MANAGE.value

    def get_my_permission(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> MyKBPermissionResponse:
        """
        Get current user's permission for a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Current user ID

        Returns:
            MyKBPermissionResponse
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
            return MyKBPermissionResponse(
                has_access=False,
                permission_level=None,
                is_creator=False,
                pending_request=None,
            )

        # Check if user is creator
        is_creator = kb.user_id == user_id
        if is_creator:
            return MyKBPermissionResponse(
                has_access=True,
                permission_level=SchemaPermissionLevel.MANAGE,
                is_creator=True,
                pending_request=None,
            )

        # Check explicit permission
        explicit_perm = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == knowledge_base_id,
                ResourceMember.user_id == user_id,
            )
            .first()
        )

        pending_request = None
        has_explicit_access = False
        explicit_level = None

        if explicit_perm:
            if explicit_perm.status == MemberStatus.APPROVED.value:
                has_explicit_access = True
                explicit_level = SchemaPermissionLevel(explicit_perm.permission_level)
            elif explicit_perm.status == MemberStatus.PENDING.value:
                pending_request = PendingRequestInfo(
                    id=explicit_perm.id,
                    permission_level=SchemaPermissionLevel(
                        explicit_perm.permission_level
                    ),
                    requested_at=explicit_perm.requested_at,
                )

        # Check group permission for team KB or organization KB
        group_level = None
        if _is_organization_namespace(db, kb.namespace):
            # Organization KB - all authenticated users have VIEW access
            group_level = SchemaPermissionLevel.VIEW
        elif kb.namespace != "default":
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
            explicit_priority = self.get_permission_priority(explicit_level.value)
            group_priority = self.get_permission_priority(group_level.value)
            final_level = (
                explicit_level if explicit_priority >= group_priority else group_level
            )
            return MyKBPermissionResponse(
                has_access=True,
                permission_level=final_level,
                is_creator=False,
                pending_request=None,
            )
        elif has_explicit_access:
            return MyKBPermissionResponse(
                has_access=True,
                permission_level=explicit_level,
                is_creator=False,
                pending_request=None,
            )
        elif group_level:
            return MyKBPermissionResponse(
                has_access=True,
                permission_level=group_level,
                is_creator=False,
                pending_request=pending_request,
            )
        else:
            return MyKBPermissionResponse(
                has_access=False,
                permission_level=None,
                is_creator=False,
                pending_request=pending_request,
            )

    def get_kb_share_info(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> KBShareInfoResponse:
        """
        Get knowledge base info for share page.

        Returns basic info about the KB and current user's permission status.
        This is used by the share link page to display KB info and handle
        permission requests.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Current user ID

        Returns:
            KBShareInfoResponse

        Raises:
            ValueError: If knowledge base not found
        """
        # Get KB basic info (allow access even without permission for share page)
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

        spec = kb.json.get("spec", {})

        # Get current user's permission
        my_permission = self.get_my_permission(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )

        # Get creator info
        creator = db.query(User).filter(User.id == kb.user_id).first()
        creator_name = creator.user_name if creator else f"User {kb.user_id}"

        return KBShareInfoResponse(
            id=kb.id,
            name=spec.get("name", ""),
            description=spec.get("description"),
            namespace=kb.namespace,
            creator_id=kb.user_id,
            creator_name=creator_name,
            created_at=kb.created_at.isoformat() if kb.created_at else None,
            my_permission=my_permission,
        )

    def get_public_kb_info(
        self,
        db: Session,
        share_token: str,
    ) -> dict:
        """
        Get public knowledge base info by share token (no auth required).

        This method is used by the public share page to display KB info
        without requiring authentication.

        Args:
            db: Database session
            share_token: Encrypted share token

        Returns:
            Dict with public KB info

        Raises:
            ValueError: If token is invalid or KB not found
        """
        import urllib.parse

        # Decode token
        token_info = self._decode_share_token(share_token)
        if not token_info:
            raise ValueError("Invalid share token")

        resource_type, owner_id, resource_id = token_info

        # Validate resource type
        if resource_type != self.resource_type.value:
            raise ValueError("Invalid resource type")

        # Find share link by resource_id (more reliable than token matching)
        # The token in DB is URL-encoded, but FastAPI may have decoded the input
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        if not share_link:
            raise ValueError("Share link not found or inactive")

        # Check expiration
        from datetime import datetime

        is_expired = False
        if share_link.expires_at and datetime.utcnow() > share_link.expires_at:
            is_expired = True

        # Get KB info
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        spec = kb.json.get("spec", {})

        # Get creator info
        creator = db.query(User).filter(User.id == kb.user_id).first()
        creator_name = creator.user_name if creator else f"User {kb.user_id}"

        return {
            "id": kb.id,
            "name": spec.get("name", ""),
            "description": spec.get("description"),
            "creator_id": kb.user_id,
            "creator_name": creator_name,
            "require_approval": share_link.require_approval,
            "default_permission_level": share_link.default_permission_level,
            "is_expired": is_expired,
        }

    def get_share_token_by_kb_id(
        self,
        db: Session,
        knowledge_base_id: int,
    ) -> str | None:
        """
        Get share token for a knowledge base by its ID.

        Used for redirecting old share links to new token-based format.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Share token if found, None otherwise
        """
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = [self.resource_type.value]
        if self.resource_type.value == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == knowledge_base_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        return share_link.share_token if share_link else None

    # =========================================================================
    # Cleanup Methods
    # =========================================================================

    def delete_members_for_kb(
        self,
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Delete all members for a knowledge base (called when KB is deleted).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == knowledge_base_id,
            )
            .delete()
        )
        db.flush()
        return result

    def delete_members_for_user(
        self,
        db: Session,
        user_id: int,
    ) -> int:
        """
        Delete all KB members for a user (called when user is deleted).

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.user_id == user_id,
            )
            .delete()
        )
        db.flush()
        return result


# Singleton instance
knowledge_share_service = KnowledgeShareService()

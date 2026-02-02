# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Base share service for unified resource sharing.

Provides KnowledgeBase-specific implementation of the UnifiedShareService.
"""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.services.share.base_service import UnifiedShareService

logger = logging.getLogger(__name__)


class KnowledgeShareService(UnifiedShareService):
    """
    KnowledgeBase-specific share service.

    Knowledge bases are shared directly without copying.
    Members get access based on their permission level.
    """

    def __init__(self):
        super().__init__(ResourceType.KNOWLEDGE_BASE)

    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[Kind]:
        """
        Fetch KnowledgeBase resource.

        For Knowledge Bases, we check if the resource exists and belongs to the user
        OR if the user has been shared access.
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if kb and kb.user_id == user_id:
            return kb

        # Check if user has shared access
        if kb:
            from app.models.resource_member import MemberStatus, ResourceMember

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
                return kb

        return kb  # Return KB even if not accessible (for share info)

    def _get_resource_name(self, resource: Kind) -> str:
        """Get KnowledgeBase display name."""
        return resource.name

    def _get_resource_owner_id(self, resource: Kind) -> int:
        """Get KnowledgeBase owner user ID."""
        return resource.user_id

    def _get_share_url_base(self) -> str:
        """Get base URL for KnowledgeBase share links."""
        # Construct URL for knowledge base sharing
        base_url = getattr(settings, "FRONTEND_BASE_URL", "http://localhost:3000")
        return f"{base_url}/knowledge/share"

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


# Singleton instance
knowledge_share_service = KnowledgeShareService()

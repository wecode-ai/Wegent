# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Team share service for unified resource sharing.

Provides Team-specific implementation of the UnifiedShareService.
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


class TeamShareService(UnifiedShareService):
    """
    Team-specific share service.

    Teams are joined directly without copying.
    """

    def __init__(self):
        super().__init__(ResourceType.TEAM)

    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[Kind]:
        """
        Fetch Team resource.

        For Teams, we check if the resource exists and belongs to the user
        OR if the user has been shared access to the team.
        """
        # First try to find team owned by user
        team = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if team and team.user_id == user_id:
            return team

        # Check if user has shared access
        if team:
            from app.models.resource_member import MemberStatus, ResourceMember

            member = (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type == ResourceType.TEAM.value,
                    ResourceMember.resource_id == resource_id,
                    ResourceMember.user_id == user_id,
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .first()
            )
            if member:
                return team

        return team  # Return team even if not owned (for share info)

    def _get_resource_name(self, resource: Kind) -> str:
        """Get Team display name."""
        return resource.name

    def _get_resource_owner_id(self, resource: Kind) -> int:
        """Get Team owner user ID."""
        return resource.user_id

    def _get_share_url_base(self) -> str:
        """Get base URL for Team share links."""
        # Use TEAM_SHARE_BASE_URL from settings or construct default
        return getattr(settings, "TEAM_SHARE_BASE_URL", "http://localhost:3000/chat")

    def _on_member_approved(
        self, db: Session, member: ResourceMember, resource: Kind
    ) -> Optional[int]:
        """
        Hook called when a Team member is approved.

        For Teams, we don't copy anything - members just get direct access.
        """
        # No copy needed for Teams
        return None


# Singleton instance
team_share_service = TeamShareService()

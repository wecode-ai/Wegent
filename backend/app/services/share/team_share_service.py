# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Team share service for unified resource sharing.

Provides Team-specific implementation of the UnifiedShareService.
"""

import logging
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.share import (
    BatchResourceMemberResponse,
    FailedMemberResponse,
    ResourceMemberResponse,
)
from app.services.share.base_service import UnifiedShareService

logger = logging.getLogger(__name__)


class TeamShareService(UnifiedShareService):
    """
    Team-specific share service.

    Teams are joined directly without copying.
    """

    def __init__(self) -> None:
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
                Kind.is_active.is_(True),
            )
            .first()
        )

        if team and (team.user_id == user_id or team.user_id == 0):
            return team

        # Check if user has shared access (direct user or entity fallback)
        if team:
            from app.schemas.share import MemberRole

            if self.check_permission(db, resource_id, user_id, MemberRole.Reporter):
                return team

        return None  # Return None if not authorized to prevent unauthorized access

    def get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[Kind]:
        """Public entrypoint to fetch a team if the user has access.

        Delegates to _get_resource; exposed for cross-service callers.
        """
        return self._get_resource(db, resource_id, user_id)

    def check_permission(
        self, db: Session, resource_id: int, user_id: int, required_role: BaseRole
    ) -> bool:
        """Check direct Team sharing plus native group Team permissions."""
        if super().check_permission(db, resource_id, user_id, required_role):
            return True

        team = self._get_active_team(db, resource_id)
        if not team or team.namespace == "default":
            return False

        from app.services.group_permission import get_effective_role_in_group

        role = get_effective_role_in_group(db, user_id, team.namespace)
        return role is not None and has_permission(role, required_role)

    def _get_resource_name(self, resource: Kind) -> str:
        """Get Team display name."""
        return resource.name

    def _get_resource_owner_id(self, resource: Kind) -> int:
        """Get Team owner user ID."""
        return resource.user_id

    def _role_value(self, role: BaseRole | str) -> str:
        """Return the string value for a role enum or role string."""
        return role.value if hasattr(role, "value") else str(role)

    def _get_active_team(self, db: Session, resource_id: int) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "Team",
                Kind.is_active.is_(True),
            )
            .first()
        )

    def _ensure_can_manage_members(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        action: str = "add",
    ) -> Kind:
        resource = self._get_resource(db, resource_id, current_user_id)
        if not resource:
            raise HTTPException(status_code=404, detail="Resource not found")

        has_manage = self.check_permission(
            db, resource_id, current_user_id, BaseRole.Maintainer
        )
        if resource.user_id != current_user_id and not has_manage:
            raise HTTPException(
                status_code=403,
                detail=f"No permission to {action} members",
            )

        return resource

    def _validate_child_namespace_authorization(
        self,
        db: Session,
        *,
        resource_id: int,
        role: BaseRole | str,
        entity_type: Optional[str],
        entity_id: Optional[str],
    ) -> None:
        """Validate Team authorization records for child namespace targets."""
        if (entity_type or "").lower() != "namespace":
            return

        if not entity_id:
            raise HTTPException(
                status_code=400,
                detail="entity_id is required for namespace authorization",
            )

        if self._role_value(role) != BaseRole.Reporter.value:
            raise HTTPException(
                status_code=400,
                detail="Team namespace authorization only supports Reporter role",
            )

        team = self._get_active_team(db, resource_id)
        if not team:
            return

        if team.namespace == "default":
            raise HTTPException(
                status_code=400,
                detail="Only group teams can be authorized to child groups",
            )

        try:
            namespace_id = int(entity_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=400,
                detail="namespace entity_id must be a namespace id",
            ) from exc

        target_namespace = (
            db.query(Namespace)
            .filter(Namespace.id == namespace_id, Namespace.is_active.is_(True))
            .first()
        )
        if not target_namespace:
            raise HTTPException(status_code=400, detail="Target namespace not found")

        if target_namespace.name == team.namespace:
            raise HTTPException(
                status_code=400,
                detail="Cannot authorize a team to its own group",
            )

        if not target_namespace.is_subgroup_of(team.namespace):
            raise HTTPException(
                status_code=400,
                detail="Team can only be authorized to child groups of its namespace",
            )

    def add_member(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        target_user_id: int,
        role: BaseRole,
        entity_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        entity_display_name: Optional[str] = None,
    ) -> ResourceMemberResponse:
        """Add a Team member or child namespace authorization."""
        self._ensure_can_manage_members(db, resource_id, current_user_id, action="add")
        self._validate_child_namespace_authorization(
            db,
            resource_id=resource_id,
            role=role,
            entity_type=entity_type,
            entity_id=entity_id,
        )
        return super().add_member(
            db=db,
            resource_id=resource_id,
            current_user_id=current_user_id,
            target_user_id=target_user_id,
            role=role,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_display_name=entity_display_name,
        )

    def batch_add_members(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        members_data: List[
            Tuple[int, BaseRole, Optional[str], Optional[str], Optional[str]]
        ],
    ) -> BatchResourceMemberResponse:
        """Batch add Team members and filter invalid child namespace grants."""
        self._ensure_can_manage_members(db, resource_id, current_user_id)

        filtered_members = []
        failed: List[FailedMemberResponse] = []
        for entry in members_data:
            target_user_id, role, entity_type, entity_id, _entity_display_name = entry
            try:
                self._validate_child_namespace_authorization(
                    db,
                    resource_id=resource_id,
                    role=role,
                    entity_type=entity_type,
                    entity_id=entity_id,
                )
            except HTTPException as exc:
                failed.append(
                    FailedMemberResponse(
                        user_id=target_user_id,
                        entity_type=entity_type,
                        entity_id=entity_id,
                        error=str(exc.detail),
                    )
                )
                continue
            filtered_members.append(entry)

        if not filtered_members:
            return BatchResourceMemberResponse(succeeded=[], failed=failed)

        result = super().batch_add_members(
            db=db,
            resource_id=resource_id,
            current_user_id=current_user_id,
            members_data=filtered_members,
        )
        result.failed.extend(failed)
        return result

    def update_member(
        self,
        db: Session,
        resource_id: int,
        member_id: int,
        current_user_id: int,
        role: BaseRole,
    ) -> ResourceMemberResponse:
        """Update a Team member role while keeping namespace grants read-only."""
        self._ensure_can_manage_members(
            db, resource_id, current_user_id, action="update"
        )
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.id == member_id,
                ResourceMember.resource_type.in_(self._resource_type_variants),
                ResourceMember.resource_id == resource_id,
            )
            .first()
        )
        if member and member.entity_type == "namespace":
            self._validate_child_namespace_authorization(
                db,
                resource_id=resource_id,
                role=role,
                entity_type=member.entity_type,
                entity_id=member.entity_id,
            )

        return super().update_member(
            db=db,
            resource_id=resource_id,
            member_id=member_id,
            current_user_id=current_user_id,
            role=role,
        )

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

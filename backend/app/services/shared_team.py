# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Service for managing team sharing functionality.

Uses the unified ResourceMember model instead of the legacy SharedTeam table.
"""

import json
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType, ShareLink
from app.models.user import User
from app.schemas.kind import Team
from app.schemas.shared_team import (
    JoinSharedTeamRequest,
    JoinSharedTeamResponse,
    SharedTeamCreate,
    SharedTeamInDB,
    TeamShareInfo,
    TeamShareResponse,
)
from app.services.share.token_access import (
    hash_share_token,
    require_share_link_access,
    share_token_lookup,
)

logger = logging.getLogger(__name__)


class SharedTeamService:
    """Service for managing team sharing functionality using ResourceMember"""

    def generate_share_token(self, user_id: int, team_id: int) -> str:
        """Generate a 256-bit opaque share token."""
        return secrets.token_urlsafe(32)

    def create_share_link(
        self,
        db: Session,
        team_id: int,
        owner_user_id: int,
    ) -> ShareLink:
        """Create and persist a new team share link."""
        share_token = self.generate_share_token(owner_user_id, team_id)
        share_link = ShareLink(
            resource_type=ResourceType.TEAM.value,
            resource_id=team_id,
            share_token=share_token,
            token_hash=self._hash_share_token(share_token),
            token_version=ShareLink.OPAQUE_TOKEN_VERSION,
            require_approval=False,
            default_role=ResourceRole.Maintainer.value,
            expires_at=datetime.utcnow() + timedelta(days=365 * 100),
            created_by_user_id=owner_user_id,
            is_active=True,
        )
        db.add(share_link)
        db.commit()
        return share_link

    def _hash_share_token(self, share_token: str) -> str:
        """Return the SHA-256 digest used for token lookup."""
        return hash_share_token(share_token)

    def _find_share_link(self, db: Session, share_token: str) -> Optional[ShareLink]:
        """Find an active team share link by its token hash."""
        share_link = (
            db.query(ShareLink)
            .filter(
                share_token_lookup(share_token),
                ShareLink.resource_type == ResourceType.TEAM.value,
                ShareLink.is_active.is_(True),
            )
            .first()
        )
        return share_link

    def decode_share_token(
        self,
        share_token: str,
        db: Optional[Session] = None,
        viewer_id: Optional[int] = None,
    ) -> Optional[TeamShareInfo]:
        """Resolve a team share token to its active, owned resource."""
        if db is None:
            return None

        share_link = self._find_share_link(db, share_token)
        if not share_link or share_link.is_expired:
            logger.info("Invalid or inactive share token")
            return None

        from app.services.share import team_share_service

        require_share_link_access(
            db,
            share_link,
            viewer_id,
            lambda uid: team_share_service._get_resource(
                db, share_link.resource_id, uid
            ),
        )
        user_id = share_link.created_by_user_id
        team_id = share_link.resource_id
        user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )
        if not user or not team:
            logger.info("User or team not found in the database.")
            return None

        return TeamShareInfo(
            user_id=user_id,
            user_name=user.user_name,
            team_id=team_id,
            team_name=team.name,
            bind_mode=(
                team.json.get("spec", {}).get("bind_mode")
                if isinstance(team.json, dict)
                else None
            ),
        )

    def generate_share_url(self, share_token: str) -> str:
        """Generate share URL with token"""
        return f"{settings.TEAM_SHARE_BASE_URL}?{settings.TEAM_SHARE_QUERY_PARAM}={share_token}"

    def create_share_relationship(
        self,
        db: Session,
        user_id: int,
        original_user_id: int,
        team_id: int,
        share_link: ShareLink,
    ) -> SharedTeamInDB:
        """Create shared team relationship using ResourceMember"""
        role = share_link.get_default_role()
        if role == ResourceRole.Owner.value:
            role = ResourceRole.Reporter.value

        # Check if relationship already exists
        existing = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM,
                ResourceMember.resource_id == team_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400, detail="User already has access to this team"
            )

        # Check if there's a rejected entry that we should reactivate
        rejected = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM,
                ResourceMember.resource_id == team_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
            )
            .first()
        )

        if rejected:
            rejected.status = (
                MemberStatus.PENDING
                if share_link.require_approval
                else MemberStatus.APPROVED
            )
            rejected.invited_by_user_id = original_user_id
            rejected.role = role
            rejected.share_link_id = share_link.id
            rejected.updated_at = datetime.now()
            db.commit()
            db.refresh(rejected)
            # Return as SharedTeamInDB format for backwards compatibility
            return SharedTeamInDB(
                id=rejected.id,
                user_id=rejected.user_id,
                original_user_id=rejected.invited_by_user_id,
                team_id=rejected.resource_id,
                is_active=True,
                created_at=rejected.created_at,
                updated_at=rejected.updated_at,
            )

        # Create new relationship
        resource_member = ResourceMember(
            resource_type=ResourceType.TEAM,
            resource_id=team_id,
            entity_type="user",
            entity_id=str(user_id),
            role=role,
            status=(
                MemberStatus.PENDING
                if share_link.require_approval
                else MemberStatus.APPROVED
            ),
            invited_by_user_id=original_user_id,
            share_link_id=share_link.id,
            reviewed_by_user_id=0,
            copied_resource_id=0,
            requested_at=datetime.now(),
        )

        db.add(resource_member)
        db.commit()
        db.refresh(resource_member)

        # Return as SharedTeamInDB format for backwards compatibility
        return SharedTeamInDB(
            id=resource_member.id,
            user_id=resource_member.user_id,
            original_user_id=resource_member.invited_by_user_id,
            team_id=resource_member.resource_id,
            is_active=True,
            created_at=resource_member.created_at,
            updated_at=resource_member.updated_at,
        )

    def get_user_shared_teams(self, db: Session, user_id: int) -> List[SharedTeamInDB]:
        """Get all shared teams for a user using ResourceMember"""
        resource_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .all()
        )

        return [
            SharedTeamInDB(
                id=rm.id,
                user_id=rm.user_id,
                original_user_id=rm.invited_by_user_id,
                team_id=rm.resource_id,
                is_active=True,
                created_at=rm.created_at,
                updated_at=rm.updated_at,
            )
            for rm in resource_members
        ]

    def get_team_shared_users(self, db: Session, team_id: int) -> List[SharedTeamInDB]:
        """Get all users who have access to a shared team using ResourceMember"""
        resource_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM,
                ResourceMember.resource_id == team_id,
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .all()
        )

        return [
            SharedTeamInDB(
                id=rm.id,
                user_id=rm.user_id,
                original_user_id=rm.invited_by_user_id,
                team_id=rm.resource_id,
                is_active=True,
                created_at=rm.created_at,
                updated_at=rm.updated_at,
            )
            for rm in resource_members
        ]

    def remove_shared_team(self, db: Session, user_id: int, team_id: int) -> bool:
        """Remove shared team relationship (soft delete by setting status to rejected)"""
        resource_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM,
                ResourceMember.resource_id == team_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .first()
        )

        if not resource_member:
            raise HTTPException(
                status_code=404, detail="Shared team relationship not found"
            )

        resource_member.status = MemberStatus.REJECTED
        resource_member.updated_at = datetime.now()
        db.commit()

        return True

    def cleanup_shared_teams_on_team_delete(self, db: Session, team_id: int) -> None:
        """Clean up shared team relationships when team is deleted"""
        db.query(ResourceMember).filter(
            ResourceMember.resource_type == ResourceType.TEAM,
            ResourceMember.resource_id == team_id,
        ).delete()

        db.commit()

    def validate_team_exists(self, db: Session, team_id: int, user_id: int) -> bool:
        """Validate that team exists and belongs to user"""
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        return team is not None

    def share_team(self, db: Session, team_id: int, user_id: int) -> TeamShareResponse:
        """Generate team share link"""

        # Get team name
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if team is None:
            raise HTTPException(status_code=404, detail="Team not found")
        else:
            # Update team, record sharing status in labels as share_status = 1 (0-private, 1-sharing, 2-shared from others)
            team_crd = Team.model_validate(team.json)

            if team_crd.metadata.labels is None:
                team_crd.metadata.labels = {}

            team_crd.metadata.labels["share_status"] = "1"

            team.json = team_crd.model_dump(mode="json")
            team.updated_at = datetime.now()
            flag_modified(team, "json")

            db.commit()
            db.refresh(team)

        share_link = self.create_share_link(db, team_id, user_id)

        # Generate share URL
        share_url = self.generate_share_url(share_link.share_token)

        return TeamShareResponse(
            share_url=share_url,
            share_token=share_link.share_token,
        )

    def get_share_info(
        self, db: Session, share_token: str, viewer_id: Optional[int] = None
    ) -> TeamShareInfo:
        """Get team share information from token"""
        share_info = self.decode_share_token(share_token, db, viewer_id)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Validate team still exists and is active
        team = (
            db.query(Kind)
            .filter(
                Kind.id == share_info.team_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=404, detail="Team not found or no longer available"
            )

        return share_info

    def join_shared_team(
        self, db: Session, share_token: str, user_id: int
    ) -> JoinSharedTeamResponse:
        """Join a shared team"""
        # Decode share token
        share_info = self.decode_share_token(share_token, db, user_id)

        if not share_info:
            raise HTTPException(status_code=400, detail="Invalid share token")

        # Check if share user is the same as current user
        if share_info.user_id == user_id:
            raise HTTPException(
                status_code=400, detail="Cannot join your own shared team"
            )

        # Validate team still exists and is active
        team = (
            db.query(Kind)
            .filter(
                Kind.id == share_info.team_id,
                Kind.user_id == share_info.user_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=404, detail="Team not found or no longer available"
            )

        # Create share relationship
        share_link = self._find_share_link(db, share_token)
        if not share_link:
            raise HTTPException(status_code=400, detail="Invalid share token")

        self.create_share_relationship(
            db=db,
            user_id=user_id,
            original_user_id=share_info.user_id,
            team_id=share_info.team_id,
            share_link=share_link,
        )

        return JoinSharedTeamResponse(
            message=(
                "Request submitted for approval"
                if share_link.require_approval
                else "Successfully joined shared team"
            ),
            team_id=share_info.team_id,
        )


shared_team_service = SharedTeamService()

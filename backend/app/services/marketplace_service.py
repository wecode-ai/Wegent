# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Marketplace service for Agent Marketplace feature.

This module provides business logic for:
- Browsing and searching marketplace teams
- Installing/uninstalling marketplace teams
- Admin publishing and management
"""

import copy
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.marketplace import InstalledTeam, TeamMarketplace
from app.schemas.kind import Bot, Team
from app.schemas.marketplace import (
    CategoryItem,
    InstalledTeamResponse,
    InstallMode,
    InstallTeamRequest,
    InstallTeamResponse,
    MarketplaceCategory,
    MarketplaceTeamDetail,
    MarketplaceTeamListItem,
    PublishTeamRequest,
    UninstallTeamResponse,
    UpdateMarketplaceTeamRequest,
)

logger = logging.getLogger(__name__)


class MarketplaceService:
    """Service for managing marketplace teams"""

    # ==================== Public API Methods ====================

    def get_marketplace_teams(
        self,
        db: Session,
        user_id: int,
        page: int = 1,
        limit: int = 20,
        search: Optional[str] = None,
        category: Optional[str] = None,
    ) -> Tuple[List[MarketplaceTeamListItem], int]:
        """
        Get marketplace teams list with pagination, search, and filtering.

        Args:
            db: Database session
            user_id: Current user ID (for checking installation status)
            page: Page number (1-indexed)
            limit: Items per page
            search: Search keyword (matches name and description)
            category: Category filter

        Returns:
            Tuple of (list of marketplace teams, total count)
        """
        # Build base query for active marketplace teams
        query = db.query(TeamMarketplace).filter(TeamMarketplace.is_active == True)

        # Apply category filter
        if category:
            query = query.filter(TeamMarketplace.category == category)

        # Apply search filter (need to join with Kind to search team name)
        if search:
            # Get team IDs that match search criteria
            matching_team_ids = (
                db.query(Kind.id)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Team",
                    Kind.is_active == True,
                    Kind.name.ilike(f"%{search}%"),
                )
                .all()
            )
            matching_ids = [tid[0] for tid in matching_team_ids]

            # Also search in marketplace description
            query = query.filter(
                (TeamMarketplace.team_id.in_(matching_ids))
                | (TeamMarketplace.description.ilike(f"%{search}%"))
            )

        # Get total count before pagination
        total = query.count()

        # Apply pagination and ordering
        skip = (page - 1) * limit
        marketplace_teams = (
            query.order_by(TeamMarketplace.install_count.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        # Get user's installed teams for status checking
        user_installed = self._get_user_installed_map(db, user_id)

        # Convert to response items
        items = []
        for mp_team in marketplace_teams:
            item = self._convert_to_list_item(db, mp_team, user_installed)
            if item:
                items.append(item)

        return items, total

    def get_marketplace_team_detail(
        self, db: Session, marketplace_id: int, user_id: int
    ) -> MarketplaceTeamDetail:
        """
        Get detailed information for a marketplace team.

        Args:
            db: Database session
            marketplace_id: Marketplace team ID (team_marketplace.id)
            user_id: Current user ID

        Returns:
            MarketplaceTeamDetail with full team and bot information
        """
        # Get marketplace team
        mp_team = (
            db.query(TeamMarketplace)
            .filter(
                TeamMarketplace.id == marketplace_id, TeamMarketplace.is_active == True
            )
            .first()
        )

        if not mp_team:
            raise HTTPException(status_code=404, detail="Marketplace team not found")

        # Get team from kinds table
        team = (
            db.query(Kind)
            .filter(
                Kind.id == mp_team.team_id,
                Kind.user_id == 0,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Get user's installed status
        user_installed = self._get_user_installed_map(db, user_id)

        # Convert to detail response
        return self._convert_to_detail(db, mp_team, team, user_installed)

    def get_categories(self, db: Session) -> List[CategoryItem]:
        """
        Get all categories with their team counts.

        Args:
            db: Database session

        Returns:
            List of categories with counts
        """
        # Get counts per category
        category_counts = (
            db.query(TeamMarketplace.category, func.count(TeamMarketplace.id))
            .filter(TeamMarketplace.is_active == True)
            .group_by(TeamMarketplace.category)
            .all()
        )

        count_map = {cat: count for cat, count in category_counts}

        # Build category list with all predefined categories
        categories = []
        for cat in MarketplaceCategory:
            categories.append(
                CategoryItem(
                    value=cat.value, label=cat.value, count=count_map.get(cat.value, 0)
                )
            )

        return categories

    # ==================== Installation Methods ====================

    def install_team(
        self,
        db: Session,
        marketplace_id: int,
        user_id: int,
        request: InstallTeamRequest,
    ) -> InstallTeamResponse:
        """
        Install a marketplace team for a user.

        Args:
            db: Database session
            marketplace_id: Marketplace team ID
            user_id: User ID
            request: Installation request with mode

        Returns:
            InstallTeamResponse with installation details
        """
        # Get marketplace team
        mp_team = (
            db.query(TeamMarketplace)
            .filter(
                TeamMarketplace.id == marketplace_id, TeamMarketplace.is_active == True
            )
            .first()
        )

        if not mp_team:
            raise HTTPException(status_code=404, detail="Marketplace team not found")

        # Validate installation mode is allowed
        if request.mode == InstallMode.REFERENCE and not mp_team.allow_reference:
            raise HTTPException(
                status_code=400, detail="Reference mode is not allowed for this team"
            )
        if request.mode == InstallMode.COPY and not mp_team.allow_copy:
            raise HTTPException(
                status_code=400, detail="Copy mode is not allowed for this team"
            )

        # Check if already installed
        existing = (
            db.query(InstalledTeam)
            .filter(
                InstalledTeam.user_id == user_id,
                InstalledTeam.marketplace_team_id == marketplace_id,
                InstalledTeam.is_active == True,
            )
            .first()
        )

        if existing:
            raise HTTPException(status_code=400, detail="Team is already installed")

        # Check if previously installed (reactivate)
        previous = (
            db.query(InstalledTeam)
            .filter(
                InstalledTeam.user_id == user_id,
                InstalledTeam.marketplace_team_id == marketplace_id,
                InstalledTeam.is_active == False,
            )
            .first()
        )

        copied_team_id = None

        if request.mode == InstallMode.COPY:
            # Copy team and related resources to user space
            copied_team_id = self._copy_team_to_user(db, mp_team.team_id, user_id)

        if previous:
            # Reactivate previous installation
            previous.is_active = True
            previous.install_mode = request.mode.value
            previous.copied_team_id = copied_team_id
            previous.installed_at = datetime.now()
            previous.uninstalled_at = None
            installed_team = previous
        else:
            # Create new installation record
            installed_team = InstalledTeam(
                user_id=user_id,
                marketplace_team_id=marketplace_id,
                install_mode=request.mode.value,
                copied_team_id=copied_team_id,
                is_active=True,
            )
            db.add(installed_team)

        # Increment install count
        mp_team.install_count += 1

        db.commit()
        db.refresh(installed_team)

        return InstallTeamResponse(
            success=True,
            message="Team installed successfully",
            installed_team_id=installed_team.id,
            install_mode=request.mode.value,
            copied_team_id=copied_team_id,
        )

    def uninstall_team(
        self, db: Session, marketplace_id: int, user_id: int
    ) -> UninstallTeamResponse:
        """
        Uninstall a marketplace team for a user.

        Args:
            db: Database session
            marketplace_id: Marketplace team ID
            user_id: User ID

        Returns:
            UninstallTeamResponse
        """
        # Get installation record
        installed = (
            db.query(InstalledTeam)
            .filter(
                InstalledTeam.user_id == user_id,
                InstalledTeam.marketplace_team_id == marketplace_id,
                InstalledTeam.is_active == True,
            )
            .first()
        )

        if not installed:
            raise HTTPException(status_code=404, detail="Installation record not found")

        # Soft delete - mark as inactive
        installed.is_active = False
        installed.uninstalled_at = datetime.now()

        # Note: For copy mode, we keep the copied team in user space
        # User can manually delete it if needed

        db.commit()

        return UninstallTeamResponse(
            success=True, message="Team uninstalled successfully"
        )

    def get_user_installed_teams(
        self, db: Session, user_id: int
    ) -> List[InstalledTeamResponse]:
        """
        Get all installed teams for a user.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of installed team records with marketplace info
        """
        installed_teams = (
            db.query(InstalledTeam)
            .filter(InstalledTeam.user_id == user_id, InstalledTeam.is_active == True)
            .order_by(InstalledTeam.installed_at.desc())
            .all()
        )

        result = []
        for installed in installed_teams:
            # Get marketplace team info
            mp_team = (
                db.query(TeamMarketplace)
                .filter(TeamMarketplace.id == installed.marketplace_team_id)
                .first()
            )

            mp_item = None
            if mp_team:
                mp_item = self._convert_to_list_item(db, mp_team, {})

            result.append(
                InstalledTeamResponse(
                    id=installed.id,
                    user_id=installed.user_id,
                    marketplace_team_id=installed.marketplace_team_id,
                    install_mode=installed.install_mode,
                    copied_team_id=installed.copied_team_id,
                    is_active=installed.is_active,
                    installed_at=installed.installed_at,
                    uninstalled_at=installed.uninstalled_at,
                    marketplace_team=mp_item,
                )
            )

        return result

    # ==================== Admin Methods ====================

    def publish_team(self, db: Session, request: PublishTeamRequest) -> TeamMarketplace:
        """
        Publish a team to the marketplace (admin only).

        Args:
            db: Database session
            request: Publish request with team info

        Returns:
            Created TeamMarketplace record
        """
        # Validate team exists and is a system team (user_id=0)
        team = (
            db.query(Kind)
            .filter(
                Kind.id == request.team_id,
                Kind.user_id == 0,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found or is not a system team (user_id must be 0)",
            )

        # Check if already published
        existing = (
            db.query(TeamMarketplace)
            .filter(TeamMarketplace.team_id == request.team_id)
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400, detail="Team is already published to marketplace"
            )

        # Validate at least one mode is allowed
        if not request.allow_reference and not request.allow_copy:
            raise HTTPException(
                status_code=400,
                detail="At least one installation mode must be enabled",
            )

        # Create marketplace entry
        mp_team = TeamMarketplace(
            team_id=request.team_id,
            category=request.category.value,
            description=request.description,
            icon=request.icon,
            allow_reference=request.allow_reference,
            allow_copy=request.allow_copy,
            is_active=True,
            published_at=datetime.now(),
        )

        db.add(mp_team)
        db.commit()
        db.refresh(mp_team)

        return mp_team

    def update_marketplace_team(
        self, db: Session, marketplace_id: int, request: UpdateMarketplaceTeamRequest
    ) -> TeamMarketplace:
        """
        Update marketplace team info (admin only).

        Args:
            db: Database session
            marketplace_id: Marketplace team ID
            request: Update request

        Returns:
            Updated TeamMarketplace record
        """
        mp_team = (
            db.query(TeamMarketplace)
            .filter(TeamMarketplace.id == marketplace_id)
            .first()
        )

        if not mp_team:
            raise HTTPException(status_code=404, detail="Marketplace team not found")

        # Update fields if provided
        if request.category is not None:
            mp_team.category = request.category.value
        if request.description is not None:
            mp_team.description = request.description
        if request.icon is not None:
            mp_team.icon = request.icon
        if request.allow_reference is not None:
            mp_team.allow_reference = request.allow_reference
        if request.allow_copy is not None:
            mp_team.allow_copy = request.allow_copy
        if request.is_active is not None:
            mp_team.is_active = request.is_active

        # Validate at least one mode is still allowed
        if not mp_team.allow_reference and not mp_team.allow_copy:
            raise HTTPException(
                status_code=400,
                detail="At least one installation mode must be enabled",
            )

        db.commit()
        db.refresh(mp_team)

        return mp_team

    def unpublish_team(self, db: Session, marketplace_id: int) -> bool:
        """
        Unpublish/deactivate a marketplace team (admin only).

        Args:
            db: Database session
            marketplace_id: Marketplace team ID

        Returns:
            True if successful
        """
        mp_team = (
            db.query(TeamMarketplace)
            .filter(TeamMarketplace.id == marketplace_id)
            .first()
        )

        if not mp_team:
            raise HTTPException(status_code=404, detail="Marketplace team not found")

        mp_team.is_active = False
        db.commit()

        return True

    def get_admin_marketplace_teams(
        self,
        db: Session,
        page: int = 1,
        limit: int = 20,
        include_inactive: bool = True,
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get all marketplace teams for admin (includes inactive).

        Args:
            db: Database session
            page: Page number
            limit: Items per page
            include_inactive: Include inactive teams

        Returns:
            Tuple of (list of marketplace teams, total count)
        """
        query = db.query(TeamMarketplace)

        if not include_inactive:
            query = query.filter(TeamMarketplace.is_active == True)

        total = query.count()

        skip = (page - 1) * limit
        marketplace_teams = (
            query.order_by(TeamMarketplace.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        items = []
        for mp_team in marketplace_teams:
            item = self._convert_to_admin_item(db, mp_team)
            if item:
                items.append(item)

        return items, total

    # ==================== Helper Methods ====================

    def _get_user_installed_map(
        self, db: Session, user_id: int
    ) -> Dict[int, InstalledTeam]:
        """Get a map of marketplace_team_id -> InstalledTeam for a user"""
        installed = (
            db.query(InstalledTeam)
            .filter(InstalledTeam.user_id == user_id, InstalledTeam.is_active == True)
            .all()
        )
        return {i.marketplace_team_id: i for i in installed}

    def _convert_to_list_item(
        self,
        db: Session,
        mp_team: TeamMarketplace,
        user_installed: Dict[int, InstalledTeam],
    ) -> Optional[MarketplaceTeamListItem]:
        """Convert TeamMarketplace to list item response"""
        # Get team from kinds table
        team = (
            db.query(Kind)
            .filter(
                Kind.id == mp_team.team_id,
                Kind.user_id == 0,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            return None

        # Parse team JSON
        try:
            team_crd = Team.model_validate(team.json)
        except Exception:
            return None

        # Check installation status
        installed = user_installed.get(mp_team.id)
        is_installed = installed is not None
        installed_mode = installed.install_mode if installed else None

        # Get agent_type from first bot's shell
        agent_type = self._get_team_agent_type(db, team_crd)

        return MarketplaceTeamListItem(
            id=mp_team.id,
            team_id=mp_team.team_id,
            name=team.name,
            category=mp_team.category,
            description=mp_team.description or team_crd.spec.description,
            icon=mp_team.icon or team_crd.spec.icon,
            allow_reference=mp_team.allow_reference,
            allow_copy=mp_team.allow_copy,
            install_count=mp_team.install_count,
            is_active=mp_team.is_active,
            published_at=mp_team.published_at,
            bind_mode=team_crd.spec.bind_mode,
            agent_type=agent_type,
            bots_count=len(team_crd.spec.members),
            is_installed=is_installed,
            installed_mode=installed_mode,
        )

    def _convert_to_detail(
        self,
        db: Session,
        mp_team: TeamMarketplace,
        team: Kind,
        user_installed: Dict[int, InstalledTeam],
    ) -> MarketplaceTeamDetail:
        """Convert to detail response with full team and bot info"""
        # Parse team JSON
        team_crd = Team.model_validate(team.json)

        # Check installation status
        installed = user_installed.get(mp_team.id)
        is_installed = installed is not None
        installed_mode = installed.install_mode if installed else None

        # Get agent_type
        agent_type = self._get_team_agent_type(db, team_crd)

        # Get bot details
        bots = self._get_team_bots_info(db, team_crd)

        return MarketplaceTeamDetail(
            id=mp_team.id,
            team_id=mp_team.team_id,
            name=team.name,
            category=mp_team.category,
            description=mp_team.description or team_crd.spec.description,
            icon=mp_team.icon or team_crd.spec.icon,
            allow_reference=mp_team.allow_reference,
            allow_copy=mp_team.allow_copy,
            install_count=mp_team.install_count,
            is_active=mp_team.is_active,
            published_at=mp_team.published_at,
            bind_mode=team_crd.spec.bind_mode,
            agent_type=agent_type,
            bots_count=len(team_crd.spec.members),
            is_installed=is_installed,
            installed_mode=installed_mode,
            team_data=team.json,
            bots=bots,
        )

    def _convert_to_admin_item(
        self, db: Session, mp_team: TeamMarketplace
    ) -> Optional[Dict[str, Any]]:
        """Convert to admin response with all fields"""
        item = self._convert_to_list_item(db, mp_team, {})
        if not item:
            return None

        return {
            **item.model_dump(),
            "created_at": mp_team.created_at,
            "updated_at": mp_team.updated_at,
        }

    def _get_team_agent_type(self, db: Session, team_crd: Team) -> Optional[str]:
        """Get agent_type from team's first bot's shell"""
        if not team_crd.spec.members:
            return None

        first_member = team_crd.spec.members[0]
        bot_ref = first_member.botRef

        # Get bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Bot",
                Kind.name == bot_ref.name,
                Kind.namespace == bot_ref.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return None

        try:
            bot_crd = Bot.model_validate(bot.json)
            shell_ref = bot_crd.spec.shellRef

            # Get shell
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == shell_ref.name,
                    Kind.namespace == shell_ref.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if shell:
                from app.schemas.kind import Shell

                shell_crd = Shell.model_validate(shell.json)
                shell_type = shell_crd.spec.shellType

                # Map shellType to agent_type
                type_map = {
                    "Agno": "agno",
                    "ClaudeCode": "claude",
                    "Dify": "dify",
                    "Chat": "chat",
                }
                return type_map.get(
                    shell_type, shell_type.lower() if shell_type else None
                )
        except Exception:
            pass

        return None

    def _get_team_bots_info(self, db: Session, team_crd: Team) -> List[Dict[str, Any]]:
        """Get basic bot information for team"""
        bots = []
        for member in team_crd.spec.members:
            bot_ref = member.botRef

            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Bot",
                    Kind.name == bot_ref.name,
                    Kind.namespace == bot_ref.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if bot:
                bots.append(
                    {
                        "id": bot.id,
                        "name": bot.name,
                        "role": member.role,
                        "prompt": member.prompt,
                    }
                )

        return bots

    def _copy_team_to_user(
        self, db: Session, marketplace_team_id: int, user_id: int
    ) -> int:
        """
        Deep copy a marketplace team and its related resources to user space.

        Args:
            db: Database session
            marketplace_team_id: Source team ID (user_id=0)
            user_id: Target user ID

        Returns:
            New team ID in user space
        """
        # Get source team
        source_team = (
            db.query(Kind)
            .filter(
                Kind.id == marketplace_team_id,
                Kind.user_id == 0,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not source_team:
            raise HTTPException(status_code=404, detail="Source team not found")

        team_crd = Team.model_validate(source_team.json)

        # Track copied resources to update references
        bot_name_map = {}  # old_name -> new_name

        # Copy bots and their related resources (Ghost, Model)
        for member in team_crd.spec.members:
            bot_ref = member.botRef

            # Get source bot
            source_bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Bot",
                    Kind.name == bot_ref.name,
                    Kind.namespace == bot_ref.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if not source_bot:
                continue

            bot_crd = Bot.model_validate(source_bot.json)

            # Copy Ghost
            new_ghost_name = self._copy_ghost_to_user(
                db, bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace, user_id
            )

            # Copy Model if exists
            new_model_name = None
            if bot_crd.spec.modelRef:
                new_model_name = self._copy_model_to_user(
                    db,
                    bot_crd.spec.modelRef.name,
                    bot_crd.spec.modelRef.namespace,
                    user_id,
                )

            # Create new bot with updated references
            new_bot_json = copy.deepcopy(source_bot.json)
            new_bot_name = self._generate_unique_name(
                db, user_id, "Bot", source_bot.name
            )
            new_bot_json["metadata"]["name"] = new_bot_name
            new_bot_json["spec"]["ghostRef"]["name"] = new_ghost_name
            if new_model_name:
                new_bot_json["spec"]["modelRef"]["name"] = new_model_name

            new_bot = Kind(
                user_id=user_id,
                kind="Bot",
                name=new_bot_name,
                namespace="default",
                json=new_bot_json,
                is_active=True,
            )
            db.add(new_bot)
            db.flush()

            bot_name_map[bot_ref.name] = new_bot_name

        # Create new team with updated bot references
        new_team_json = copy.deepcopy(source_team.json)
        new_team_name = self._generate_unique_name(
            db, user_id, "Team", source_team.name
        )
        new_team_json["metadata"]["name"] = new_team_name

        # Update member bot references
        for member in new_team_json["spec"]["members"]:
            old_bot_name = member["botRef"]["name"]
            if old_bot_name in bot_name_map:
                member["botRef"]["name"] = bot_name_map[old_bot_name]
            member["botRef"]["namespace"] = "default"

        new_team = Kind(
            user_id=user_id,
            kind="Team",
            name=new_team_name,
            namespace="default",
            json=new_team_json,
            is_active=True,
        )
        db.add(new_team)
        db.flush()

        return new_team.id

    def _copy_ghost_to_user(
        self, db: Session, ghost_name: str, ghost_namespace: str, user_id: int
    ) -> str:
        """Copy a ghost to user space, return new ghost name"""
        source_ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Ghost",
                Kind.name == ghost_name,
                Kind.namespace == ghost_namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not source_ghost:
            # If ghost not found, use the original name
            return ghost_name

        new_ghost_json = copy.deepcopy(source_ghost.json)
        new_ghost_name = self._generate_unique_name(
            db, user_id, "Ghost", source_ghost.name
        )
        new_ghost_json["metadata"]["name"] = new_ghost_name
        new_ghost_json["metadata"]["namespace"] = "default"

        new_ghost = Kind(
            user_id=user_id,
            kind="Ghost",
            name=new_ghost_name,
            namespace="default",
            json=new_ghost_json,
            is_active=True,
        )
        db.add(new_ghost)
        db.flush()

        return new_ghost_name

    def _copy_model_to_user(
        self, db: Session, model_name: str, model_namespace: str, user_id: int
    ) -> str:
        """Copy a model to user space, return new model name"""
        source_model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not source_model:
            # If model not found, use the original name
            return model_name

        new_model_json = copy.deepcopy(source_model.json)
        new_model_name = self._generate_unique_name(
            db, user_id, "Model", source_model.name
        )
        new_model_json["metadata"]["name"] = new_model_name
        new_model_json["metadata"]["namespace"] = "default"

        new_model = Kind(
            user_id=user_id,
            kind="Model",
            name=new_model_name,
            namespace="default",
            json=new_model_json,
            is_active=True,
        )
        db.add(new_model)
        db.flush()

        return new_model_name

    def _generate_unique_name(
        self, db: Session, user_id: int, kind: str, base_name: str
    ) -> str:
        """Generate a unique name for a resource in user space"""
        # Check if base name is available
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == kind,
                Kind.name == base_name,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )

        if not existing:
            return base_name

        # Add suffix to make it unique
        suffix = 1
        while True:
            new_name = f"{base_name}_{suffix}"
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == kind,
                    Kind.name == new_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .first()
            )
            if not existing:
                return new_name
            suffix += 1

    def get_installed_marketplace_team_ids(
        self, db: Session, user_id: int
    ) -> List[int]:
        """
        Get list of marketplace team_ids (from kinds table) that user has installed
        in reference mode.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of team IDs from kinds table
        """
        # Get installed teams in reference mode
        installed = (
            db.query(InstalledTeam)
            .join(
                TeamMarketplace,
                TeamMarketplace.id == InstalledTeam.marketplace_team_id,
            )
            .filter(
                InstalledTeam.user_id == user_id,
                InstalledTeam.is_active == True,
                InstalledTeam.install_mode == InstallMode.REFERENCE.value,
            )
            .all()
        )

        # Get team IDs from marketplace
        team_ids = []
        for inst in installed:
            mp_team = (
                db.query(TeamMarketplace)
                .filter(TeamMarketplace.id == inst.marketplace_team_id)
                .first()
            )
            if mp_team:
                team_ids.append(mp_team.team_id)

        return team_ids


marketplace_service = MarketplaceService()

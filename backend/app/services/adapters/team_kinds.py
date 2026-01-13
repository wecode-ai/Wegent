# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import copy
import json
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

from fastapi import HTTPException
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted
from sqlalchemy import literal_column, union_all
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.shared_team import SharedTeam
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team
from app.schemas.team import BotInfo, TeamCreate, TeamDetail, TeamInDB, TeamUpdate
from app.services.adapters.shell_utils import get_shell_type
from app.services.base import BaseService
from app.services.readers.kinds import KindType, kindReader
from app.services.readers.shared_teams import sharedTeamReader
from app.services.readers.users import userReader


class TeamKindsService(BaseService[Kind, TeamCreate, TeamUpdate]):
    """
    Team service class using kinds table
    """

    # List of sensitive keys that should be decrypted when reading
    SENSITIVE_CONFIG_KEYS = [
        "DIFY_API_KEY",
        # Add more sensitive keys here as needed
    ]

    def _decrypt_agent_config(self, agent_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Decrypt sensitive data in agent_config when reading

        Args:
            agent_config: Agent config with potentially encrypted fields

        Returns:
            Agent config with decrypted sensitive fields
        """
        # Create a deep copy to avoid modifying the original
        decrypted_config = copy.deepcopy(agent_config)

        # Decrypt sensitive keys in env section
        if "env" in decrypted_config:
            for key in self.SENSITIVE_CONFIG_KEYS:
                if key in decrypted_config["env"]:
                    value = decrypted_config["env"][key]
                    # Only decrypt if it appears to be encrypted
                    if value and is_data_encrypted(str(value)):
                        decrypted_value = decrypt_sensitive_data(str(value))
                        if decrypted_value:
                            decrypted_config["env"][key] = decrypted_value

        return decrypted_config

    def create_with_user(
        self,
        db: Session,
        *,
        obj_in: TeamCreate,
        user_id: int,
        group_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create user Team using kinds table.

        If group_name is provided, creates the team in that group's namespace.
        User must have Developer+ permission in the group.
        """
        from app.schemas.namespace import GroupRole
        from app.services.group_permission import check_group_permission

        namespace = "default"

        if group_name:
            # Validate user has Developer+ permission in group
            if not check_group_permission(db, user_id, group_name, GroupRole.Developer):
                raise HTTPException(
                    status_code=403,
                    detail=f"You need at least Developer role in group '{group_name}' to create teams",
                )
            namespace = group_name

        # Check duplicate team name (only active teams)
        # For personal teams (default namespace): check uniqueness per user
        # For group teams: check uniqueness within the group namespace
        existing_query = db.query(Kind).filter(
            Kind.kind == "Team",
            Kind.name == obj_in.name,
            Kind.namespace == namespace,
            Kind.is_active == True,
        )
        if namespace == "default":
            # Personal team: also filter by user_id
            existing_query = existing_query.filter(Kind.user_id == user_id)
        existing = existing_query.first()

        if existing:
            raise HTTPException(
                status_code=400,
                detail="Team name already exists, please modify the name",
            )

        # Validate bots
        self._validate_bots(db, obj_in.bots, user_id)

        # Convert bots to members format
        members = []
        for bot_info in obj_in.bots:
            bot_id = (
                bot_info.bot_id if hasattr(bot_info, "bot_id") else bot_info["bot_id"]
            )
            bot_prompt = (
                bot_info.bot_prompt
                if hasattr(bot_info, "bot_prompt")
                else bot_info.get("bot_prompt", "")
            )
            role = (
                bot_info.role if hasattr(bot_info, "role") else bot_info.get("role", "")
            )
            require_confirmation = (
                bot_info.requireConfirmation
                if hasattr(bot_info, "requireConfirmation")
                else bot_info.get("requireConfirmation", False)
            )

            # Get bot from kinds table
            bot = kindReader.get_by_id(db, KindType.BOT, bot_id)

            if not bot:
                raise HTTPException(
                    status_code=400, detail=f"Bot with id {bot_id} not found"
                )

            member = {
                "botRef": {"name": bot.name, "namespace": bot.namespace},
                "prompt": bot_prompt or "",
                "role": role or "",
                "requireConfirmation": require_confirmation or False,
            }
            members.append(member)

        # Extract collaboration model from workflow
        collaboration_model = "pipeline"
        if obj_in.workflow and "mode" in obj_in.workflow:
            collaboration_model = obj_in.workflow["mode"]

        # Build spec with bind_mode and description if provided
        spec = {"members": members, "collaborationModel": collaboration_model}

        # Handle bind_mode - get from obj_in directly (not from workflow)
        bind_mode = getattr(obj_in, "bind_mode", None)
        if bind_mode is not None:
            spec["bind_mode"] = bind_mode

        # Handle description - get from obj_in directly
        description = getattr(obj_in, "description", None)
        if description is not None:
            spec["description"] = description

        # Handle icon - get from obj_in directly
        icon = getattr(obj_in, "icon", None)
        if icon is not None:
            spec["icon"] = icon

        # Create Team JSON
        team_json = {
            "kind": "Team",
            "spec": spec,
            "status": {"state": "Available"},
            "metadata": {"name": obj_in.name, "namespace": namespace},
            "apiVersion": "agent.wecode.io/v1",
        }

        team = Kind(
            user_id=user_id,
            kind="Team",
            name=obj_in.name,
            namespace=namespace,
            json=team_json,
            is_active=True,
        )
        db.add(team)

        db.commit()
        db.refresh(team)

        return self._convert_to_team_dict(team, db, user_id)

    def get_user_teams(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        scope: str = "personal",
        group_name: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get user's Team list (only active teams) including shared teams.
        Uses database union query for better performance and pagination.

        Scope behavior:
        - scope='personal' (default): personal teams + public teams + shared teams
        - scope='group': group teams + public teams (requires group_name)
        - scope='all': personal + public + shared + all user's groups
        """
        total_start = time.time()
        from app.services.group_permission import get_user_groups

        # Determine which namespaces to query based on scope
        namespaces_to_query = []

        t0 = time.time()
        if scope == "personal":
            # Personal teams only (default namespace)
            namespaces_to_query = ["default"]
        elif scope == "group":
            # Group teams - if group_name not provided, query all user's groups
            if group_name:
                namespaces_to_query = [group_name]
            else:
                # Query all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                namespaces_to_query = user_groups if user_groups else []
        elif scope == "all":
            # Personal + all user's groups
            namespaces_to_query = ["default"] + get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")
        logger.info(
            f"[get_user_teams] get_user_groups took {time.time() - t0:.3f}s, namespaces={namespaces_to_query}"
        )

        # Build queries for each namespace
        queries = []

        for namespace in namespaces_to_query:
            if namespace == "default":
                # Query for user's own teams in default namespace
                own_teams_query = db.query(
                    Kind.id.label("team_id"),
                    Kind.user_id.label("team_user_id"),
                    Kind.name.label("team_name"),
                    Kind.namespace.label("team_namespace"),
                    Kind.json.label("team_json"),
                    Kind.created_at.label("team_created_at"),
                    Kind.updated_at.label("team_updated_at"),
                    literal_column("0").label(
                        "share_status"
                    ),  # Default 0 for own teams
                    literal_column(str(user_id)).label("context_user_id"),
                ).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                queries.append(own_teams_query)

                # Add shared teams for personal and all scopes
                if scope in ("personal", "all"):
                    # Query for shared teams
                    shared_teams_query = (
                        db.query(
                            Kind.id.label("team_id"),
                            Kind.user_id.label("team_user_id"),
                            Kind.name.label("team_name"),
                            Kind.namespace.label("team_namespace"),
                            Kind.json.label("team_json"),
                            Kind.created_at.label("team_created_at"),
                            Kind.updated_at.label("team_updated_at"),
                            literal_column("2").label(
                                "share_status"
                            ),  # 2 for shared teams
                            SharedTeam.original_user_id.label("context_user_id"),
                        )
                        .join(SharedTeam, SharedTeam.team_id == Kind.id)
                        .filter(
                            SharedTeam.user_id == user_id,
                            SharedTeam.is_active == True,
                            Kind.is_active == True,
                            Kind.kind == "Team",
                        )
                    )
                    queries.append(shared_teams_query)
            else:
                # Query for group teams
                group_teams_query = db.query(
                    Kind.id.label("team_id"),
                    Kind.user_id.label("team_user_id"),
                    Kind.name.label("team_name"),
                    Kind.namespace.label("team_namespace"),
                    Kind.json.label("team_json"),
                    Kind.created_at.label("team_created_at"),
                    Kind.updated_at.label("team_updated_at"),
                    literal_column("0").label("share_status"),
                    Kind.user_id.label("context_user_id"),
                ).filter(
                    Kind.kind == "Team",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                queries.append(group_teams_query)

        # Handle empty queries case
        if not queries:
            # No namespaces to query, return empty list
            return []

        # Combine queries using union all
        if len(queries) == 1:
            combined_query = queries[0].subquery()
        else:
            combined_query = union_all(*queries).alias("combined_teams")

        # Create final query with pagination
        final_query = (
            db.query(
                combined_query.c.team_id,
                combined_query.c.team_user_id,
                combined_query.c.team_name,
                combined_query.c.team_namespace,
                combined_query.c.team_json,
                combined_query.c.team_created_at,
                combined_query.c.team_updated_at,
                combined_query.c.share_status,
                combined_query.c.context_user_id,
            )
            .order_by(
                combined_query.c.team_updated_at.desc(), combined_query.c.team_id.desc()
            )
            .offset(skip)
            .limit(limit)
        )

        # Execute the query
        t1 = time.time()
        teams_data = final_query.all()
        logger.info(
            f"[get_user_teams] main query took {time.time() - t1:.3f}s, returned {len(teams_data)} teams"
        )

        # Get all unique user IDs for batch fetching user info
        user_ids = set()
        for team_data in teams_data:
            user_ids.add(team_data.team_user_id)

        # Batch fetch user info
        t2 = time.time()
        users_info = {}
        if user_ids:
            users = db.query(User).filter(User.id.in_(user_ids)).all()
            users_info = {user.id: user for user in users}
        logger.info(f"[get_user_teams] batch fetch users took {time.time() - t2:.3f}s")

        # Batch preload all related data (Bots, Shells, Models) to avoid N+1 queries
        t_preload = time.time()

        # Collect all bot refs from all teams
        # Separate personal bots from group bots since group bots can be created by any group member
        all_bot_refs = []  # List of (user_id, name, namespace) for personal teams
        group_bot_refs = set()  # Set of (name, namespace) for group teams
        context_user_ids = set()
        for team_data in teams_data:
            context_user_ids.add(team_data.context_user_id)
            team_crd = Team.model_validate(team_data.team_json)
            is_group_team = (
                team_data.team_namespace and team_data.team_namespace != "default"
            )
            for member in team_crd.spec.members:
                if is_group_team:
                    # For group teams, bots can be created by any group member
                    group_bot_refs.add(
                        (
                            member.botRef.name,
                            member.botRef.namespace,
                        )
                    )
                else:
                    all_bot_refs.append(
                        (
                            team_data.context_user_id,
                            member.botRef.name,
                            member.botRef.namespace,
                        )
                    )

        # Batch fetch all bots
        from sqlalchemy import and_, or_

        bots_cache = {}  # (user_id, name, namespace) -> Kind for personal bots
        group_bots_cache = {}  # (name, namespace) -> Kind for group bots

        # Query personal bots (with user_id filter)
        if all_bot_refs:
            bot_conditions = []
            for uid, name, ns in all_bot_refs:
                bot_conditions.append(
                    and_(Kind.user_id == uid, Kind.name == name, Kind.namespace == ns)
                )
            bots_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Bot", Kind.is_active == True, or_(*bot_conditions)
                )
                .all()
            )
            for bot in bots_query:
                bots_cache[(bot.user_id, bot.name, bot.namespace)] = bot

        # Query group bots (without user_id filter)
        if group_bot_refs:
            group_bot_conditions = []
            for name, ns in group_bot_refs:
                group_bot_conditions.append(
                    and_(Kind.name == name, Kind.namespace == ns)
                )
            group_bots_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Bot",
                    Kind.is_active == True,
                    or_(*group_bot_conditions),
                )
                .all()
            )
            for bot in group_bots_query:
                group_bots_cache[(bot.name, bot.namespace)] = bot

        logger.info(
            f"[get_user_teams] batch fetch bots took {time.time() - t_preload:.3f}s, fetched {len(bots_cache)} personal bots, {len(group_bots_cache)} group bots"
        )

        # Collect all shell refs and model refs from bots (both personal and group bots)
        t_shell_model = time.time()
        all_shell_refs = set()  # (user_id, name, namespace)
        all_model_refs = set()  # (user_id, name, namespace)

        # Collect from personal bots
        for bot in bots_cache.values():
            bot_crd = Bot.model_validate(bot.json)
            all_shell_refs.add(
                (
                    bot.user_id,
                    bot_crd.spec.shellRef.name,
                    bot_crd.spec.shellRef.namespace,
                )
            )
            if bot_crd.spec.modelRef:
                all_model_refs.add(
                    (
                        bot.user_id,
                        bot_crd.spec.modelRef.name,
                        bot_crd.spec.modelRef.namespace,
                    )
                )

        # Collect from group bots
        for bot in group_bots_cache.values():
            bot_crd = Bot.model_validate(bot.json)
            all_shell_refs.add(
                (
                    bot.user_id,
                    bot_crd.spec.shellRef.name,
                    bot_crd.spec.shellRef.namespace,
                )
            )
            if bot_crd.spec.modelRef:
                all_model_refs.add(
                    (
                        bot.user_id,
                        bot_crd.spec.modelRef.name,
                        bot_crd.spec.modelRef.namespace,
                    )
                )

        # Batch fetch all user shells (user_id > 0)
        shells_cache = {}  # (user_id, name, namespace) -> Kind
        user_shell_refs = [
            (uid, name, ns) for uid, name, ns in all_shell_refs if uid > 0
        ]
        if user_shell_refs:
            shell_conditions = []
            for uid, name, ns in user_shell_refs:
                shell_conditions.append(
                    and_(Kind.user_id == uid, Kind.name == name, Kind.namespace == ns)
                )
            shells_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell", Kind.is_active == True, or_(*shell_conditions)
                )
                .all()
            )
            for shell in shells_query:
                shells_cache[(shell.user_id, shell.name, shell.namespace)] = shell

        # Batch fetch public shells (user_id = 0) for shells not found in user shells
        # Public shells are identified by name only (they are in 'default' namespace)
        # We need to check all shell refs, not just those with uid > 0
        public_shell_names = set()
        for uid, name, ns in all_shell_refs:
            # Always add to public_shell_names if not found in user shells cache
            if (uid, name, ns) not in shells_cache:
                public_shell_names.add(name)
                logger.debug(
                    f"[get_user_teams] Shell not in user cache: uid={uid}, name={name}, ns={ns}, adding to public_shell_names"
                )

        logger.debug(
            f"[get_user_teams] public_shell_names to query: {public_shell_names}"
        )

        public_shells_cache = (
            {}
        )  # name -> Kind (public shells are looked up by name only)
        if public_shell_names:
            public_shells_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.user_id == 0,  # Public shells have user_id = 0
                    Kind.is_active == True,
                    Kind.name.in_(public_shell_names),
                )
                .all()
            )
            for shell in public_shells_query:
                public_shells_cache[shell.name] = shell
                logger.debug(
                    f"[get_user_teams] Found public shell: name={shell.name}, namespace={shell.namespace}"
                )

        logger.info(
            f"[get_user_teams] batch fetch shells took {time.time() - t_shell_model:.3f}s, fetched {len(shells_cache)} user shells, {len(public_shells_cache)} public shells"
        )

        # Batch fetch all user models (user_id > 0)
        t_model = time.time()
        models_cache = {}  # (user_id, name, namespace) -> Kind
        user_model_refs = [
            (uid, name, ns) for uid, name, ns in all_model_refs if uid > 0
        ]
        if user_model_refs:
            model_conditions = []
            for uid, name, ns in user_model_refs:
                model_conditions.append(
                    and_(Kind.user_id == uid, Kind.name == name, Kind.namespace == ns)
                )
            models_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model", Kind.is_active == True, or_(*model_conditions)
                )
                .all()
            )
            for model in models_query:
                models_cache[(model.user_id, model.name, model.namespace)] = model

        # Batch fetch public models (user_id = 0) for models not found in user models
        # Public models are identified by name only (they are in 'default' namespace)
        public_model_names = set()
        for uid, name, ns in all_model_refs:
            if (uid, name, ns) not in models_cache:
                public_model_names.add(name)

        public_models_cache = (
            {}
        )  # name -> Kind (public models are looked up by name only)
        if public_model_names:
            public_models_query = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.user_id == 0,  # Public models have user_id = 0
                    Kind.is_active == True,
                    Kind.name.in_(public_model_names),
                )
                .all()
            )
            for model in public_models_query:
                public_models_cache[model.name] = model

        logger.info(
            f"[get_user_teams] batch fetch models took {time.time() - t_model:.3f}s, fetched {len(models_cache)} user models, {len(public_models_cache)} public models"
        )

        # Build cache dict for passing to conversion methods
        preloaded_cache = {
            "bots": bots_cache,
            "group_bots": group_bots_cache,  # Add group bots cache for group resources
            "shells": shells_cache,
            "public_shells": public_shells_cache,
            "models": models_cache,
            "public_models": public_models_cache,
        }

        # Convert to result format
        t3 = time.time()
        result = []
        for team_data in teams_data:
            # Create a temporary Kind object for conversion
            temp_team = Kind(
                id=team_data.team_id,
                user_id=team_data.team_user_id,
                name=team_data.team_name,
                namespace=team_data.team_namespace,
                json=team_data.team_json,
                created_at=team_data.team_created_at,
                updated_at=team_data.team_updated_at,
                is_active=True,
            )

            # Convert to team dict using the appropriate context user ID and preloaded cache
            team_dict = self._convert_to_team_dict_with_cache(
                temp_team, db, team_data.context_user_id, preloaded_cache
            )

            # For own teams, check if share_status is set in metadata.labels
            if team_data.share_status == 0:  # This is an own team
                team_crd = Team.model_validate(team_data.team_json)
                if (
                    team_crd.metadata.labels
                    and "share_status" in team_crd.metadata.labels
                ):
                    team_dict["share_status"] = int(
                        team_crd.metadata.labels["share_status"]
                    )
            else:  # This is a shared team
                team_dict["share_status"] = 2

            # Add user info
            team_user = users_info.get(team_data.team_user_id)
            if team_user:
                team_dict["user"] = {
                    "id": team_user.id,
                    "user_name": team_user.user_name,
                }

            result.append(team_dict)

        logger.info(
            f"[get_user_teams] convert to result took {time.time() - t3:.3f}s for {len(result)} teams"
        )
        logger.info(f"[get_user_teams] TOTAL took {time.time() - total_start:.3f}s")
        return result

    def get_by_id_and_user(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Team by ID and user ID (only active teams)
        """
        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        return self._convert_to_team_dict(team, db, team.user_id)

    def get_team_detail(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed team information including related user and bots
        """
        # Check if user has access to this team (own or shared)
        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Check if user is the owner or has shared access
        is_author = team.user_id == user_id
        shared_team = None

        if not is_author:
            # Check if user has shared access
            shared_team = sharedTeamReader.get_by_team_and_user(db, team_id, user_id)
            if not shared_team:
                raise HTTPException(
                    status_code=403, detail="Access denied to this team"
                )

        # Get team dict using the original user's context
        original_user_id = team.user_id if is_author else shared_team.original_user_id
        team_dict = self._convert_to_team_dict(team, db, original_user_id)

        # Get related user (original author)
        user = userReader.get_by_id(db, original_user_id)

        # Get detailed bot information
        detailed_bots = []
        for bot_info in team_dict["bots"]:
            bot_id = bot_info["bot_id"]
            # Get bot from kinds table
            bot = kindReader.get_by_id(db, KindType.BOT, bot_id)

            if bot:
                bot_dict = self._convert_bot_to_dict(bot, db, bot.user_id)
                detailed_bots.append(
                    {
                        "bot": bot_dict,
                        "bot_prompt": bot_info.get("bot_prompt"),
                        "role": bot_info.get("role"),
                    }
                )

        # Set share_status: 0-private, 1-sharing, 2-shared from others
        if is_author:
            team_crd = Team.model_validate(team.json)
            share_status = "0"  # Default to private

            if team_crd.metadata.labels and "share_status" in team_crd.metadata.labels:
                share_status = team_crd.metadata.labels["share_status"]

            team_dict["share_status"] = int(share_status)
        else:
            team_dict["share_status"] = 2  # shared from others
            user.git_info = []

        team_dict["bots"] = detailed_bots
        team_dict["user"] = user

        return team_dict

    def update_with_user(
        self, db: Session, *, team_id: int, obj_in: TeamUpdate, user_id: int
    ) -> Dict[str, Any]:
        """
        Update user Team.
        For group teams, user must have Developer+ permission.
        """
        from app.schemas.namespace import GroupRole
        from app.services.group_permission import check_group_permission

        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Check permissions
        if team.namespace != "default":
            # Group team - check permission
            if not check_group_permission(
                db, user_id, team.namespace, GroupRole.Developer
            ):
                raise HTTPException(
                    status_code=403,
                    detail=f"You need at least Developer role in group '{team.namespace}' to update this team",
                )
        else:
            # Personal team - check ownership
            if team.user_id != user_id:
                raise HTTPException(status_code=403, detail="Access denied")

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness (only active teams), excluding current team
        # For personal teams (default namespace): check uniqueness per user
        # For group teams: check uniqueness within the group namespace
        if "name" in update_data:
            new_name = update_data["name"]
            if new_name != team.name:
                conflict_query = db.query(Kind).filter(
                    Kind.kind == "Team",
                    Kind.name == new_name,
                    Kind.namespace == team.namespace,
                    Kind.is_active == True,
                    Kind.id != team.id,
                )
                if team.namespace == "default":
                    # Personal team: also filter by user_id
                    conflict_query = conflict_query.filter(Kind.user_id == user_id)
                conflict = conflict_query.first()

                if conflict:
                    raise HTTPException(
                        status_code=400,
                        detail="Team name already exists, please modify the name",
                    )

        # Update team based on update_data
        team_crd = Team.model_validate(team.json)

        if "name" in update_data:
            new_name = update_data["name"]
            old_name = team.name
            team.name = new_name
            team_crd.metadata.name = new_name

            # Update all references to this team in tasks
            self._update_team_references_in_tasks(
                db, old_name, team.namespace, new_name, team.namespace, user_id
            )

        if "bots" in update_data:
            # Validate bots
            self._validate_bots(db, update_data["bots"], user_id)

            # Convert bots to members format
            from app.schemas.kind import BotTeamRef, TeamMember

            members = []
            members = []
            for bot_info in update_data["bots"]:
                bot_id = (
                    bot_info.bot_id
                    if hasattr(bot_info, "bot_id")
                    else bot_info["bot_id"]
                )
                bot_prompt = (
                    bot_info.bot_prompt
                    if hasattr(bot_info, "bot_prompt")
                    else bot_info.get("bot_prompt", "")
                )
                role = (
                    bot_info.role
                    if hasattr(bot_info, "role")
                    else bot_info.get("role", "")
                )
                require_confirmation = (
                    bot_info.requireConfirmation
                    if hasattr(bot_info, "requireConfirmation")
                    else bot_info.get("requireConfirmation", False)
                )

                # Get bot from kinds table
                bot = kindReader.get_by_id(db, KindType.BOT, bot_id)

                if not bot:
                    raise HTTPException(
                        status_code=400, detail=f"Bot with id {bot_id} not found"
                    )

                member = TeamMember(
                    botRef=BotTeamRef(name=bot.name, namespace=bot.namespace),
                    prompt=bot_prompt or "",
                    role=role or "",
                    requireConfirmation=require_confirmation or False,
                )
                members.append(member)
            team_crd.spec.members = members

        if "workflow" in update_data:
            # Extract collaboration model from workflow
            collaboration_model = "pipeline"
            if update_data["workflow"] and "mode" in update_data["workflow"]:
                collaboration_model = update_data["workflow"]["mode"]

            team_crd.spec.collaborationModel = collaboration_model

        # Handle bind_mode update - directly from update_data (not from workflow)
        if "bind_mode" in update_data:
            team_crd.spec.bind_mode = update_data["bind_mode"]

        # Handle description update
        if "description" in update_data:
            team_crd.spec.description = update_data["description"]

        # Handle icon update
        if "icon" in update_data:
            team_crd.spec.icon = update_data["icon"]

        # Save the updated team CRD
        team.json = team_crd.model_dump(mode="json")
        team.updated_at = datetime.now()
        flag_modified(team, "json")

        db.commit()
        db.refresh(team)

        return self._convert_to_team_dict(team, db, user_id)

    def _get_running_tasks_for_team(
        self, db: Session, team_name: str, team_namespace: str
    ) -> List[Dict[str, Any]]:
        """
        Get all running tasks for a team.

        Args:
            db: Database session
            team_name: Team name
            team_namespace: Team namespace

        Returns:
            List of running task info dictionaries
        """
        from sqlalchemy import func, or_

        from app.models.task import TaskResource

        # Use JSON queries to filter at database level instead of loading all tasks into memory
        # This is much faster when there are many tasks
        tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
                # Filter by team reference using JSON path
                func.json_unquote(
                    func.json_extract(TaskResource.json, "$.spec.teamRef.name")
                )
                == team_name,
                func.json_unquote(
                    func.json_extract(TaskResource.json, "$.spec.teamRef.namespace")
                )
                == team_namespace,
                # Filter by status using JSON path - only get PENDING or RUNNING tasks
                or_(
                    func.json_unquote(
                        func.json_extract(TaskResource.json, "$.status.status")
                    )
                    == "PENDING",
                    func.json_unquote(
                        func.json_extract(TaskResource.json, "$.status.status")
                    )
                    == "RUNNING",
                ),
            )
            .all()
        )

        running_tasks = []
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            running_tasks.append(
                {
                    "task_id": task.id,
                    "task_name": task.name,
                    "task_title": task_crd.spec.title,
                    "status": task_crd.status.status if task_crd.status else "UNKNOWN",
                }
            )

        return running_tasks

    def check_running_tasks(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Check if a team has any running tasks.

        Args:
            db: Database session
            team_id: Team ID to check
            user_id: User ID

        Returns:
            Dictionary with has_running_tasks flag and list of running tasks
        """
        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        team_name = team.name
        team_namespace = team.namespace

        # Get running tasks for this team
        running_tasks = self._get_running_tasks_for_team(db, team_name, team_namespace)

        return {
            "has_running_tasks": len(running_tasks) > 0,
            "running_tasks_count": len(running_tasks),
            "running_tasks": running_tasks,
        }

    def delete_with_user(
        self, db: Session, *, team_id: int, user_id: int, force: bool = False
    ) -> None:
        """
        Delete user Team.
        For group teams, user must have Developer+ permission.

        Args:
            db: Database session
            team_id: Team ID to delete
            user_id: User ID
            force: If True, force delete even if there are running tasks
        """
        from app.schemas.namespace import GroupRole
        from app.services.group_permission import check_group_permission

        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # delete join shared team entry if any
        if team.user_id != user_id:
            # Check if this is a shared team deletion
            shared_entry = sharedTeamReader.get_by_team_and_user(db, team_id, user_id)

            if shared_entry:
                # User is deleting their shared team access
                db.query(SharedTeam).filter(
                    SharedTeam.team_id == team_id,
                    SharedTeam.user_id == user_id,
                    SharedTeam.is_active == True,
                ).delete()
                db.commit()
                return

            # Not a shared team, check if it's a group team
            if team.namespace != "default":
                # Group team - check permission
                if not check_group_permission(
                    db, user_id, team.namespace, GroupRole.Developer
                ):
                    raise HTTPException(
                        status_code=403,
                        detail=f"You need at least Developer role in group '{team.namespace}' to delete this team",
                    )
            else:
                # Personal team but wrong owner
                raise HTTPException(status_code=403, detail="Access denied")

        team_name = team.name
        team_namespace = team.namespace

        # Check if team has running tasks (unless force delete)
        if not force:
            running_tasks = self._get_running_tasks_for_team(
                db, team_name, team_namespace
            )
            if running_tasks:
                raise HTTPException(
                    status_code=400,
                    detail=f"Team '{team_name}' has {len(running_tasks)} running task(s). Use force=true to delete anyway.",
                )

        # delete share team
        db.query(SharedTeam).filter(
            SharedTeam.team_id == team_id, SharedTeam.is_active == True
        ).delete()

        db.delete(team)
        db.commit()

    def count_user_teams(
        self,
        db: Session,
        *,
        user_id: int,
        scope: str = "personal",
        group_name: Optional[str] = None,
    ) -> int:
        """
        Count user's active teams based on scope.

        Scope behavior:
        - scope='personal' (default): personal teams + shared teams
        - scope='group': group teams (requires group_name)
        - scope='all': personal + shared + all user's groups
        """
        from app.services.group_permission import get_user_groups

        # Determine which namespaces to count based on scope
        namespaces_to_count = []

        if scope == "personal":
            namespaces_to_count = ["default"]
        elif scope == "group":
            # Group teams - if group_name not provided, count all user's groups
            if group_name:
                namespaces_to_count = [group_name]
            else:
                # Count all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                namespaces_to_count = user_groups if user_groups else []
        elif scope == "all":
            namespaces_to_count = ["default"] + get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        total_count = 0

        for namespace in namespaces_to_count:
            if namespace == "default":
                # Count user's own teams
                own_teams_count = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.kind == "Team",
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                    .count()
                )
                total_count += own_teams_count

                # Count shared teams (for personal and all scopes)
                if scope in ("personal", "all"):
                    shared_teams_count = (
                        db.query(SharedTeam)
                        .join(Kind, SharedTeam.team_id == Kind.id)
                        .filter(
                            SharedTeam.user_id == user_id,
                            SharedTeam.is_active == True,
                            Kind.is_active == True,
                            Kind.kind == "Team",
                        )
                        .count()
                    )
                    total_count += shared_teams_count
            else:
                # Count group teams
                group_teams_count = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Team",
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .count()
                )
                total_count += group_teams_count

        return total_count

    def _validate_bots(self, db: Session, bots: List[BotInfo], user_id: int) -> None:
        """
        Validate bots and check if bots belong to user and are active
        Also validates Dify runtime constraint: Dify Teams must have exactly one bot
        """
        if not bots:
            raise HTTPException(status_code=400, detail="bots cannot be empty")

        bot_id_list = []
        for bot in bots:
            if hasattr(bot, "bot_id"):
                bot_id_list.append(bot.bot_id)
            elif isinstance(bot, dict) and "bot_id" in bot:
                bot_id_list.append(bot["bot_id"])
            else:
                raise HTTPException(
                    status_code=400, detail="Invalid bot format: missing bot_id"
                )

        # Check if all bots exist, belong to user, and are active in kinds table
        bots_in_db = kindReader.get_by_ids(db, KindType.BOT, bot_id_list)

        found_bot_ids = {bot.id for bot in bots_in_db}
        missing_bot_ids = set(bot_id_list) - found_bot_ids

        if missing_bot_ids:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid or inactive bot_ids: {', '.join(map(str, missing_bot_ids))}",
            )

        # Validate external API shell constraint: must have exactly one bot
        for bot in bots_in_db:
            bot_crd = Bot.model_validate(bot.json)

            # Get shell type using utility function
            shell_type = get_shell_type(
                db, bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace, user_id
            )

            if shell_type == "external_api":
                # Get shell for error message (with public fallback)
                shell = kindReader.get_by_name_and_namespace(
                    db,
                    user_id,
                    KindType.SHELL,
                    bot_crd.spec.shellRef.namespace,
                    bot_crd.spec.shellRef.name,
                )

                if shell:
                    shell_crd = Shell.model_validate(shell.json)
                    # External API shells (like Dify) can only have one bot per team
                    if len(bots) > 1:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Teams using external API shells ({shell_crd.spec.shellType}) must have exactly one bot. Found {len(bots)} bots.",
                        )

    def get_team_by_name_and_namespace(
        self, db: Session, team_name: str, team_namespace: str, user_id: int
    ) -> Optional[Kind]:
        # Use kindReader which handles personal and shared teams logic
        return kindReader.get_by_name_and_namespace(
            db, user_id, KindType.TEAM, team_namespace, team_name
        )

    def get_team_by_name_and_namespace_without_user_check(
        self, db: Session, team_name: str, team_namespace: str
    ) -> Optional[Kind]:
        """
        Get team by name and namespace without checking user ownership.
        Used for group chat members to access the task's team.
        """
        team = (
            db.query(Kind)
            .filter(
                Kind.name == team_name,
                Kind.namespace == team_namespace,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )
        return team

    def _convert_to_team_dict(
        self, team: Kind, db: Session, user_id: int
    ) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary
        """
        convert_start = time.time()

        team_crd = Team.model_validate(team.json)

        # Convert members to bots format and collect shell_types for is_mix_team calculation
        bots = []
        shell_types = set()

        # Determine if this is a group resource
        is_group_resource = team.namespace and team.namespace != "default"

        t_bot_loop = time.time()
        for member in team_crd.spec.members:
            # Find bot in kinds table
            # For group resources, use get_group; otherwise use get_by_name_and_namespace
            t_find_bot = time.time()
            if is_group_resource:
                bot = kindReader.get_group(
                    db, KindType.BOT, member.botRef.namespace, member.botRef.name
                )
            else:
                bot = kindReader.get_by_name_and_namespace(
                    db,
                    team.user_id,
                    KindType.BOT,
                    member.botRef.namespace,
                    member.botRef.name,
                )
            find_bot_time = time.time() - t_find_bot

            if bot:
                t_summary = time.time()
                # For group resources, use bot's user_id to find related components
                summary_user_id = bot.user_id if is_group_resource else user_id
                bot_summary = self._get_bot_summary(bot, db, summary_user_id)
                summary_time = time.time() - t_summary
                if find_bot_time > 0.1 or summary_time > 0.1:
                    logger.info(
                        f"[_convert_to_team_dict] bot={member.botRef.name}: find_bot={find_bot_time:.3f}s, get_summary={summary_time:.3f}s"
                    )
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.prompt or "",
                    "role": member.role or "",
                    "requireConfirmation": member.requireConfirmation or False,
                    "bot": bot_summary,
                }
                bots.append(bot_info)

                # Collect shell_type for is_mix_team calculation
                if bot_summary.get("shell_type"):
                    shell_types.add(bot_summary["shell_type"])

        bot_loop_time = time.time() - t_bot_loop
        if bot_loop_time > 0.1:
            logger.info(
                f"[_convert_to_team_dict] team={team.name}: bot loop took {bot_loop_time:.3f}s for {len(team_crd.spec.members)} members"
            )

        # Calculate is_mix_team: true if there are multiple different shell types
        is_mix_team = len(shell_types) > 1

        # Get agent_type from the first bot's shell
        t_agent_type = time.time()
        agent_type = None
        if bots:
            first_bot_id = bots[0]["bot_id"]
            # Get first bot using kindReader
            first_bot = kindReader.get_by_id(db, KindType.BOT, first_bot_id)

            if first_bot:
                bot_crd = Bot.model_validate(first_bot.json)
                shell_type = None

                # Get shell using kindReader (handles public fallback automatically)
                shell_user_id = first_bot.user_id if is_group_resource else user_id
                shell = kindReader.get_by_name_and_namespace(
                    db,
                    shell_user_id,
                    KindType.SHELL,
                    bot_crd.spec.shellRef.namespace,
                    bot_crd.spec.shellRef.name,
                )

                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type = shell_crd.spec.shellType

                if shell_type:
                    # Map shellType to agent type
                    if shell_type == "Agno":
                        agent_type = "agno"
                    elif shell_type == "ClaudeCode":
                        agent_type = "claude"
                    elif shell_type == "Dify":
                        agent_type = "dify"
                    else:
                        agent_type = shell_type.lower() if shell_type else None

        agent_type_time = time.time() - t_agent_type
        if agent_type_time > 0.1:
            logger.info(
                f"[_convert_to_team_dict] team={team.name}: agent_type lookup took {agent_type_time:.3f}s"
            )

        # Convert collaboration model to workflow format
        workflow = {"mode": team_crd.spec.collaborationModel}

        # Get bind_mode from spec (directly, not from workflow)
        bind_mode = team_crd.spec.bind_mode

        # Get description from spec
        description = team_crd.spec.description

        # Get icon from spec
        icon = team_crd.spec.icon

        total_convert_time = time.time() - convert_start
        if total_convert_time > 0.2:
            logger.info(
                f"[_convert_to_team_dict] team={team.name}: TOTAL convert took {total_convert_time:.3f}s"
            )

        return {
            "id": team.id,
            "user_id": team.user_id,
            "name": team.name,
            "namespace": team.namespace,  # Add namespace field
            "description": description,
            "bots": bots,
            "workflow": workflow,
            "bind_mode": bind_mode,
            "is_mix_team": is_mix_team,
            "is_active": team.is_active,
            "created_at": team.created_at,
            "updated_at": team.updated_at,
            "agent_type": agent_type,  # Add agent_type field
            "icon": icon,  # Add icon field
        }

    def _convert_to_team_dict_with_cache(
        self, team: Kind, db: Session, user_id: int, cache: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary using preloaded cache.
        This is an optimized version that avoids N+1 queries by using batch-loaded data.

        Args:
            team: The team Kind object
            db: Database session (only used for fallback queries if cache miss)
            user_id: The user ID for context
            cache: Preloaded cache containing:
                - bots: Dict[(user_id, name, namespace), Kind] for personal bots
                - group_bots: Dict[(name, namespace), Kind] for group bots
                - shells: Dict[(user_id, name, namespace), Kind]
                - public_shells: Dict[name, Kind]
                - models: Dict[(user_id, name, namespace), Kind]
                - public_models: Dict[name, Kind]
        """
        team_crd = Team.model_validate(team.json)

        # Determine if this is a group resource
        is_group_resource = team.namespace and team.namespace != "default"

        # Convert members to bots format and collect shell_types for is_mix_team calculation
        bots = []
        shell_types = set()

        bots_cache = cache.get("bots", {})
        group_bots_cache = cache.get(
            "group_bots", {}
        )  # (name, namespace) -> Kind for group bots
        shells_cache = cache.get("shells", {})
        public_shells_cache = cache.get(
            "public_shells", {}
        )  # name -> Kind (not (name, namespace))
        models_cache = cache.get("models", {})
        public_models_cache = cache.get("public_models", {})

        for member in team_crd.spec.members:
            # Find bot in cache
            # For group resources, lookup by (name, namespace) only
            if is_group_resource:
                bot = group_bots_cache.get(
                    (member.botRef.name, member.botRef.namespace)
                )
            else:
                bot = bots_cache.get(
                    (user_id, member.botRef.name, member.botRef.namespace)
                )

            if bot:
                # For group resources, use bot's user_id for shell/model lookup
                lookup_user_id = bot.user_id if is_group_resource else user_id
                bot_summary = self._get_bot_summary_with_cache(
                    bot,
                    lookup_user_id,
                    shells_cache,
                    public_shells_cache,  # This is now name -> Kind
                    models_cache,
                    public_models_cache,
                )
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.prompt or "",
                    "role": member.role or "",
                    "requireConfirmation": member.requireConfirmation or False,
                    "bot": bot_summary,
                }
                bots.append(bot_info)

                # Collect shell_type for is_mix_team calculation
                if bot_summary.get("shell_type"):
                    shell_types.add(bot_summary["shell_type"])

        # Calculate is_mix_team: true if there are multiple different shell types
        is_mix_team = len(shell_types) > 1

        # Get agent_type from the first bot's shell
        agent_type = None
        if bots:
            first_bot_id = bots[0]["bot_id"]
            # Find first bot in cache (check both caches for group resources)
            first_bot = None
            if is_group_resource:
                for key, bot in group_bots_cache.items():
                    if bot.id == first_bot_id:
                        first_bot = bot
                        break
            else:
                for key, bot in bots_cache.items():
                    if bot.id == first_bot_id:
                        first_bot = bot
                        break

            if first_bot:
                bot_crd = Bot.model_validate(first_bot.json)
                shell_type = None
                shell_ref_name = bot_crd.spec.shellRef.name
                shell_ref_namespace = bot_crd.spec.shellRef.namespace

                # First check user's custom shells in cache
                # For group resources, use bot's user_id
                shell_lookup_user_id = (
                    first_bot.user_id if is_group_resource else user_id
                )
                shell = shells_cache.get(
                    (shell_lookup_user_id, shell_ref_name, shell_ref_namespace)
                )

                if shell:
                    shell_crd = Shell.model_validate(shell.json)
                    shell_type = shell_crd.spec.shellType
                    logger.debug(
                        f"[_convert_to_team_dict_with_cache] Found user shell: {shell_ref_name}, shell_type={shell_type}"
                    )
                else:
                    # If not found, check public shells in cache (by name only)
                    public_shell = public_shells_cache.get(shell_ref_name)
                    if public_shell and public_shell.json:
                        shell_crd = Shell.model_validate(public_shell.json)
                        shell_type = shell_crd.spec.shellType
                        logger.debug(
                            f"[_convert_to_team_dict_with_cache] Found public shell: {shell_ref_name}, shell_type={shell_type}"
                        )
                    else:
                        logger.warning(
                            f"[_convert_to_team_dict_with_cache] Shell not found in cache: user_id={shell_lookup_user_id}, name={shell_ref_name}, namespace={shell_ref_namespace}. "
                            f"public_shells_cache keys: {list(public_shells_cache.keys())}"
                        )

                if shell_type:
                    # Map shellType to agent type
                    if shell_type == "Agno":
                        agent_type = "agno"
                    elif shell_type == "ClaudeCode":
                        agent_type = "claude"
                    elif shell_type == "Dify":
                        agent_type = "dify"
                    elif shell_type == "Chat":
                        agent_type = "chat"
                    else:
                        agent_type = shell_type.lower() if shell_type else None
                    logger.debug(
                        f"[_convert_to_team_dict_with_cache] Mapped shell_type={shell_type} to agent_type={agent_type}"
                    )

        # Convert collaboration model to workflow format
        workflow = {"mode": team_crd.spec.collaborationModel}

        # Get bind_mode from spec (directly, not from workflow)
        bind_mode = team_crd.spec.bind_mode

        # Get description from spec
        description = team_crd.spec.description

        # Get icon from spec
        icon = team_crd.spec.icon

        return {
            "id": team.id,
            "user_id": team.user_id,
            "name": team.name,
            "namespace": team.namespace,
            "description": description,
            "bots": bots,
            "workflow": workflow,
            "bind_mode": bind_mode,
            "is_mix_team": is_mix_team,
            "is_active": team.is_active,
            "created_at": team.created_at,
            "updated_at": team.updated_at,
            "agent_type": agent_type,
            "icon": icon,
        }

    def _get_bot_summary_with_cache(
        self,
        bot: Kind,
        user_id: int,
        shells_cache: Dict,
        public_shells_cache: Dict,
        models_cache: Dict,
        public_models_cache: Dict,
    ) -> Dict[str, Any]:
        """
        Get a summary of bot information using preloaded cache.
        This is an optimized version that avoids database queries.
        """
        bot_crd = Bot.model_validate(bot.json)

        # modelRef is optional, handle None case
        model_ref_name = bot_crd.spec.modelRef.name if bot_crd.spec.modelRef else None
        model_ref_namespace = (
            bot_crd.spec.modelRef.namespace if bot_crd.spec.modelRef else None
        )

        # Get shell from cache to extract shell_type
        shell = shells_cache.get(
            (user_id, bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace)
        )
        if not shell:
            # Try public shells (by name only)
            shell = public_shells_cache.get(bot_crd.spec.shellRef.name)

        shell_type = ""
        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            shell_type = shell_crd.spec.shellType

        agent_config = {}

        # Only try to find model if modelRef exists
        if model_ref_name and model_ref_namespace:
            # Try to find model in user's private models cache first
            model = models_cache.get((user_id, model_ref_name, model_ref_namespace))

            if model:
                # Private model - check if it's a custom config or predefined model
                model_crd = Model.model_validate(model.json)
                is_custom_config = model_crd.spec.isCustomConfig

                if is_custom_config:
                    # Custom config - return full modelConfig with protocol for advanced mode
                    model_config = model_crd.spec.modelConfig or {}
                    protocol = model_crd.spec.protocol
                    agent_config = dict(model_config)
                    if protocol:
                        agent_config["protocol"] = protocol
                else:
                    # Not custom config = predefined model, return bind_model format with type
                    agent_config = {
                        "bind_model": model_ref_name,
                        "bind_model_type": "user",
                    }
            else:
                # Try to find in public_models cache (by name only)
                public_model = public_models_cache.get(model_ref_name)

                if public_model:
                    # Public model - return bind_model format with type
                    agent_config = {
                        "bind_model": public_model.name,
                        "bind_model_type": "public",
                    }

        return {"agent_config": agent_config, "shell_type": shell_type}

    def _get_bot_summary(self, bot: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Get a summary of bot information including agent_config with only necessary fields.
        This is used for team list to determine if bots have predefined models.
        """
        summary_start = time.time()

        bot_crd = Bot.model_validate(bot.json)

        # modelRef is optional, handle None case
        model_ref_name = bot_crd.spec.modelRef.name if bot_crd.spec.modelRef else None
        model_ref_namespace = (
            bot_crd.spec.modelRef.namespace if bot_crd.spec.modelRef else None
        )

        logger.debug(
            f"[_get_bot_summary] bot.name={bot.name}, modelRef.name={model_ref_name}, modelRef.namespace={model_ref_namespace}"
        )

        # Get shell to extract shell_type (kindReader handles public fallback automatically)
        t_shell = time.time()
        shell = kindReader.get_by_name_and_namespace(
            db,
            user_id,
            KindType.SHELL,
            bot_crd.spec.shellRef.namespace,
            bot_crd.spec.shellRef.name,
        )

        logger.info(
            f"[_get_bot_summary] Checking shell for bot={bot.name}, shellRef.name={bot_crd.spec.shellRef.name}, user_id={user_id}, found={shell is not None}"
        )

        shell_query_time = time.time() - t_shell

        shell_type = ""
        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            shell_type = shell_crd.spec.shellType
            logger.info(
                f"[_get_bot_summary] Got shell_type={shell_type} for bot={bot.name}"
            )
        else:
            logger.warning(
                f"[_get_bot_summary] No shell found for bot={bot.name}, shellRef.name={bot_crd.spec.shellRef.name}"
            )

        agent_config = {}

        # Only try to find model if modelRef exists
        t_model = time.time()
        if model_ref_name and model_ref_namespace:
            # Get model using kindReader (handles public fallback automatically)
            model = kindReader.get_by_name_and_namespace(
                db, user_id, KindType.MODEL, model_ref_namespace, model_ref_name
            )

            logger.debug(f"[_get_bot_summary] Model found: {model is not None}")

            if model:
                model_crd = Model.model_validate(model.json)
                is_custom_config = model_crd.spec.isCustomConfig
                # Determine if this is a user's private model or public model
                is_user_model = model.user_id == user_id

                logger.info(
                    f"[_get_bot_summary] Model isCustomConfig: {is_custom_config}, is_user_model: {is_user_model}"
                )

                if is_custom_config:
                    # Custom config - return full modelConfig with protocol for advanced mode
                    model_config = model_crd.spec.modelConfig or {}
                    protocol = model_crd.spec.protocol
                    agent_config = dict(model_config)
                    if protocol:
                        agent_config["protocol"] = protocol
                    logger.debug(
                        f"[_get_bot_summary] Custom config (isCustomConfig=True), returning full agent_config: {agent_config}"
                    )
                else:
                    # Not custom config = predefined model, return bind_model format with type
                    agent_config = {
                        "bind_model": model_ref_name,
                        "bind_model_type": "user" if is_user_model else "public",
                    }
                    logger.debug(
                        f"[_get_bot_summary] Predefined model (isCustomConfig=False), returning bind_model: {agent_config}"
                    )
            else:
                logger.debug(
                    f"[_get_bot_summary] No model found for modelRef.name={model_ref_name}, modelRef.namespace={model_ref_namespace}"
                )
        else:
            logger.debug(f"[_get_bot_summary] No modelRef for bot {bot.name}")

        model_query_time = time.time() - t_model

        result = {"agent_config": agent_config, "shell_type": shell_type}

        total_summary_time = time.time() - summary_start
        if total_summary_time > 0.05:
            logger.info(
                f"[_get_bot_summary] bot={bot.name}: shell_query={shell_query_time:.3f}s, model_query={model_query_time:.3f}s, total={total_summary_time:.3f}s"
            )

        logger.debug(f"[_get_bot_summary] Returning: {result}")
        return result

    def _convert_bot_to_dict(
        self, bot: Kind, db: Session, user_id: int
    ) -> Dict[str, Any]:
        """
        Convert kinds Bot to bot-like dictionary (simplified version)
        """
        bot_crd = Bot.model_validate(bot.json)

        # Get ghost
        ghost = kindReader.get_by_name_and_namespace(
            db,
            user_id,
            KindType.GHOST,
            bot_crd.spec.ghostRef.namespace,
            bot_crd.spec.ghostRef.name,
        )

        # Get shell (with public fallback)
        shell = kindReader.get_by_name_and_namespace(
            db,
            user_id,
            KindType.SHELL,
            bot_crd.spec.shellRef.namespace,
            bot_crd.spec.shellRef.name,
        )

        # Get model - modelRef is optional (with public fallback)
        model = None
        if bot_crd.spec.modelRef:
            model = kindReader.get_by_name_and_namespace(
                db,
                user_id,
                KindType.MODEL,
                bot_crd.spec.modelRef.namespace,
                bot_crd.spec.modelRef.name,
            )

        # Extract data from components
        system_prompt = ""
        mcp_servers = {}
        shell_type = ""
        agent_config = {}

        if ghost and ghost.json:
            ghost_crd = Ghost.model_validate(ghost.json)
            system_prompt = ghost_crd.spec.systemPrompt
            mcp_servers = ghost_crd.spec.mcpServers or {}

        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            shell_type = shell_crd.spec.shellType

        if model and model.json:
            model_crd = Model.model_validate(model.json)
            agent_config = model_crd.spec.modelConfig

        return {
            "id": bot.id,
            "user_id": bot.user_id,
            "name": bot.name,
            "shell_type": shell_type,
            "agent_config": agent_config,
            "system_prompt": system_prompt,
            "mcp_servers": mcp_servers,
            "is_active": bot.is_active,
            "created_at": bot.created_at,
            "updated_at": bot.updated_at,
        }

    def _update_team_references_in_tasks(
        self,
        db: Session,
        old_name: str,
        old_namespace: str,
        new_name: str,
        new_namespace: str,
        user_id: int,
    ) -> None:
        """
        Update all references to this team in tasks when team name/namespace changes
        """
        from app.models.task import TaskResource

        # Find all tasks that reference this team
        tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .all()
        )

        for task in tasks:
            task_crd = Task.model_validate(task.json)

            # Check if this task references the old team
            if (
                task_crd.spec.teamRef.name == old_name
                and task_crd.spec.teamRef.namespace == old_namespace
            ):
                # Update the reference
                task_crd.spec.teamRef.name = new_name
                task_crd.spec.teamRef.namespace = new_namespace

                # Save changes
                task.json = task_crd.model_dump(mode="json")
                task.updated_at = datetime.now()
                flag_modified(task, "json")

    def get_team_input_parameters(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get input parameters required by the team's external API bots
        Returns parameter schema if team has external API bots, otherwise empty
        """
        # Get team details
        team = kindReader.get_by_id(db, KindType.TEAM, team_id)

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Check if user has access to this team
        is_author = team.user_id == user_id
        shared_team = None

        if not is_author:
            shared_team = sharedTeamReader.get_by_team_and_user(db, team_id, user_id)
            if not shared_team:
                raise HTTPException(
                    status_code=403, detail="Access denied to this team"
                )

        # Get original user context
        original_user_id = team.user_id if is_author else shared_team.original_user_id
        team_dict = self._convert_to_team_dict(team, db, original_user_id)

        # Check if team has any external API bots (like Dify)
        has_external_api_bot = False
        external_api_bot = None

        for bot_info in team_dict["bots"]:
            bot_id = bot_info["bot_id"]
            bot = kindReader.get_by_id(db, KindType.BOT, bot_id)

            if bot:
                bot_crd = Bot.model_validate(bot.json)
                # Check if bot uses external API shell
                shell_name = bot_crd.spec.shellRef.name
                shell_namespace = bot_crd.spec.shellRef.namespace

                # Get shell using kindReader (handles public fallback)
                shell = kindReader.get_by_name_and_namespace(
                    db, original_user_id, KindType.SHELL, shell_namespace, shell_name
                )

                if shell:
                    # Use utility function to get shell type
                    shell_type = get_shell_type(
                        db, shell_name, shell_namespace, original_user_id
                    )

                    if shell_type == "external_api":
                        has_external_api_bot = True
                        external_api_bot = bot_crd
                        break

        if not has_external_api_bot:
            return {"has_parameters": False, "parameters": []}

        # Get bot's model to extract API credentials
        # modelRef is optional
        model_ref = external_api_bot.spec.modelRef
        if not model_ref:
            return {"has_parameters": False, "parameters": []}

        # Get model using kindReader (handles public fallback)
        model = kindReader.get_by_name_and_namespace(
            db, original_user_id, KindType.MODEL, model_ref.namespace, model_ref.name
        )

        if not model:
            return {"has_parameters": False, "parameters": []}

        model_crd = Model.model_validate(model.json)
        agent_config = model_crd.spec.modelConfig or {}

        # Decrypt sensitive data before using
        decrypted_agent_config = self._decrypt_agent_config(agent_config)
        env = decrypted_agent_config.get("env", {})

        # For Dify bots, we need to call Dify API to get parameters
        api_key = env.get("DIFY_API_KEY", "")
        base_url = env.get("DIFY_BASE_URL", "https://api.dify.ai")

        if not api_key:
            return {"has_parameters": False, "parameters": []}

        # Call external API to get parameter schema and app info
        try:
            import requests

            # Get app info to retrieve mode
            app_mode = None
            try:
                info_response = requests.get(
                    f"{base_url}/v1/info",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    timeout=10,
                )
                if info_response.status_code == 200:
                    info_data = info_response.json()
                    app_mode = info_data.get("mode")
            except Exception as e:
                logger.warning("Failed to fetch app info: %s", e)

            # Get app parameters
            response = requests.get(
                f"{base_url}/v1/parameters",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            if response.status_code == 200:
                data = response.json()
                user_input_form = data.get("user_input_form", [])

                # Transform Dify's nested format to flat format expected by frontend
                # Dify format: [{"text-input": {"variable": "x", ...}}, ...]
                # Frontend expects: [{"variable": "x", "type": "text-input", ...}, ...]
                transformed_params = []
                for item in user_input_form:
                    if isinstance(item, dict):
                        # Each item is like {"text-input": {...}} or {"select": {...}}
                        for param_type, param_data in item.items():
                            if isinstance(param_data, dict):
                                # Add type field and flatten
                                transformed_param = {**param_data, "type": param_type}
                                transformed_params.append(transformed_param)

                # has_parameters is true as long as the API request succeeds (external API bot exists)
                result = {"has_parameters": True, "parameters": transformed_params}

                # Add app_mode if available
                if app_mode:
                    result["app_mode"] = app_mode

                return result
            else:
                logger.warning(
                    "Dify API returned status %s: %s",
                    response.status_code,
                    response.text,
                )
                # has_parameters is true as long as external API bot exists, even if parameters API fails
                result = {"has_parameters": True, "parameters": []}
                if app_mode:
                    result["app_mode"] = app_mode
                return result
        except Exception as e:
            logger.warning(
                "Failed to fetch parameters from external API: %s", e, exc_info=True
            )
            # has_parameters is true as long as external API bot exists, even if API call fails
            return {"has_parameters": True, "parameters": []}


team_kinds_service = TeamKindsService(Kind)

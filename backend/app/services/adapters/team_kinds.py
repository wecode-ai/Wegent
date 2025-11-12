# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Dict, Any
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.models.shared_team import SharedTeam
from app.schemas.team import TeamCreate, TeamUpdate, TeamInDB, TeamDetail, BotInfo
from app.schemas.kind import Team, Bot, Ghost, Shell, Model, Task
from app.services.base import BaseService

class TeamKindsService(BaseService[Kind, TeamCreate, TeamUpdate]):
    """
    Team service class using kinds table
    """

    def create_with_user(
        self, db: Session, *, obj_in: TeamCreate, user_id: int
    ) -> Dict[str, Any]:
        """
        Create user Team using kinds table
        """
        # Check duplicate team name under the same user (only active teams)
        existing = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.name == obj_in.name,
            Kind.namespace == "default",
            Kind.is_active == True
        ).first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail="Team name already exists, please modify the name"
            )

        # Validate bots
        self._validate_bots(db, obj_in.bots, user_id)

        # Convert bots to members format
        members = []
        for bot_info in obj_in.bots:
            bot_id = bot_info.bot_id if hasattr(bot_info, 'bot_id') else bot_info['bot_id']
            bot_prompt = bot_info.bot_prompt if hasattr(bot_info, 'bot_prompt') else bot_info.get('bot_prompt', '')
            role = bot_info.role if hasattr(bot_info, 'role') else bot_info.get('role', '')
            
            # Get bot from kinds table
            bot = db.query(Kind).filter(
                Kind.id == bot_id,
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True
            ).first()
            
            if not bot:
                raise HTTPException(
                    status_code=400,
                    detail=f"Bot with id {bot_id} not found"
                )
            
            member = {
                "botRef": {
                    "name": bot.name,
                    "namespace": bot.namespace
                },
                "prompt": bot_prompt or "",
                "role": role or ""
            }
            members.append(member)

        # Extract collaboration model from workflow
        collaboration_model = "pipeline"
        if obj_in.workflow and "mode" in obj_in.workflow:
            collaboration_model = obj_in.workflow["mode"]

        # Create Team JSON
        team_json = {
            "kind": "Team",
            "spec": {
                "members": members,
                "collaborationModel": collaboration_model
            },
            "status": {
                "state": "Available"
            },
            "metadata": {
                "name": obj_in.name,
                "namespace": "default"
            },
            "apiVersion": "agent.wecode.io/v1"
        }
        
        team = Kind(
            user_id=user_id,
            kind="Team",
            name=obj_in.name,
            namespace="default",
            json=team_json,
            is_active=True
        )
        db.add(team)
        
        db.commit()
        db.refresh(team)
        
        return self._convert_to_team_dict(team, db, user_id)

    def get_user_teams(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's Team list (only active teams) including shared teams
        """
        result = []
        
        # Get user's own teams with pagination
        own_teams = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()
            
        # Get user info for team (single query)
        own_team_user = db.query(User).filter(User.id == user_id).first()
            
        for team in own_teams:
            team_dict = self._convert_to_team_dict(team, db, user_id)
            
            if own_team_user:
                team_dict["user"] = {
                    "id": own_team_user.id,
                    "user_name": own_team_user.user_name
                }
            
            team_crd = Team.model_validate(team.json)
            share_status = "0"  # Default to private
            
            if team_crd.metadata.labels and "share_status" in team_crd.metadata.labels:
                share_status = team_crd.metadata.labels["share_status"]
            
            team_dict["share_status"] = int(share_status)
            
            result.append(team_dict)
        
        # If we already have enough teams from own teams, return them
        if len(result) >= limit:
            return result[:limit]
        
        # Calculate how many more teams we need
        remaining_limit = limit - len(result)
        
        # Get joined teams only if we need more
        # Note: For shared teams, we don't apply skip again since we already applied it to own teams
        # and we want to get the most recent shared teams
        join_shared_teams = db.query(SharedTeam, Kind).join(
            Kind, SharedTeam.team_id == Kind.id
        ).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True,
            Kind.is_active == True,
            Kind.kind == "Team"
        ).order_by(SharedTeam.created_at.desc()).limit(remaining_limit).all()
        
        for shared_team, team in join_shared_teams:
            team_dict = self._convert_to_team_dict(team, db, shared_team.original_user_id)
            team_dict["share_status"] = 2 # shared from others
            
            # Get user info for team
            team_user = db.query(User).filter(User.id == team.user_id).first()
            if team_user:
                team_dict["user"] = {
                    "id": team_user.id,
                    "user_name": team_user.user_name
                }
            
            result.append(team_dict)
        
        # Sort by created_at desc
        result.sort(key=lambda x: x["created_at"], reverse=True)
        
        return result

    def get_by_id_and_user(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Team by ID and user ID (only active teams)
        """
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        return self._convert_to_team_dict(team, db, user_id)
        
    def get_team_detail(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed team information including related user and bots
        """
        # Check if user has access to this team (own or shared)
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        # Check if user is the owner or has shared access
        is_author = team.user_id == user_id
        shared_team = None
        
        if not is_author:
            # Check if user has shared access
            shared_team = db.query(SharedTeam).filter(
                SharedTeam.user_id == user_id,
                SharedTeam.team_id == team_id,
                SharedTeam.is_active == True
            ).first()
            if not shared_team:
                raise HTTPException(
                    status_code=403,
                    detail="Access denied to this team"
                )
        
        # Get team dict using the original user's context
        original_user_id = team.user_id if is_author else shared_team.original_user_id
        team_dict = self._convert_to_team_dict(team, db, original_user_id)
        
        # Get related user (original author)
        user = db.query(User).filter(User.id == original_user_id).first()
        
        # Get detailed bot information
        detailed_bots = []
        for bot_info in team_dict["bots"]:
            bot_id = bot_info["bot_id"]
            # Get bot from kinds table using original user context
            bot = db.query(Kind).filter(
                Kind.id == bot_id,
                Kind.user_id == original_user_id,
                Kind.kind == "Bot",
                Kind.is_active == True
            ).first()
            
            if bot:
                bot_dict = self._convert_bot_to_dict(bot, db, original_user_id)
                detailed_bots.append({
                    "bot": bot_dict,
                    "bot_prompt": bot_info.get("bot_prompt"),
                    "role": bot_info.get("role")
                })
        
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
        Update user Team
        """
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness under the same user (only active teams), excluding current team
        if "name" in update_data:
            new_name = update_data["name"]
            if new_name != team.name:
                conflict = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.name == new_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                    Kind.id != team.id
                ).first()
                if conflict:
                    raise HTTPException(
                        status_code=400,
                        detail="Team name already exists, please modify the name"
                    )

        # Update team based on update_data
        team_crd = Team.model_validate(team.json)
        
        if "name" in update_data:
            new_name = update_data["name"]
            old_name = team.name
            team.name = new_name
            team_crd.metadata.name = new_name
            
            # Update all references to this team in tasks
            self._update_team_references_in_tasks(db, old_name, "default", new_name, "default", user_id)

        if "bots" in update_data:
            # Validate bots
            self._validate_bots(db, update_data["bots"], user_id)
            
            # Convert bots to members format
            from app.schemas.kind import TeamMember, BotTeamRef
            members = []
            for bot_info in update_data["bots"]:
                bot_id = bot_info.bot_id if hasattr(bot_info, 'bot_id') else bot_info['bot_id']
                bot_prompt = bot_info.bot_prompt if hasattr(bot_info, 'bot_prompt') else bot_info.get('bot_prompt', '')
                role = bot_info.role if hasattr(bot_info, 'role') else bot_info.get('role', '')
                
                # Get bot from kinds table
                bot = db.query(Kind).filter(
                    Kind.id == bot_id,
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.is_active == True
                ).first()
                
                if not bot:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Bot with id {bot_id} not found"
                    )
                
                member = TeamMember(
                    botRef=BotTeamRef(name=bot.name, namespace=bot.namespace),
                    prompt=bot_prompt or "",
                    role=role or ""
                )
                members.append(member)
            
            team_crd.spec.members = members

        if "workflow" in update_data:
            # Extract collaboration model from workflow
            collaboration_model = "pipeline"
            if update_data["workflow"] and "mode" in update_data["workflow"]:
                collaboration_model = update_data["workflow"]["mode"]
            
            team_crd.spec.collaborationModel = collaboration_model

        # Save the updated team CRD
        team.json = team_crd.model_dump(mode='json')
        team.updated_at = datetime.now()
        flag_modified(team, "json")
        
        db.commit()
        db.refresh(team)
        
        return self._convert_to_team_dict(team, db, user_id)

    def delete_with_user(
        self, db: Session, *, team_id: int, user_id: int
    ) -> None:
        """
        Delete user Team
        """
        team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()

        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )

        # delete join shared team entry if any
        if team.user_id != user_id:
            db.query(SharedTeam).filter(
                SharedTeam.team_id == team_id,
                SharedTeam.user_id == user_id,
                SharedTeam.is_active == True
            ).delete()
            db.commit()
            return     
            
        # Check if team is referenced in any PENDING or RUNNING task
        tasks = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).all()
        
        team_name = team.name
        team_namespace = team.namespace
        
        # Check if any task references this team with status PENDING or RUNNING
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            if (task_crd.spec.teamRef.name == team_name and
                task_crd.spec.teamRef.namespace == team_namespace):
                if task_crd.status and task_crd.status.status in ["PENDING", "RUNNING"]:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Team '{team_name}' is being used in a {task_crd.status.status} task. Please wait for task completion or cancel it first."
                    )
                
        # delete share team
        db.query(SharedTeam).filter(
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).delete()
        
        db.delete(team)
        db.commit()

    def count_user_teams(self, db: Session, *, user_id: int) -> int:
        """
        Count user's active teams including shared teams
        """
        # Count user's own teams
        own_teams_count = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).count()
        
        # Count shared teams
        shared_teams_count = db.query(SharedTeam).join(
            Kind, SharedTeam.team_id == Kind.id
        ).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True,
            Kind.is_active == True,
            Kind.kind == "Team"
        ).count()
        
        return own_teams_count + shared_teams_count

    def _validate_bots(self, db: Session, bots: List[BotInfo], user_id: int) -> None:
        """
        Validate bots and check if bots belong to user and are active
        """
        if not bots:
            raise HTTPException(
                status_code=400,
                detail="bots cannot be empty"
            )
        
        bot_id_list = []
        for bot in bots:
            if hasattr(bot, 'bot_id'):
                bot_id_list.append(bot.bot_id)
            elif isinstance(bot, dict) and 'bot_id' in bot:
                bot_id_list.append(bot['bot_id'])
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid bot format: missing bot_id"
                )
        
        # Check if all bots exist, belong to user, and are active in kinds table
        bots_in_db = db.query(Kind).filter(
            Kind.id.in_(bot_id_list),
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).all()
        
        found_bot_ids = {bot.id for bot in bots_in_db}
        missing_bot_ids = set(bot_id_list) - found_bot_ids
        
        if missing_bot_ids:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid or inactive bot_ids: {', '.join(map(str, missing_bot_ids))}"
            )
        
    def get_team_by_id(self, db: Session, *, team_id: int, user_id: int) -> Optional[Kind]:
        """
        Get team by id, checking both user's own teams and shared teams
        """
        # First check if team exists and belongs to user
        existing_team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if existing_team:
            return existing_team
        
        # If not found, check if team exists in shared teams
        shared_team = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).first()
        
        if shared_team:
            # Return shared team
            return db.query(Kind).filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active == True
            ).first()
        
        return None
        
    def get_team_by_id_or_name_and_namespace(self, db: Session, *, team_id: Optional[int] = None,
                                           team_name: Optional[str] = None,
                                           team_namespace: Optional[str] = None,
                                           user_id: int) -> Optional[Kind]:
        """
        Get team by id or by name and namespace, checking both user's own teams and shared teams
        
        If team_id is provided, search by id
        If team_id is None, search by team_name and team_namespace
        """
        # If team_id is provided, search by id
        if team_id is not None:
            return self.get_team_by_id(db, team_id=team_id, user_id=user_id)
        # If team_id is None, search by name and namespace
        elif team_name is not None and team_namespace is not None:
            return self.get_team_by_name_and_namespace(db, team_name, team_namespace, user_id)
        
        return None
    
    def get_team_by_name_and_namespace(self, db: Session, team_name: str, team_namespace: str, user_id: int) -> Optional[Kind]:
        existing_team = db.query(Kind).filter(
            Kind.name == team_name,
            Kind.namespace == team_namespace,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()

        if existing_team:
            return existing_team

        join_share_teams = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True
        ).all()

        for join_team in join_share_teams:
            team = db.query(Kind).filter(
                Kind.name == team_name,
                Kind.namespace == team_namespace,
                Kind.user_id == join_team.original_user_id,
                Kind.kind == "Team",
                Kind.is_active == True
            ).first()
            if team:
                return team

        return None
        
    def _convert_to_team_dict(self, team: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary
        """
        team_crd = Team.model_validate(team.json)
        
        # Convert members to bots format
        bots = []
        for member in team_crd.spec.members:
            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True
            ).first()
            
            if bot:
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.prompt or "",
                    "role": member.role or ""
                }
                bots.append(bot_info)
        
        # Convert collaboration model to workflow format
        workflow = {"mode": team_crd.spec.collaborationModel}
        
        return {
            "id": team.id,
            "user_id": team.user_id,
            "name": team.name,
            "bots": bots,
            "workflow": workflow,
            "is_active": team.is_active,
            "created_at": team.created_at,
            "updated_at": team.updated_at,
        }

    def _convert_bot_to_dict(self, bot: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Bot to bot-like dictionary (simplified version)
        """
        bot_crd = Bot.model_validate(bot.json)
        
        # Get ghost
        ghost = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Ghost",
            Kind.name == bot_crd.spec.ghostRef.name,
            Kind.namespace == bot_crd.spec.ghostRef.namespace,
            Kind.is_active == True
        ).first()
        
        # Get shell
        shell = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == bot_crd.spec.shellRef.name,
            Kind.namespace == bot_crd.spec.shellRef.namespace,
            Kind.is_active == True
        ).first()
        
        # Get model
        model = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Model",
            Kind.name == bot_crd.spec.modelRef.name,
            Kind.namespace == bot_crd.spec.modelRef.namespace,
            Kind.is_active == True
        ).first()
        
        # Extract data from components
        system_prompt = ""
        mcp_servers = {}
        agent_name = ""
        agent_config = {}
        
        if ghost and ghost.json:
            ghost_crd = Ghost.model_validate(ghost.json)
            system_prompt = ghost_crd.spec.systemPrompt
            mcp_servers = ghost_crd.spec.mcpServers or {}
        
        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            agent_name = shell_crd.spec.runtime
        
        if model and model.json:
            model_crd = Model.model_validate(model.json)
            agent_config = model_crd.spec.modelConfig
        
        return {
            "id": bot.id,
            "user_id": bot.user_id,
            "name": bot.name,
            "agent_name": agent_name,
            "agent_config": agent_config,
            "system_prompt": system_prompt,
            "mcp_servers": mcp_servers,
            "is_active": bot.is_active,
            "created_at": bot.created_at,
            "updated_at": bot.updated_at,
        }

    def _update_team_references_in_tasks(self, db: Session, old_name: str, old_namespace: str,
                                        new_name: str, new_namespace: str, user_id: int) -> None:
        """
        Update all references to this team in tasks when team name/namespace changes
        """
        # Find all tasks that reference this team
        tasks = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).all()
        
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            
            # Check if this task references the old team
            if (task_crd.spec.teamRef.name == old_name and
                task_crd.spec.teamRef.namespace == old_namespace):
                # Update the reference
                task_crd.spec.teamRef.name = new_name
                task_crd.spec.teamRef.namespace = new_namespace
                
                # Save changes
                task.json = task_crd.model_dump(mode='json')
                task.updated_at = datetime.now()
                flag_modified(task, "json")


team_kinds_service = TeamKindsService(Kind)
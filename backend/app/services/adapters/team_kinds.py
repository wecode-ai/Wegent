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
from app.schemas.team import TeamCreate, TeamUpdate, TeamInDB, TeamDetail, BotInfo
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
        Get user's Team list (only active teams)
        """
        teams = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()
        
        result = []
        for team in teams:
            result.append(self._convert_to_team_dict(team, db, user_id))
        
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
        team_dict = self.get_by_id_and_user(db, team_id=team_id, user_id=user_id)
        
        # Get related user
        user = db.query(User).filter(User.id == user_id).first()
        
        # Get detailed bot information
        detailed_bots = []
        for bot_info in team_dict["bots"]:
            bot_id = bot_info["bot_id"]
            # Get bot from kinds table
            bot = db.query(Kind).filter(
                Kind.id == bot_id,
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True
            ).first()
            
            if bot:
                bot_dict = self._convert_bot_to_dict(bot, db, user_id)
                detailed_bots.append({
                    "bot": bot_dict,
                    "bot_prompt": bot_info.get("bot_prompt"),
                    "role": bot_info.get("role")
                })
        
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
        team_json = team.json
        
        if "name" in update_data:
            new_name = update_data["name"]
            old_name = team.name
            team.name = new_name
            team_json["metadata"]["name"] = new_name
            flag_modified(team, "json")
            
            # Update all references to this team in tasks
            self._update_team_references_in_tasks(db, old_name, "default", new_name, "default", user_id)

        if "bots" in update_data:
            # Validate bots
            self._validate_bots(db, update_data["bots"], user_id)
            
            # Convert bots to members format
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
                member = {
                    "botRef": {
                        "name": bot.name,
                        "namespace": bot.namespace
                    },
                    "prompt": bot_prompt or "",
                    "role": role or ""
                }
                members.append(member)
            
            team_json["spec"]["members"] = members
            flag_modified(team, "json")

        if "workflow" in update_data:
            # Extract collaboration model from workflow
            collaboration_model = "pipeline"
            if update_data["workflow"] and "mode" in update_data["workflow"]:
                collaboration_model = update_data["workflow"]["mode"]
            
            team_json["spec"]["collaborationModel"] = collaboration_model
            flag_modified(team, "json")

        # Update timestamps
        team.updated_at = datetime.utcnow()
        
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
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        # For now, just set is_active to False (soft delete)
        # team.is_active = False
        # team.updated_at = datetime.utcnow()
        db.delete(team)
        
        db.commit()

    def count_user_teams(self, db: Session, *, user_id: int) -> int:
        """
        Count user's active teams
        """
        return db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).count()

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

    def _convert_to_team_dict(self, team: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary
        """
        # Extract data from team JSON
        team_spec = team.json.get("spec", {})
        members = team_spec.get("members", [])
        collaboration_model = team_spec.get("collaborationModel", {})
        
        # Convert members to bots format
        bots = []
        for member in members:
            bot_ref = member.get("botRef", {})
            bot_name = bot_ref.get("name")
            bot_namespace = bot_ref.get("namespace", "default")
            
            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active == True
            ).first()
            
            if bot:
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.get("prompt", ""),
                    "role": member.get("role", "")
                }
                bots.append(bot_info)
        # Convert collaboration model to workflow format
        workflow = {}
        if collaboration_model:
            if isinstance(collaboration_model, str):
                workflow["mode"] = collaboration_model
            else:
                # Handle legacy format for backward compatibility
                workflow["mode"] = collaboration_model.get("name", "pipeline")
                if "config" in collaboration_model:
                    workflow.update(collaboration_model["config"])
        
        return {
            "id": team.id,
            "user_id": team.user_id,
            "k_id": team.id,  # For compatibility
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
        # Extract data from bot JSON
        bot_spec = bot.json.get("spec", {})
        
        # Get referenced components
        ghost_ref = bot_spec.get("ghostRef", {})
        shell_ref = bot_spec.get("shellRef", {})
        model_ref = bot_spec.get("modelRef", {})
        
        # Get ghost
        ghost = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Ghost",
            Kind.name == ghost_ref.get("name"),
            Kind.namespace == ghost_ref.get("namespace", "default"),
            Kind.is_active == True
        ).first()
        
        # Get shell
        shell = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_ref.get("name"),
            Kind.namespace == shell_ref.get("namespace", "default"),
            Kind.is_active == True
        ).first()
        
        # Get model
        model = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Model",
            Kind.name == model_ref.get("name"),
            Kind.namespace == model_ref.get("namespace", "default"),
            Kind.is_active == True
        ).first()
        
        # Extract data from components
        system_prompt = ""
        mcp_servers = {}
        agent_name = ""
        agent_config = {}
        
        if ghost and ghost.json:
            ghost_spec = ghost.json.get("spec", {})
            system_prompt = ghost_spec.get("systemPrompt", "")
            mcp_servers = ghost_spec.get("mcpServers", {})
        
        if shell and shell.json:
            shell_spec = shell.json.get("spec", {})
            agent_name = shell_spec.get("runtime", "")
        
        if model and model.json:
            model_spec = model.json.get("spec", {})
            agent_config = model_spec.get("modelConfig", {})
        
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
            task_json = task.json
            task_spec = task_json.get("spec", {})
            team_ref = task_spec.get("teamRef", {})
            
            # Check if this task references the old team
            if (team_ref.get("name") == old_name and
                team_ref.get("namespace", "default") == old_namespace):
                # Update the reference
                team_ref["name"] = new_name
                team_ref["namespace"] = new_namespace
                
                # Save changes
                task.json = task_json
                task.updated_at = datetime.utcnow()
                flag_modified(task, "json")


team_kinds_service = TeamKindsService(Kind)
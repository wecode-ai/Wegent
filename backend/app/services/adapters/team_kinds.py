# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Dict, Any
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import union_all, literal_column

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
        Uses database union query for better performance and pagination
        """
        # Query for user's own teams
        own_teams_query = db.query(
            Kind.id.label('team_id'),
            Kind.user_id.label('team_user_id'),
            Kind.name.label('team_name'),
            Kind.namespace.label('team_namespace'),
            Kind.json.label('team_json'),
            Kind.created_at.label('team_created_at'),
            Kind.updated_at.label('team_updated_at'),
            literal_column('0').label('share_status'),  # Default 0 for own teams
            literal_column(str(user_id)).label('context_user_id')  # Use current user for context
        ).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        )
        
        # Query for shared teams
        shared_teams_query = db.query(
            Kind.id.label('team_id'),
            Kind.user_id.label('team_user_id'),
            Kind.name.label('team_name'),
            Kind.namespace.label('team_namespace'),
            Kind.json.label('team_json'),
            Kind.created_at.label('team_created_at'),
            Kind.updated_at.label('team_updated_at'),
            literal_column('2').label('share_status'),  # 2 for shared teams
            SharedTeam.original_user_id.label('context_user_id')  # Use original user for context
        ).join(
            SharedTeam, SharedTeam.team_id == Kind.id
        ).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True,
            Kind.is_active == True,
            Kind.kind == "Team"
        )
        
        # Combine queries using union all
        combined_query = union_all(own_teams_query, shared_teams_query).alias('combined_teams')
        
        # Create final query with pagination
        final_query = db.query(
            combined_query.c.team_id,
            combined_query.c.team_user_id,
            combined_query.c.team_name,
            combined_query.c.team_namespace,
            combined_query.c.team_json,
            combined_query.c.team_created_at,
            combined_query.c.team_updated_at,
            combined_query.c.share_status,
            combined_query.c.context_user_id
        ).order_by(
            combined_query.c.team_created_at.desc()
        ).offset(skip).limit(limit)
        
        # Execute the query
        teams_data = final_query.all()
        
        # Get all unique user IDs for batch fetching user info
        user_ids = set()
        for team_data in teams_data:
            user_ids.add(team_data.team_user_id)
        
        # Batch fetch user info
        users_info = {}
        if user_ids:
            users = db.query(User).filter(User.id.in_(user_ids)).all()
            users_info = {user.id: user for user in users}
        
        # Convert to result format
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
                is_active=True
            )
            
            # Convert to team dict using the appropriate context user ID
            team_dict = self._convert_to_team_dict(temp_team, db, team_data.context_user_id)
            
            # For own teams, check if share_status is set in metadata.labels
            if team_data.share_status == 0:  # This is an own team
                team_crd = Team.model_validate(team_data.team_json)
                if team_crd.metadata.labels and "share_status" in team_crd.metadata.labels:
                    team_dict["share_status"] = int(team_crd.metadata.labels["share_status"])
            else:  # This is a shared team
                team_dict["share_status"] = 2
            
            # Add user info
            team_user = users_info.get(team_data.team_user_id)
            if team_user:
                team_dict["user"] = {
                    "id": team_user.id,
                    "user_name": team_user.user_name
                }
            
            result.append(team_dict)
        
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
        Also validates Dify runtime constraint: Dify Teams must have exactly one bot
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

        # Validate external API shell constraint: must have exactly one bot
        for bot in bots_in_db:
            bot_crd = Bot.model_validate(bot.json)

            # Get shell to check shell type
            shell = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True
            ).first()

            if shell:
                shell_crd = Shell.model_validate(shell.json)
                # Check if shell is external API type
                shell_type = shell_crd.spec.shellType if hasattr(shell_crd.spec, 'shellType') else shell_crd.spec.get("shellType", "local_engine")

                if shell_type == "external_api":
                    # External API shells (like Dify) can only have one bot per team
                    if len(bots) > 1:
                        raise HTTPException(
                            status_code=400,
                            detail=f"Teams using external API shells ({shell_crd.spec.runtime}) must have exactly one bot. Found {len(bots)} bots."
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

    def get_team_input_parameters(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get input parameters required by the team's external API bots
        Returns parameter schema if team has external API bots, otherwise empty
        """
        # Get team details
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

        # Check if user has access to this team
        is_author = team.user_id == user_id
        shared_team = None

        if not is_author:
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

        # Get original user context
        original_user_id = team.user_id if is_author else shared_team.original_user_id
        team_dict = self._convert_to_team_dict(team, db, original_user_id)

        # Check if team has any external API bots (like Dify)
        has_external_api_bot = False
        external_api_bot = None

        for bot_info in team_dict["bots"]:
            bot_id = bot_info["bot_id"]
            bot = db.query(Kind).filter(
                Kind.id == bot_id,
                Kind.user_id == original_user_id,
                Kind.kind == "Bot",
                Kind.is_active == True
            ).first()

            if bot:
                bot_crd = Bot.model_validate(bot.json)
                # Check if bot uses external API shell (not AgnoShell or ClaudeCodeShell)
                shell_name = bot_crd.spec.shellRef.name
                shell = db.query(Kind).filter(
                    Kind.name == shell_name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace,
                    Kind.user_id == original_user_id,
                    Kind.kind == "Shell",
                    Kind.is_active == True
                ).first()

                if shell:
                    shell_crd = Shell.model_validate(shell.json)
                    # Check shell type label
                    shell_type = shell_crd.metadata.labels.get("type", "local_engine")
                    if shell_type == "external_api":
                        has_external_api_bot = True
                        external_api_bot = bot_crd
                        break

        if not has_external_api_bot:
            return {
                "has_parameters": False,
                "parameters": []
            }

        # Get bot's agent config to extract API credentials
        bot_spec = external_api_bot.spec
        agent_config = bot_spec.agentConfig or {}
        env = agent_config.get("env", {})

        # For Dify bots, we need to call Dify API to get parameters
        # But we do this server-side, not exposing Dify-specific logic to frontend
        api_key = env.get("DIFY_API_KEY", "")
        base_url = env.get("DIFY_BASE_URL", "https://api.dify.ai")

        if not api_key:
            return {
                "has_parameters": False,
                "parameters": []
            }

        # Call external API to get parameter schema
        try:
            import requests

            # Get app parameters
            response = requests.get(
                f"{base_url}/v1/parameters",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                timeout=10
            )

            if response.status_code == 200:
                data = response.json()
                user_input_form = data.get("user_input_form", [])

                return {
                    "has_parameters": len(user_input_form) > 0,
                    "parameters": user_input_form
                }
            else:
                return {
                    "has_parameters": False,
                    "parameters": []
                }
        except Exception as e:
            print(f"Failed to fetch parameters from external API: {e}")
            return {
                "has_parameters": False,
                "parameters": []
            }


team_kinds_service = TeamKindsService(Kind)

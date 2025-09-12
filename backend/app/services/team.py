# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Optional
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.team import Team
from app.models.bot import Bot
from app.models.user import User
from app.models.subtask import Subtask, SubtaskStatus
from app.models.kind import Kind
from app.schemas.team import TeamCreate, TeamUpdate, TeamInDB, TeamDetail, BotInfo
from app.services.base import BaseService


class TeamService(BaseService[Team, TeamCreate, TeamUpdate]):
    """
    Team service class
    """

    def create_with_user(
        self, db: Session, *, obj_in: TeamCreate, user_id: int
    ) -> Team:
        """
        Create user Team
        """
        # Validate bots
        self._validate_bots(db, obj_in.bots, user_id)
        bot_list = []
        for bot in obj_in.bots:
            if hasattr(bot, 'model_dump'):
                bot_list.append(bot.model_dump())
            elif isinstance(bot, dict):
                bot_list.append(bot)
            else:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid bot format"
                )
                
        db_obj = Team(
            user_id=user_id,
            name=obj_in.name,
            bots=bot_list,
            workflow=obj_in.workflow,
            is_active=True
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def get_user_teams(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Team]:
        """
        Get user's Team list (only active teams)
        """
        return db.query(Team).filter(
            Team.user_id == user_id,
            Team.is_active == True
        ).order_by(Team.created_at.desc()).offset(skip).limit(limit).all()

    def get_by_id_and_user(
        self, db: Session, *, team_id: int, user_id: int
    ) -> Optional[Team]:
        """
        Get Team by ID and user ID (only active teams)
        """
        team = db.query(Team).filter(
            Team.id == team_id,
            Team.user_id == user_id,
            Team.is_active == True
        ).first()
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        return team
        
    def get_team_detail(
        self, db: Session, *, team_id: int, user_id: int
    ) -> dict:
        """
        Get detailed team information including related entities
        """
        # Get the basic team
        team = self.get_by_id_and_user(db, team_id=team_id, user_id=user_id)
        
        # Get related user
        user = db.query(User).filter(User.id == team.user_id).first()
        # Get related bots
        try:
            bot_id_list = [bot['bot_id'] for bot in team.bots]
            bot_objects = db.query(Bot).filter(
                Bot.id.in_(bot_id_list),
                Bot.is_active == True
            ).all()
            
            # Create a mapping of bot_id to bot object for easy lookup
            bot_map = {bot.id: bot for bot in bot_objects}
            
            # Create the new bots structure with bot objects
            detailed_bots = []
            for bot_info in team.bots:
                bot_id = bot_info['bot_id']
                if bot_id in bot_map:
                    detailed_bots.append({
                        "bot": bot_map[bot_id],
                        "bot_prompt": bot_info.get('bot_prompt')
                    })
        except ValueError:
            detailed_bots = []
        
        # Convert to dict to allow adding related entities
        team_dict = {
            # Team base fields
            "id": team.id,
            "name": team.name,
            "bots": detailed_bots,
            "workflow": team.workflow,
            "is_active": team.is_active,
            "created_at": team.created_at,
            "updated_at": team.updated_at,
            
            # Related entities
            "user": user
        }
        
        return team_dict

    def update_with_user(
        self, db: Session, *, team_id: int, obj_in: TeamUpdate, user_id: int
    ) -> Team:
        """
        Update user Team
        """
        team = self.get_by_id_and_user(db, team_id=team_id, user_id=user_id)
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        update_data = obj_in.model_dump(exclude_unset=True)
        # Validate bots if provided
        if 'bots' in update_data:
            self._validate_bots(db, update_data['bots'], user_id)
        
        # Store old bots for comparison if we're updating bots
        old_bots = None
        if 'bots' in update_data:
            old_bots = {bot['bot_id']: bot for bot in team.bots} if team.bots else {}
        
        for field, value in update_data.items():
            if field == 'bots':
                bot_list = []
                for bot in value:
                    if hasattr(bot, 'model_dump'):
                        bot_list.append(bot.model_dump())
                    elif isinstance(bot, dict):
                        bot_list.append(bot)
                    else:
                        raise HTTPException(
                            status_code=400,
                            detail="Invalid bot format"
                        )
                setattr(team, field, value)
            else:
                setattr(team, field, value)
        
        db.add(team)
        
        # Update related subtasks if bots were modified
        if old_bots is not None:
            new_bots = {bot['bot_id']: bot for bot in team.bots} if team.bots else {}
            
            # For each bot that was updated
            for bot_id, new_bot in new_bots.items():
                # If this is an existing bot and the prompt changed
                if bot_id in old_bots and 'bot_prompt' in new_bot and old_bots[bot_id].get('bot_prompt') != new_bot['bot_prompt']:
                    # Update pending subtasks with the new prompt
                    pending_subtasks = db.query(Subtask).filter(
                        Subtask.user_id == user_id,
                        Subtask.team_id == team.id,
                        Subtask.bot_id == bot_id,
                        Subtask.status == SubtaskStatus.PENDING
                    ).all()
                    
                    for subtask in pending_subtasks:
                        subtask.prompt = new_bot['bot_prompt']
                        db.add(subtask)
        
        db.commit()
        db.refresh(team)
        return team

    def delete_with_user(
        self, db: Session, *, team_id: int, user_id: int
    ) -> None:
        """
        Soft delete user Team (set is_active to False)
        """
        team = self.get_by_id_and_user(db, team_id=team_id, user_id=user_id)
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
            )
        
        team.is_active = False
        db.add(team)
        db.commit()

    def _validate_bots(self, db: Session, bots: List[BotInfo], user_id: int) -> None:
        """
        Validate bots JSON array format and check if bots belong to user and are active
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
        
        # Check if all bots exist, belong to user, and are active
        bots_in_db = db.query(Bot).filter(
            Bot.id.in_(bot_id_list),
            Bot.user_id == user_id,
            Bot.is_active == True
        ).all()
        
        found_bot_ids = {bot.id for bot in bots_in_db}
        missing_bot_ids = set(bot_id_list) - found_bot_ids
        
        if missing_bot_ids:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid or inactive bot_ids: {', '.join(map(str, missing_bot_ids))}"
            )

    def create_or_update_by_k_team_id(
        self, db: Session, *, k_team_id: int, user_id: int
    ) -> Team:
        """
        Create or update team based on k_team id
        """
        # Get k_team from Kind table
        k_team = db.query(Kind).filter(
            Kind.id == k_team_id,
            Kind.user_id == user_id,
            Kind.kind == 'Team',
            Kind.is_active == True
        ).first()
        
        if not k_team:
            raise HTTPException(
                status_code=404,
                detail="Team not found in Kind table"
            )
        
        # Get all k_bots referenced in members
        member_bots = []
        workflow_order = []
        
        # Extract member information and workflow order
        k_team_json = k_team.json
        members = k_team_json.get('spec', {}).get('members', [])
        collaboration_model = k_team_json.get('spec', {}).get('collaborationModel', {})
        
        # Build workflow order from collaboration model
        if collaboration_model.get('name') == 'sequential':
            workflow = collaboration_model.get('config', {}).get('workflow', [])
            workflow_order = [step.get('step') for step in workflow if step.get('step')]
        
        # Process members to build bots array
        bots_array = []
        for member in members:
            if 'botRef' in member:
                bot_ref = member['botRef']
                bot_namespace = bot_ref.get('namespace', 'default')
                bot_name = bot_ref['name']
                
                # Find the corresponding bot in Kind table
                k_bot = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == 'Bot',
                    Kind.name == bot_name,
                    Kind.namespace == bot_namespace,
                    Kind.is_active == True
                ).first()
                
                if k_bot:
                    # Find the actual bot in legacy system
                    bot = db.query(Bot).filter(
                        Bot.user_id == user_id,
                        Bot.name == k_bot.name,
                        Bot.is_active == True
                    ).first()
                    
                    if bot:
                        # Determine position based on workflow order
                        member_name = member.get('name', '')
                        try:
                            position = workflow_order.index(member_name) if member_name in workflow_order else len(bots_array)
                        except ValueError:
                            position = len(bots_array)
                        
                        bot_info = {
                            'bot_id': bot.id,
                            'bot_prompt': member.get('prompt', '')
                        }
                        
                        # Insert at correct position to maintain workflow order
                        if position < len(bots_array):
                            bots_array.insert(position, bot_info)
                        else:
                            bots_array.append(bot_info)
        
        # Check if team already exists for this k_team using k_id
        team = db.query(Team).filter(
            Team.k_id == k_team_id,
            Team.user_id == user_id,
            Team.is_active == True
        ).first()
        
        if team:
            # Update existing team
            team.name = k_team_json.get('metadata', {}).get('name', '')
            team.bots = bots_array
            team.updated_at = datetime.utcnow()
        else:
            # Create new team
            team = Team(
                user_id=user_id,
                k_id=k_team_id,
                name=k_team_json.get('metadata', {}).get('name', ''),
                bots=bots_array,
                is_active=True
            )
            db.add(team)
        
        db.commit()
        db.refresh(team)
        return team


team_service = TeamService(Team)
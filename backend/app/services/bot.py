# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.bot import Bot
from app.models.user import User
from app.models.kind import KBot, KGhost, KShell, KModel
from app.schemas.bot import BotCreate, BotUpdate, BotInDB, BotDetail
from app.services.base import BaseService


class BotService(BaseService[Bot, BotCreate, BotUpdate]):
    """
    Bot service class
    """

    def create_with_user(
        self, db: Session, *, obj_in: BotCreate, user_id: int
    ) -> Bot:
        """
        Create user Bot
        """
        db_obj = Bot(
            user_id=user_id,
            name=obj_in.name,
            agent_name=obj_in.agent_name,
            agent_config=obj_in.agent_config,
            system_prompt=obj_in.system_prompt,
            mcp_servers=obj_in.mcp_servers,
            is_active=True
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def get_user_bots(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Bot]:
        """
        Get user's Bot list (only active bots)
        """
        return db.query(Bot).filter(
            Bot.user_id == user_id,
            Bot.is_active == True
        ).order_by(Bot.created_at.desc()).offset(skip).limit(limit).all()

    def get_by_id_and_user(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> Optional[Bot]:
        """
        Get Bot by ID and user ID (only active bots)
        """
        bot = db.query(Bot).filter(
            Bot.id == bot_id,
            Bot.user_id == user_id,
            Bot.is_active == True
        ).first()
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        return bot
        
    def get_bot_detail(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> dict:
        """
        Get detailed bot information including related user
        """
        # Get the basic bot
        bot = self.get_by_id_and_user(db, bot_id=bot_id, user_id=user_id)
        
        # Get related user
        user = db.query(User).filter(User.id == bot.user_id).first()
        
        # Convert to dict to allow adding related entities
        bot_dict = {
            # Bot base fields
            "id": bot.id,
            "name": bot.name,
            "agent_name": bot.agent_name,
            "agent_config": bot.agent_config,
            "system_prompt": bot.system_prompt,
            "mcp_servers": bot.mcp_servers,
            "is_active": bot.is_active,
            "created_at": bot.created_at,
            "updated_at": bot.updated_at,
            
            # Related entities
            "user": user
        }
        
        return bot_dict

    def update_with_user(
        self, db: Session, *, bot_id: int, obj_in: BotUpdate, user_id: int
    ) -> Bot:
        """
        Update user Bot
        """
        bot = self.get_by_id_and_user(db, bot_id=bot_id, user_id=user_id)
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        
        update_data = obj_in.model_dump(exclude_unset=True)
        
        for field, value in update_data.items():
            setattr(bot, field, value)
        
        db.add(bot)
        db.commit()
        db.refresh(bot)
        return bot

    def delete_with_user(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> None:
        """
        Delete user Bot or soft delete if used in teams
        """
        from app.models.team import Team
        
        bot = self.get_by_id_and_user(db, bot_id=bot_id, user_id=user_id)
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        
        # Get all active teams for user
        user_teams = db.query(Team).filter(
            Team.user_id == user_id,
            Team.is_active == True
        ).all()
        
        # Check if bot is used in any team
        teams_with_bot = []
        for team in user_teams:
            for bot_info in team.bots:
                if bot_info.get('bot_id') == bot_id:
                    teams_with_bot.append(team)
                    break
        
        if teams_with_bot:
            # Soft delete: set is_active to False
            bot.is_active = False
            db.add(bot)
            db.commit()
        else:
            # Physical delete: remove from database
            db.delete(bot)
            db.commit()

    def create_or_update_by_k_bot_id(
        self, db: Session, *, k_bot_id: int, user_id: int
    ) -> Bot:
        """
        Create or update bot based on k_bot id
        """
        # Get k_bot
        k_bot = db.query(KBot).filter(
            KBot.id == k_bot_id,
            KBot.user_id == user_id,
            KBot.is_active == True
        ).first()
        
        if not k_bot:
            raise HTTPException(
                status_code=404,
                detail="KBot not found"
            )
        
        # Get ghost
        ghost = db.query(KGhost).filter(
            KGhost.user_id == user_id,
            KGhost.name == k_bot.ghost_ref_name,
            KGhost.namespace == k_bot.ghost_ref_namespace,
            KGhost.is_active == True
        ).first()
        
        if not ghost:
            raise HTTPException(
                status_code=404,
                detail="Ghost not found"
            )
        
        # Get shell
        shell = db.query(KShell).filter(
            KShell.user_id == user_id,
            KShell.name == k_bot.shell_ref_name,
            KShell.namespace == k_bot.shell_ref_namespace,
            KShell.is_active == True
        ).first()
        
        if not shell:
            raise HTTPException(
                status_code=404,
                detail="Shell not found"
            )
        
        # Get model through shell's model reference
        model = db.query(KModel).filter(
            KModel.user_id == user_id,
            KModel.name == shell.model_ref_name,
            KModel.namespace == shell.model_ref_namespace,
            KModel.is_active == True
        ).first()
        
        if not model:
            raise HTTPException(
                status_code=404,
                detail="Model not found"
            )
        
        # Check if bot already exists for this k_bot using k_id
        bot = db.query(Bot).filter(
            Bot.k_id == k_bot_id,
            Bot.user_id == user_id,
            Bot.is_active == True
        ).first()
        
        if bot:
            # Update existing bot
            bot.name = k_bot.name
            bot.agent_name = shell.runtime
            bot.agent_config = model.model_config
            bot.system_prompt = ghost.system_prompt
            bot.mcp_servers = ghost.mcp_servers
            bot.updated_at = datetime.utcnow()
        else:
            # Create new bot
            bot = Bot(
                user_id=user_id,
                k_id=k_bot_id,
                name=k_bot.name,
                agent_name=shell.runtime,
                agent_config=model.model_config,
                system_prompt=ghost.system_prompt,
                mcp_servers=ghost.mcp_servers,
                is_active=True
            )
            db.add(bot)
        
        db.commit()
        db.refresh(bot)
        return bot


bot_service = BotService(Bot)
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
from app.models.public_shell import PublicShell
from app.schemas.bot import BotCreate, BotUpdate, BotInDB, BotDetail
from app.schemas.kind import Ghost, Bot, Shell, Model, Team
from app.services.base import BaseService


class BotKindsService(BaseService[Kind, BotCreate, BotUpdate]):
    """
    Bot service class using kinds table
    """

    def create_with_user(
        self, db: Session, *, obj_in: BotCreate, user_id: int
    ) -> Dict[str, Any]:
        """
        Create user Bot using kinds table
        """
        # Check duplicate bot name under the same user (only active bots)
        existing = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.name == obj_in.name,
            Kind.namespace == "default",
            Kind.is_active == True
        ).first()
        if existing:
            raise HTTPException(
                status_code=400,
                detail="Bot name already exists, please modify the name"
            )

        # Create Ghost
        ghost_json = {
            "kind": "Ghost",
            "spec": {
                "systemPrompt": obj_in.system_prompt or "",
                "mcpServers": obj_in.mcp_servers or {}
            },
            "status": {
                "state": "Available"
            },
            "metadata": {
                "name": f"{obj_in.name}-ghost",
                "namespace": "default"
            },
            "apiVersion": "agent.wecode.io/v1"
        }
        
        ghost = Kind(
            user_id=user_id,
            kind="Ghost",
            name=f"{obj_in.name}-ghost",
            namespace="default",
            json=ghost_json,
            is_active=True
        )
        db.add(ghost)

        # Create Model
        model_json = {
            "kind": "Model",
            "spec": {
                "modelConfig": obj_in.agent_config
            },
            "status": {
                "state": "Available"
            },
            "metadata": {
                "name": f"{obj_in.name}-model",
                "namespace": "default"
            },
            "apiVersion": "agent.wecode.io/v1"
        }
        
        model = Kind(
            user_id=user_id,
            kind="Model",
            name=f"{obj_in.name}-model",
            namespace="default",
            json=model_json,
            is_active=True
        )
        db.add(model)

        support_model = []
        if obj_in.agent_name:
            public_shell = db.query(PublicShell).filter(
                PublicShell.name == obj_in.agent_name,
                PublicShell.namespace == "default"
            ).first()
            
            if public_shell and isinstance(public_shell.json, dict):
                shell_crd = Shell.model_validate(public_shell.json)
                support_model = shell_crd.spec.supportModel or []

        shell_json = {
            "kind": "Shell",
            "spec": {
                "runtime": obj_in.agent_name,
                "supportModel": support_model
            },
            "status": {
                "state": "Available"
            },
            "metadata": {
                "name": f"{obj_in.name}-shell",
                "namespace": "default"
            },
            "apiVersion": "agent.wecode.io/v1"
        }
        
        shell = Kind(
            user_id=user_id,
            kind="Shell",
            name=f"{obj_in.name}-shell",
            namespace="default",
            json=shell_json,
            is_active=True
        )
        db.add(shell)

        # Create Bot
        bot_json = {
            "kind": "Bot",
            "spec": {
                "ghostRef": {
                    "name": f"{obj_in.name}-ghost",
                    "namespace": "default"
                },
                "shellRef": {
                    "name": f"{obj_in.name}-shell",
                    "namespace": "default"
                },
                "modelRef": {
                    "name": f"{obj_in.name}-model",
                    "namespace": "default"
                }
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
        
        bot = Kind(
            user_id=user_id,
            kind="Bot",
            name=obj_in.name,
            namespace="default",
            json=bot_json,
            is_active=True
        )
        db.add(bot)
        
        db.commit()
        db.refresh(bot)
        
        # Return bot-like structure
        return self._convert_to_bot_dict(bot, ghost, shell, model)

    def get_user_bots(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's Bot list (only active bots)
        """
        bots = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()
        
        result = []
        for bot in bots:
            # Get related Ghost, Shell, Model
            ghost, shell, model = self._get_bot_components(db, bot, user_id)
            result.append(self._convert_to_bot_dict(bot, ghost, shell, model))
        
        return result

    def get_by_id_and_user(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Bot by ID and user ID (only active bots)
        """
        bot = db.query(Kind).filter(
            Kind.id == bot_id,
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).first()
        
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        
        # Get related Ghost, Shell, Model
        ghost, shell, model = self._get_bot_components(db, bot, user_id)
        return self._convert_to_bot_dict(bot, ghost, shell, model)
        
    def get_bot_detail(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed bot information including related user
        """
        bot_dict = self.get_by_id_and_user(db, bot_id=bot_id, user_id=user_id)
        
        # Get related user
        user = db.query(User).filter(User.id == user_id).first()
        bot_dict["user"] = user
        
        return bot_dict

    def update_with_user(
        self, db: Session, *, bot_id: int, obj_in: BotUpdate, user_id: int
    ) -> Dict[str, Any]:
        """
        Update user Bot
        """
        bot = db.query(Kind).filter(
            Kind.id == bot_id,
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).first()
        
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        
        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness under the same user (only active bots), excluding current bot
        if "name" in update_data:
            new_name = update_data["name"]
            if new_name != bot.name:
                conflict = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.name == new_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                    Kind.id != bot.id
                ).first()
                if conflict:
                    raise HTTPException(
                        status_code=400,
                        detail="Bot name already exists, please modify the name"
                    )

        # Get related components
        ghost, shell, model = self._get_bot_components(db, bot, user_id)
        
        # Update components based on update_data
        if "name" in update_data:
            new_name = update_data["name"]
            old_name = bot.name
            # Update bot
            bot.name = new_name
            bot_crd = Bot.model_validate(bot.json)
            bot_crd.metadata.name = new_name
            
            # Update references in bot spec
            bot_crd.spec.ghostRef.name = f"{new_name}-ghost"
            bot_crd.spec.shellRef.name = f"{new_name}-shell"
            bot_crd.spec.modelRef.name = f"{new_name}-model"
            bot.json = bot_crd.model_dump()
            flag_modified(bot, "json")  # Mark JSON field as modified
            
            # Update ghost
            if ghost:
                ghost.name = f"{new_name}-ghost"
                ghost_crd = Ghost.model_validate(ghost.json)
                ghost_crd.metadata.name = f"{new_name}-ghost"
                ghost.json = ghost_crd.model_dump()
                flag_modified(ghost, "json")  # Mark JSON field as modified
            
            # Update shell
            if shell:
                shell.name = f"{new_name}-shell"
                shell_crd = Shell.model_validate(shell.json)
                shell_crd.metadata.name = f"{new_name}-shell"
                shell.json = shell_crd.model_dump()
                flag_modified(shell, "json")  # Mark JSON field as modified
            
            # Update model
            if model:
                model.name = f"{new_name}-model"
                model_crd = Model.model_validate(model.json)
                model_crd.metadata.name = f"{new_name}-model"
                model.json = model_crd.model_dump()
                flag_modified(model, "json")  # Mark JSON field as modified
            
            # Update all references to this bot in teams
            self._update_bot_references_in_teams(db, old_name, "default", new_name, "default", user_id)

        if "agent_name" in update_data and shell:
            # Query public_shells table to get supportModel based on new agent_name
            support_model = []
            new_agent_name = update_data["agent_name"]
            if new_agent_name:
                public_shell = db.query(PublicShell).filter(
                    PublicShell.name == new_agent_name,
                    PublicShell.namespace == "default"
                ).first()
                
                if public_shell and isinstance(public_shell.json, dict):
                    shell_crd = Shell.model_validate(public_shell.json)
                    support_model = shell_crd.spec.supportModel or []

            shell_crd = Shell.model_validate(shell.json)
            shell_crd.spec.runtime = new_agent_name
            shell_crd.spec.supportModel = support_model
            shell.json = shell_crd.model_dump()
            flag_modified(shell, "json")  # Mark JSON field as modified

        if "agent_config" in update_data and model:
            model_crd = Model.model_validate(model.json)
            model_crd.spec.modelConfig = update_data["agent_config"]
            model.json = model_crd.model_dump()
            flag_modified(model, "json")  # Mark JSON field as modified

        if "system_prompt" in update_data and ghost:
            ghost_crd = Ghost.model_validate(ghost.json)
            ghost_crd.spec.systemPrompt = update_data["system_prompt"] or ""
            ghost.json = ghost_crd.model_dump()
            flag_modified(ghost, "json")  # Mark JSON field as modified

        if "mcp_servers" in update_data and ghost:
            ghost_crd = Ghost.model_validate(ghost.json)
            ghost_crd.spec.mcpServers = update_data["mcp_servers"] or {}
            ghost.json = ghost_crd.model_dump()
            flag_modified(ghost, "json")  # Mark JSON field as modified
            db.add(ghost)  # Add to session

        # Update timestamps
        bot.updated_at = datetime.utcnow()
        if ghost:
            ghost.updated_at = datetime.utcnow()
        if shell:
            shell.updated_at = datetime.utcnow()
        if model:
            model.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(bot)
        if ghost:
            db.refresh(ghost)
        if shell:
            db.refresh(shell)
        if model:
            db.refresh(model)
        
        return self._convert_to_bot_dict(bot, ghost, shell, model)

    def delete_with_user(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> None:
        """
        Delete user Bot and related components
        """
        bot = db.query(Kind).filter(
            Kind.id == bot_id,
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).first()
        
        if not bot:
            raise HTTPException(
                status_code=404,
                detail="Bot not found"
            )
        
        # Check if bot is referenced in any team
        teams = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).all()
        
        bot_name = bot.name
        bot_namespace = bot.namespace
        
        # Check if each team references this bot
        for team in teams:
            team_crd = Team.model_validate(team.json)
            for member in team_crd.spec.members:
                if (member.botRef.name == bot_name and
                    member.botRef.namespace == bot_namespace):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Bot '{bot_name}' is being used in team '{team.name}'. Please remove it from the team first."
                    )
        
        # Get related components
        ghost, shell, model = self._get_bot_components(db, bot, user_id)
        
        # Delete all components
        db.delete(bot)
        if ghost:
            db.delete(ghost)
        if shell:
            db.delete(shell)
        if model:
            db.delete(model)
        
        db.commit()

    def count_user_bots(self, db: Session, *, user_id: int) -> int:
        """
        Count user's active bots
        """
        return db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).count()
    def _get_bot_components(self, db: Session, bot: Kind, user_id: int):
        """
        Get Ghost, Shell, Model components for a bot
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
        
        return ghost, shell, model

    def _convert_to_bot_dict(self, bot: Kind, ghost: Kind = None, shell: Kind = None, model: Kind = None) -> Dict[str, Any]:
        """
        Convert kinds to bot-like dictionary
        """
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

    def _update_bot_references_in_teams(self, db: Session, old_name: str, old_namespace: str,
                                       new_name: str, new_namespace: str, user_id: int) -> None:
        """
        Update all references to this bot in teams when bot name/namespace changes
        """
        # Find all teams that reference this bot
        teams = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).all()
        
        for team in teams:
            team_crd = Team.model_validate(team.json)
            
            # Check if any member references the old bot
            updated = False
            for member in team_crd.spec.members:
                if (member.botRef.name == old_name and
                    member.botRef.namespace == old_namespace):
                    # Update the reference
                    member.botRef.name = new_name
                    member.botRef.namespace = new_namespace
                    updated = True
            
            # Save changes if any updates were made
            if updated:
                team.json = team_crd.model_dump()
                team.updated_at = datetime.utcnow()
                flag_modified(team, "json")


bot_kinds_service = BotKindsService(Kind)
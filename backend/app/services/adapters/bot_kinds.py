# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Dict, Any
import json
import copy

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import or_, and_

from app.models.kind import Kind
from app.models.user import User
from app.models.public_shell import PublicShell
from app.schemas.bot import BotCreate, BotUpdate, BotInDB, BotDetail
from app.schemas.kind import Ghost, Bot, Shell, Model, Team
from app.services.base import BaseService
from app.services.adapters.shell_utils import get_shell_type
from shared.utils.crypto import encrypt_sensitive_data, is_data_encrypted


class BotKindsService(BaseService[Kind, BotCreate, BotUpdate]):
    """
    Bot service class using kinds table
    """

    # List of sensitive keys that should be encrypted in agent_config
    SENSITIVE_CONFIG_KEYS = [
        "DIFY_API_KEY",
        # Add more sensitive keys here as needed
    ]

    def _encrypt_agent_config(self, agent_config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Encrypt sensitive data in agent_config before storing

        Args:
            agent_config: Original agent config dictionary

        Returns:
            Agent config with encrypted sensitive fields
        """
        # Create a deep copy to avoid modifying the original
        encrypted_config = copy.deepcopy(agent_config)

        # Encrypt sensitive keys in env section
        if "env" in encrypted_config:
            for key in self.SENSITIVE_CONFIG_KEYS:
                if key in encrypted_config["env"]:
                    value = encrypted_config["env"][key]
                    # Only encrypt if not already encrypted
                    if value and not is_data_encrypted(str(value)):
                        encrypted_config["env"][key] = encrypt_sensitive_data(str(value))

        return encrypted_config

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

        # Validate skills if provided
        if obj_in.skills:
            self._validate_skills(db, obj_in.skills, user_id)

        # Encrypt sensitive data in agent_config before storing
        encrypted_agent_config = self._encrypt_agent_config(obj_in.agent_config)

        # Create Ghost
        ghost_spec = {
            "systemPrompt": obj_in.system_prompt or "",
            "mcpServers": obj_in.mcp_servers or {}
        }
        if obj_in.skills:
            ghost_spec["skills"] = obj_in.skills

        ghost_json = {
            "kind": "Ghost",
            "spec": ghost_spec,
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
                "modelConfig": encrypted_agent_config
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
        shell_type = "local_engine"  # Default shell type
        if obj_in.agent_name:
            public_shell = db.query(PublicShell).filter(
                PublicShell.name == obj_in.agent_name,
                PublicShell.namespace == "default"
            ).first()
            
            if public_shell and isinstance(public_shell.json, dict):
                shell_crd = Shell.model_validate(public_shell.json)
                support_model = shell_crd.spec.supportModel or []
                # Get shell type from metadata.labels
                if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
                    shell_type = shell_crd.metadata.labels["type"]

        shell_json = {
            "kind": "Shell",
            "spec": {
                "runtime": obj_in.agent_name,
                "supportModel": support_model
            },
            "metadata": {
                "name": f"{obj_in.name}-shell",
                "namespace": "default",
                "labels": {
                    "type": shell_type
                }
            },
            "status": {
                "state": "Available"
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
        Optimization: avoid N+1 queries by batch-fetching Ghost/Shell/Model components to significantly reduce database round trips.
        """
        bots = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Bot",
            Kind.is_active == True
        ).order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()
        
        if not bots:
            return []
        
        # Batch-fetch related components to avoid 3 separate queries per bot
        bot_crds, ghost_map, shell_map, model_map = self._get_bot_components_batch(db, bots, user_id)
        
        result = []
        for bot in bots:
            bot_crd = bot_crds.get(bot.id)
            ghost = None
            shell = None
            model = None
            if bot_crd:
                ghost = ghost_map.get((bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace))
                shell = shell_map.get((bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace))
                model = model_map.get((bot_crd.spec.modelRef.name, bot_crd.spec.modelRef.namespace))
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
            # Update bot
            bot.name = new_name
            flag_modified(bot, "json")  # Mark JSON field as modified

        if "agent_name" in update_data and shell:
            # Query public_shells table to get supportModel and shell type based on new agent_name
            support_model = []
            shell_type = "local_engine"  # Default shell type
            new_agent_name = update_data["agent_name"]
            if new_agent_name:
                public_shell = db.query(PublicShell).filter(
                    PublicShell.name == new_agent_name,
                    PublicShell.namespace == "default"
                ).first()
                
                if public_shell and isinstance(public_shell.json, dict):
                    public_shell_crd = Shell.model_validate(public_shell.json)
                    support_model = public_shell_crd.spec.supportModel or []
                    # Get shell type from metadata.labels
                    if public_shell_crd.metadata.labels and "type" in public_shell_crd.metadata.labels:
                        shell_type = public_shell_crd.metadata.labels["type"]

            shell_crd = Shell.model_validate(shell.json)
            shell_crd.spec.runtime = new_agent_name
            shell_crd.spec.supportModel = support_model
            # Update shell type in metadata.labels
            if not shell_crd.metadata.labels:
                shell_crd.metadata.labels = {}
            shell_crd.metadata.labels["type"] = shell_type
            shell.json = shell_crd.model_dump()
            flag_modified(shell, "json")  # Mark JSON field as modified

        if "agent_config" in update_data and model:
            model_crd = Model.model_validate(model.json)
            # Encrypt sensitive data before updating
            encrypted_agent_config = self._encrypt_agent_config(update_data["agent_config"])
            model_crd.spec.modelConfig = encrypted_agent_config
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

        if "skills" in update_data and ghost:
            # Validate that all referenced skills exist for this user
            skills = update_data["skills"] or []
            if skills:
                self._validate_skills(db, skills, user_id)
            ghost_crd = Ghost.model_validate(ghost.json)
            ghost_crd.spec.skills = skills
            ghost.json = ghost_crd.model_dump()
            flag_modified(ghost, "json")
            db.add(ghost)

        # Update timestamps
        bot.updated_at = datetime.now()
        if ghost:
            ghost.updated_at = datetime.now()
        if shell:
            shell.updated_at = datetime.now()
        if model:
            model.updated_at = datetime.now()
        
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
    
    def _get_bot_components_batch(self, db: Session, bots: List[Kind], user_id: int):
        """
        Batch-fetch Ghost/Shell/Model components for multiple bots to avoid N+1 queries.
        Returns:
          - bot_crds: {bot.id: Bot} mapping to avoid repeated parsing
          - ghost_map: {(name, namespace): Kind}
          - shell_map: {(name, namespace): Kind}
          - model_map: {(name, namespace): Kind}
        """
        if not bots:
            return {}, {}, {}, {}
        
        ghost_keys = set()
        shell_keys = set()
        model_keys = set()
        bot_crds = {}
        
        for bot in bots:
            # Parse bot.json once and reuse later
            bot_crd = Bot.model_validate(bot.json)
            bot_crds[bot.id] = bot_crd
            ghost_keys.add((bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace))
            shell_keys.add((bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace))
            model_keys.add((bot_crd.spec.modelRef.name, bot_crd.spec.modelRef.namespace))
        
        def build_or_filters(kind_name: str, keys: set):
            # Compose OR of AND clauses: or_(and_(kind==X, name==N, namespace==NS), ...)
            return or_(*[and_(Kind.kind == kind_name, Kind.name == n, Kind.namespace == ns) for (n, ns) in keys]) if keys else None
        
        base_filter = and_(Kind.user_id == user_id, Kind.is_active == True)
        
        ghosts = []
        shells = []
        models = []
        
        ghost_filter = build_or_filters("Ghost", ghost_keys)
        if ghost_filter is not None:
            ghosts = db.query(Kind).filter(base_filter).filter(ghost_filter).all()
        
        shell_filter = build_or_filters("Shell", shell_keys)
        if shell_filter is not None:
            shells = db.query(Kind).filter(base_filter).filter(shell_filter).all()
        
        model_filter = build_or_filters("Model", model_keys)
        if model_filter is not None:
            models = db.query(Kind).filter(base_filter).filter(model_filter).all()
        
        ghost_map = {(g.name, g.namespace): g for g in ghosts}
        shell_map = {(s.name, s.namespace): s for s in shells}
        model_map = {(m.name, m.namespace): m for m in models}
        
        return bot_crds, ghost_map, shell_map, model_map

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

        # Extract skills from ghost
        skills = []
        if ghost:
            ghost_crd = Ghost.model_validate(ghost.json)
            skills = ghost_crd.spec.skills or []

        return {
            "id": bot.id,
            "user_id": bot.user_id,
            "name": bot.name,
            "agent_name": agent_name,
            "agent_config": agent_config,
            "system_prompt": system_prompt,
            "mcp_servers": mcp_servers,
            "skills": skills,
            "is_active": bot.is_active,
            "created_at": bot.created_at,
            "updated_at": bot.updated_at,
        }

    def _validate_skills(self, db: Session, skill_names: List[str], user_id: int) -> None:
        """
        Validate that all skill names exist for the user.

        Args:
            db: Database session
            skill_names: List of skill names to validate
            user_id: User ID

        Raises:
            HTTPException: If any skill does not exist
        """
        if not skill_names:
            return

        # Query all skills at once for efficiency
        existing_skills = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Skill",
            Kind.name.in_(skill_names),
            Kind.namespace == "default",
            Kind.is_active == True
        ).all()

        existing_skill_names = {skill.name for skill in existing_skills}
        missing_skills = [name for name in skill_names if name not in existing_skill_names]

        if missing_skills:
            raise HTTPException(
                status_code=400,
                detail=f"The following Skills do not exist: {', '.join(missing_skills)}"
            )


bot_kinds_service = BotKindsService(Kind)
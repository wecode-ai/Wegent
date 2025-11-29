# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import copy
import json
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from shared.utils.crypto import encrypt_sensitive_data, is_data_encrypted
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.public_model import PublicModel
from app.models.public_shell import PublicShell
from app.models.user import User
from app.schemas.bot import BotCreate, BotDetail, BotInDB, BotUpdate
from app.schemas.kind import Bot, Ghost, Model, Shell, Team
from app.services.adapters.shell_utils import get_shell_type
from app.services.base import BaseService


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
                        encrypted_config["env"][key] = encrypt_sensitive_data(
                            str(value)
                        )

        return encrypted_config

    def _is_predefined_model(self, agent_config: Dict[str, Any]) -> bool:
        """
        Check if agent_config is a predefined model reference.

        A predefined model config has:
        - bind_model: model name
        - bind_model_type: optional, 'public' or 'user' (defaults to auto-detect)

        It should NOT have other keys like 'env', 'protocol' etc.
        """
        if not agent_config:
            return False
        keys = set(agent_config.keys())
        # Allow bind_model and optional bind_model_type
        allowed_keys = {"bind_model", "bind_model_type"}
        return "bind_model" in keys and keys.issubset(allowed_keys)

    def _get_model_name_from_config(self, agent_config: Dict[str, Any]) -> str:
        """
        Get model name from agent_config's bind_model field
        """
        if not agent_config:
            return ""
        return agent_config.get("bind_model", "")

    def _get_model_type_from_config(
        self, agent_config: Dict[str, Any]
    ) -> Optional[str]:
        """
        Get model type from agent_config's bind_model_type field.

        Returns:
            'public' or 'user', or None if not specified (auto-detect)
        """
        if not agent_config:
            return None
        return agent_config.get("bind_model_type")

    def _get_protocol_from_config(self, agent_config: Dict[str, Any]) -> Optional[str]:
        """
        Get protocol from agent_config's protocol field (for custom configs)
        """
        if not agent_config:
            return None
        return agent_config.get("protocol")

    def _get_model_by_name_and_type(
        self,
        db: Session,
        model_name: str,
        namespace: str,
        user_id: int,
        model_type: Optional[str] = None,
    ) -> Optional[Any]:
        """
        Get model by name and optional type from kinds table or public_models table.

        Args:
            db: Database session
            model_name: Model name
            namespace: Namespace
            user_id: User ID
            model_type: Optional model type ('public' or 'user').
                       If None, tries user models first, then public.

        Returns:
            A Kind object (for user models) or PublicModel object (for public models),
            or None if not found.
        """
        import logging

        logger = logging.getLogger(__name__)

        if model_type == "user":
            # Only look in user's private models
            model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )

            if model:
                logger.info(
                    f"[DEBUG] _get_model_by_name_and_type: Found user model {model_name}"
                )
                return model
            return None

        elif model_type == "public":
            # Only look in public_models table
            public_model = (
                db.query(PublicModel)
                .filter(
                    PublicModel.name == model_name,
                    PublicModel.namespace == namespace,
                    PublicModel.is_active.is_(True),
                )
                .first()
            )

            if public_model:
                logger.info(
                    f"[DEBUG] _get_model_by_name_and_type: Found public model {model_name}"
                )
                return public_model
            return None

        else:
            # Auto-detect: try user models first, then public
            model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == namespace,
                    Kind.is_active.is_(True),
                )
                .first()
            )

            if model:
                logger.info(
                    f"[DEBUG] _get_model_by_name_and_type: Found user model {model_name} (auto-detect)"
                )
                return model

            # Then try to find in public_models table
            public_model = (
                db.query(PublicModel)
                .filter(
                    PublicModel.name == model_name,
                    PublicModel.namespace == namespace,
                    PublicModel.is_active.is_(True),
                )
                .first()
            )

            if public_model:
                logger.info(
                    f"[DEBUG] _get_model_by_name_and_type: Found public model {model_name} (auto-detect)"
                )
                return public_model

            logger.info(
                f"[DEBUG] _get_model_by_name_and_type: Model {model_name} not found in either table"
            )
            return None

    def _get_model_by_name(
        self, db: Session, model_name: str, namespace: str, user_id: int
    ) -> Optional[Any]:
        """
        Get model by name from kinds table (user's private models) or public_models table.
        Returns a Kind object or a PublicModel object for public models.

        This is a backward-compatible wrapper around _get_model_by_name_and_type.
        """
        return self._get_model_by_name_and_type(
            db, model_name, namespace, user_id, model_type=None
        )

    def create_with_user(
        self, db: Session, *, obj_in: BotCreate, user_id: int
    ) -> Dict[str, Any]:
        """
        Create user Bot using kinds table
        """
        # Check duplicate bot name under the same user (only active bots)
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == obj_in.name,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail="Bot name already exists, please modify the name",
            )

        # Validate skills if provided
        if obj_in.skills:
            self._validate_skills(db, obj_in.skills, user_id)

        # Encrypt sensitive data in agent_config before storing
        encrypted_agent_config = self._encrypt_agent_config(obj_in.agent_config)

        # Create Ghost
        ghost_spec = {
            "systemPrompt": obj_in.system_prompt or "",
            "mcpServers": obj_in.mcp_servers or {},
        }
        if obj_in.skills:
            ghost_spec["skills"] = obj_in.skills

        ghost_json = {
            "kind": "Ghost",
            "spec": ghost_spec,
            "status": {"state": "Available"},
            "metadata": {"name": f"{obj_in.name}-ghost", "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        ghost = Kind(
            user_id=user_id,
            kind="Ghost",
            name=f"{obj_in.name}-ghost",
            namespace="default",
            json=ghost_json,
            is_active=True,
        )
        db.add(ghost)

        # Determine model reference
        # If agent_config is predefined model format (only bind_model), reference existing model
        # Otherwise, create a private model for this bot
        model = None
        model_ref_name = f"{obj_in.name}-model"
        model_ref_namespace = "default"

        if self._is_predefined_model(obj_in.agent_config):
            # Reference existing model by bind_model name
            model_ref_name = self._get_model_name_from_config(obj_in.agent_config)
            model_ref_namespace = "default"
            # Don't create a new model, just reference the existing one
        else:
            # Create private Model for custom config
            # Extract protocol from agent_config (it's a top-level field, not inside modelConfig)
            protocol = self._get_protocol_from_config(obj_in.agent_config)

            # Remove protocol from the config that goes into modelConfig (it's stored separately)
            model_config = {
                k: v for k, v in obj_in.agent_config.items() if k != "protocol"
            }

            model_json = {
                "kind": "Model",
                "spec": {
                    "modelConfig": model_config,
                    "isCustomConfig": True,  # Mark as user custom config
                    "protocol": protocol,  # Store protocol at spec level
                },
                "status": {"state": "Available"},
                "metadata": {"name": f"{obj_in.name}-model", "namespace": "default"},
                "apiVersion": "agent.wecode.io/v1",
            }

            model = Kind(
                user_id=user_id,
                kind="Model",
                name=f"{obj_in.name}-model",
                namespace="default",
                json=model_json,
                is_active=True,
            )
            db.add(model)

        support_model = []
        shell_type = "local_engine"  # Default shell type
        if obj_in.agent_name:
            public_shell = (
                db.query(PublicShell)
                .filter(
                    PublicShell.name == obj_in.agent_name,
                    PublicShell.namespace == "default",
                )
                .first()
            )

            if public_shell and isinstance(public_shell.json, dict):
                shell_crd = Shell.model_validate(public_shell.json)
                support_model = shell_crd.spec.supportModel or []
                # Get shell type from metadata.labels
                if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
                    shell_type = shell_crd.metadata.labels["type"]

        shell_json = {
            "kind": "Shell",
            "spec": {"runtime": obj_in.agent_name, "supportModel": support_model},
            "metadata": {
                "name": f"{obj_in.name}-shell",
                "namespace": "default",
                "labels": {"type": shell_type},
            },
            "status": {"state": "Available"},
            "apiVersion": "agent.wecode.io/v1",
        }

        shell = Kind(
            user_id=user_id,
            kind="Shell",
            name=f"{obj_in.name}-shell",
            namespace="default",
            json=shell_json,
            is_active=True,
        )
        db.add(shell)

        # Create Bot with modelRef pointing to the selected model
        bot_json = {
            "kind": "Bot",
            "spec": {
                "ghostRef": {"name": f"{obj_in.name}-ghost", "namespace": "default"},
                "shellRef": {"name": f"{obj_in.name}-shell", "namespace": "default"},
                "modelRef": {"name": model_ref_name, "namespace": model_ref_namespace},
            },
            "status": {"state": "Available"},
            "metadata": {"name": obj_in.name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        bot = Kind(
            user_id=user_id,
            kind="Bot",
            name=obj_in.name,
            namespace="default",
            json=bot_json,
            is_active=True,
        )
        db.add(bot)

        db.commit()
        db.refresh(bot)

        # Get the referenced model for response
        if model is None:
            # For predefined model, fetch from database
            model = self._get_model_by_name(
                db, model_ref_name, model_ref_namespace, user_id
            )
        else:
            db.refresh(model)

        # Return bot-like structure
        return self._convert_to_bot_dict(bot, ghost, shell, model, obj_in.agent_config)

    def get_user_bots(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get user's Bot list (only active bots)
        Optimization: avoid N+1 queries by batch-fetching Ghost/Shell/Model components to significantly reduce database round trips.
        """
        bots = (
            db.query(Kind)
            .filter(Kind.user_id == user_id, Kind.kind == "Bot", Kind.is_active == True)
            .order_by(Kind.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        if not bots:
            return []

        # Batch-fetch related components to avoid 3 separate queries per bot
        bot_crds, ghost_map, shell_map, model_map = self._get_bot_components_batch(
            db, bots, user_id
        )

        result = []
        for bot in bots:
            bot_crd = bot_crds.get(bot.id)
            ghost = None
            shell = None
            model = None
            if bot_crd:
                ghost = ghost_map.get(
                    (bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace)
                )
                shell = shell_map.get(
                    (bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace)
                )
                # modelRef is optional, only get if it exists
                if bot_crd.spec.modelRef:
                    model = model_map.get(
                        (bot_crd.spec.modelRef.name, bot_crd.spec.modelRef.namespace)
                    )
            result.append(self._convert_to_bot_dict(bot, ghost, shell, model))

        return result

    def get_by_id_and_user(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Bot by ID and user ID (only active bots)
        """
        bot = (
            db.query(Kind)
            .filter(
                Kind.id == bot_id,
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

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
        import logging

        logger = logging.getLogger(__name__)

        bot = (
            db.query(Kind)
            .filter(
                Kind.id == bot_id,
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

        update_data = obj_in.model_dump(exclude_unset=True)
        logger.info(f"[DEBUG] update_with_user: update_data={update_data}")

        # If updating name, ensure uniqueness under the same user (only active bots), excluding current bot
        if "name" in update_data:
            new_name = update_data["name"]
            if new_name != bot.name:
                conflict = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.kind == "Bot",
                        Kind.name == new_name,
                        Kind.namespace == "default",
                        Kind.is_active == True,
                        Kind.id != bot.id,
                    )
                    .first()
                )
                if conflict:
                    raise HTTPException(
                        status_code=400,
                        detail="Bot name already exists, please modify the name",
                    )

        # Get related components
        ghost, shell, model = self._get_bot_components(db, bot, user_id)

        # Track the agent_config to return (for predefined models)
        return_agent_config = None

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
                public_shell = (
                    db.query(PublicShell)
                    .filter(
                        PublicShell.name == new_agent_name,
                        PublicShell.namespace == "default",
                    )
                    .first()
                )

                if public_shell and isinstance(public_shell.json, dict):
                    public_shell_crd = Shell.model_validate(public_shell.json)
                    support_model = public_shell_crd.spec.supportModel or []
                    # Get shell type from metadata.labels
                    if (
                        public_shell_crd.metadata.labels
                        and "type" in public_shell_crd.metadata.labels
                    ):
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

        if "agent_config" in update_data:
            new_agent_config = update_data["agent_config"]
            logger.info(f"[DEBUG] Updating agent_config: {new_agent_config}")

            if self._is_predefined_model(new_agent_config):
                # For predefined model, update bot's modelRef to point to the selected model
                model_name = self._get_model_name_from_config(new_agent_config)
                model_type = self._get_model_type_from_config(new_agent_config)
                logger.info(
                    f"[DEBUG] Predefined model detected, updating modelRef to: {model_name}, type: {model_type}"
                )

                # Update bot's modelRef
                bot_crd = Bot.model_validate(bot.json)
                if bot_crd.spec.modelRef:
                    bot_crd.spec.modelRef.name = model_name
                    bot_crd.spec.modelRef.namespace = "default"
                    bot.json = bot_crd.model_dump()
                    flag_modified(bot, "json")

                # Only delete old model if it's a user's private custom model (not public or predefined)
                # A private custom model must satisfy:
                # 1. It's a Kind object (not PublicModel)
                # 2. It has the naming pattern "{bot.name}-model" (dedicated to this bot)
                # 3. It has isCustomConfig=True in the model spec
                if model and model.name != model_name:
                    # Check if it's a Kind object (private model) vs PublicModel
                    is_kind_model = isinstance(model, Kind)
                    if is_kind_model:
                        # Check if it's a dedicated private custom model for this bot
                        dedicated_model_name = f"{bot.name}-model"
                        is_dedicated_model = model.name == dedicated_model_name

                        # Check if it has isCustomConfig=True
                        is_custom_config = False
                        if model.json:
                            model_crd = Model.model_validate(model.json)
                            is_custom_config = model_crd.spec.isCustomConfig or False

                        # Only delete if it's a dedicated private custom model
                        if is_dedicated_model and is_custom_config:
                            logger.info(
                                f"[DEBUG] Deleting old private custom model: {model.name}"
                            )
                            db.delete(model)
                            model = None
                        else:
                            logger.info(
                                f"[DEBUG] Not deleting model {model.name}: is_dedicated={is_dedicated_model}, is_custom_config={is_custom_config}"
                            )
                    else:
                        logger.info(
                            f"[DEBUG] Not deleting model {model.name}: it's a public model"
                        )

                # Get the new model for response using type hint
                model = self._get_model_by_name_and_type(
                    db, model_name, "default", user_id, model_type
                )
                return_agent_config = new_agent_config
            else:
                # For custom config, we need to check if we should update existing model or create new one
                # We should only update if the model is a dedicated private model for this bot
                # Otherwise, we need to create a new private model

                # Extract protocol from agent_config
                protocol = self._get_protocol_from_config(new_agent_config)
                # Remove protocol from the config that goes into modelConfig
                model_config = {
                    k: v for k, v in new_agent_config.items() if k != "protocol"
                }

                dedicated_model_name = f"{bot.name}-model"

                # Check if we have an existing dedicated private model for this bot
                is_dedicated_private_model = False
                if model and isinstance(model, Kind):
                    # Check if it's a dedicated model for this bot
                    is_dedicated_model = model.name == dedicated_model_name
                    # Check if it has isCustomConfig=True
                    is_custom_config = False
                    if model.json:
                        model_crd = Model.model_validate(model.json)
                        is_custom_config = model_crd.spec.isCustomConfig or False
                    is_dedicated_private_model = is_dedicated_model and is_custom_config

                if is_dedicated_private_model:
                    # Update the existing dedicated private model
                    logger.info(
                        f"[DEBUG] Custom config, updating existing dedicated private model: {model.name}"
                    )
                    model_crd = Model.model_validate(model.json)
                    model_crd.spec.modelConfig = model_config
                    model_crd.spec.isCustomConfig = True
                    model_crd.spec.protocol = protocol
                    model.json = model_crd.model_dump()
                    flag_modified(model, "json")
                    db.add(model)
                elif (
                    model
                    and isinstance(model, Kind)
                    and model.name == dedicated_model_name
                ):
                    # The model exists with the dedicated name but is not marked as custom config, update it
                    logger.info(
                        f"[DEBUG] Custom config, updating existing model (marking as custom): {model.name}"
                    )
                    model_crd = Model.model_validate(model.json)
                    model_crd.spec.modelConfig = model_config
                    model_crd.spec.isCustomConfig = True
                    model_crd.spec.protocol = protocol
                    model.json = model_crd.model_dump()
                    flag_modified(model, "json")
                    db.add(model)
                else:
                    # No existing dedicated private model, create a new one
                    # This happens when:
                    # 1. model is None (no model at all)
                    # 2. model is a PublicModel (can't be modified)
                    # 3. model is a Kind but not dedicated to this bot (shared model)
                    logger.info("[DEBUG] Creating new private model for custom config")

                    model_json = {
                        "kind": "Model",
                        "spec": {
                            "modelConfig": model_config,
                            "isCustomConfig": True,
                            "protocol": protocol,
                        },
                        "status": {"state": "Available"},
                        "metadata": {
                            "name": f"{bot.name}-model",
                            "namespace": "default",
                        },
                        "apiVersion": "agent.wecode.io/v1",
                    }

                    model = Kind(
                        user_id=user_id,
                        kind="Model",
                        name=dedicated_model_name,
                        namespace="default",
                        json=model_json,
                        is_active=True,
                    )
                    db.add(model)

                    # Update bot's modelRef to point to the new dedicated model
                    bot_crd = Bot.model_validate(bot.json)
                    from app.schemas.kind import ModelRef

                    if bot_crd.spec.modelRef:
                        bot_crd.spec.modelRef.name = dedicated_model_name
                        bot_crd.spec.modelRef.namespace = "default"
                    else:
                        # Create new modelRef
                        bot_crd.spec.modelRef = ModelRef(
                            name=dedicated_model_name, namespace="default"
                        )
                    bot.json = bot_crd.model_dump()
                    flag_modified(bot, "json")

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
        if model and hasattr(model, "updated_at"):
            model.updated_at = datetime.now()

        db.commit()
        db.refresh(bot)
        if ghost:
            db.refresh(ghost)
        if shell:
            db.refresh(shell)
        if model and hasattr(model, "id"):
            try:
                db.refresh(model)
            except (AttributeError, TypeError) as e:
                logger.debug(
                    "Model refresh skipped (PublicModel may not need refresh): %s", e
                )

        return self._convert_to_bot_dict(bot, ghost, shell, model, return_agent_config)

    def delete_with_user(self, db: Session, *, bot_id: int, user_id: int) -> None:
        """
        Delete user Bot and related components
        """
        bot = (
            db.query(Kind)
            .filter(
                Kind.id == bot_id,
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

        # Check if bot is referenced in any team
        teams = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id, Kind.kind == "Team", Kind.is_active == True
            )
            .all()
        )

        bot_name = bot.name
        bot_namespace = bot.namespace

        # Check if each team references this bot
        for team in teams:
            team_crd = Team.model_validate(team.json)
            for member in team_crd.spec.members:
                if (
                    member.botRef.name == bot_name
                    and member.botRef.namespace == bot_namespace
                ):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Bot '{bot_name}' is being used in team '{team.name}'. Please remove it from the team first.",
                    )

        # Get related components
        ghost, shell, model = self._get_bot_components(db, bot, user_id)

        # Delete all components
        db.delete(bot)
        if ghost:
            db.delete(ghost)
        if shell:
            db.delete(shell)

        db.commit()

    def count_user_bots(self, db: Session, *, user_id: int) -> int:
        """
        Count user's active bots
        """
        return (
            db.query(Kind)
            .filter(Kind.user_id == user_id, Kind.kind == "Bot", Kind.is_active == True)
            .count()
        )

    def _get_bot_components(self, db: Session, bot: Kind, user_id: int):
        """
        Get Ghost, Shell, Model components for a bot.
        Model can be from kinds table (private) or public_models table.
        """
        import logging

        logger = logging.getLogger(__name__)

        bot_crd = Bot.model_validate(bot.json)
        model_ref_name = bot_crd.spec.modelRef.name if bot_crd.spec.modelRef else None
        model_ref_namespace = (
            bot_crd.spec.modelRef.namespace if bot_crd.spec.modelRef else None
        )
        logger.info(
            f"[DEBUG] _get_bot_components: bot.name={bot.name}, modelRef.name={model_ref_name}, modelRef.namespace={model_ref_namespace}"
        )

        # Get ghost
        ghost = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Ghost",
                Kind.name == bot_crd.spec.ghostRef.name,
                Kind.namespace == bot_crd.spec.ghostRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        # Get shell
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        # Get model - try private models first, then public models
        # modelRef is optional, only get if it exists
        model = None
        if bot_crd.spec.modelRef:
            model = self._get_model_by_name(
                db, bot_crd.spec.modelRef.name, bot_crd.spec.modelRef.namespace, user_id
            )

        logger.info(
            f"[DEBUG] _get_bot_components: ghost={ghost is not None}, shell={shell is not None}, model={model is not None}"
        )
        if model:
            logger.info(f"[DEBUG] _get_bot_components: model.json={model.json}")

        return ghost, shell, model

    def _get_bot_components_batch(self, db: Session, bots: List[Kind], user_id: int):
        """
        Batch-fetch Ghost/Shell/Model components for multiple bots to avoid N+1 queries.
        Models can be from kinds table (private) or public_models table.
        Returns:
          - bot_crds: {bot.id: Bot} mapping to avoid repeated parsing
          - ghost_map: {(name, namespace): Kind}
          - shell_map: {(name, namespace): Kind}
          - model_map: {(name, namespace): Kind or PublicModel}
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
            ghost_keys.add(
                (bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace)
            )
            shell_keys.add(
                (bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace)
            )
            # modelRef is optional, only add if it exists
            if bot_crd.spec.modelRef:
                model_keys.add(
                    (bot_crd.spec.modelRef.name, bot_crd.spec.modelRef.namespace)
                )

        def build_or_filters(kind_name: str, keys: set):
            # Compose OR of AND clauses: or_(and_(kind==X, name==N, namespace==NS), ...)
            return (
                or_(
                    *[
                        and_(
                            Kind.kind == kind_name, Kind.name == n, Kind.namespace == ns
                        )
                        for (n, ns) in keys
                    ]
                )
                if keys
                else None
            )

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

        # For models not found in kinds table, try to find in public_models table
        missing_model_keys = model_keys - set(model_map.keys())
        if missing_model_keys:

            def build_public_model_or_filters(keys: set):
                return (
                    or_(
                        *[
                            and_(PublicModel.name == n, PublicModel.namespace == ns)
                            for (n, ns) in keys
                        ]
                    )
                    if keys
                    else None
                )

            public_model_filter = build_public_model_or_filters(missing_model_keys)
            if public_model_filter is not None:
                public_models = (
                    db.query(PublicModel)
                    .filter(PublicModel.is_active.is_(True))
                    .filter(public_model_filter)
                    .all()
                )

                for pm in public_models:
                    model_map[(pm.name, pm.namespace)] = pm

        return bot_crds, ghost_map, shell_map, model_map

    def _convert_to_bot_dict(
        self,
        bot: Kind,
        ghost: Kind | None = None,
        shell: Kind | None = None,
        model=None,
        override_agent_config: Dict[str, Any] | None = None,
    ) -> Dict[str, Any]:
        """
        Convert kinds to bot-like dictionary.

        Args:
            bot: The Bot Kind object
            ghost: The Ghost Kind object (optional)
            shell: The Shell Kind object (optional)
            model: The Model object - can be Kind (private) or PublicModel (public)
            override_agent_config: If provided, use this instead of extracting from model.
                                   Used for predefined models where we want to return { bind_model: "xxx" }
        """
        import logging

        logger = logging.getLogger(__name__)

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

        # Determine agent_config
        # For frontend display, we need to return { bind_model: "xxx", bind_model_type: "public"|"user" } format when:
        # 1. override_agent_config is provided (explicit override)
        # 2. The model is a public model (PublicModel instance)
        # 3. The model is a shared/predefined model (modelRef.name != "{bot.name}-model")
        # 4. The model's isCustomConfig is False/None
        # Only return full modelConfig when it's a bot's dedicated private model with isCustomConfig=True
        #
        # The bind_model_type field is important for:
        # - Avoiding naming conflicts between public and user models
        # - Determining which table to query when resolving a model
        if override_agent_config is not None:
            # Use the override (for predefined models)
            agent_config = override_agent_config
            logger.info(
                f"[DEBUG] _convert_to_bot_dict: Using override_agent_config={agent_config}"
            )
        elif model and model.json:
            model_json = model.json
            model_crd = Model.model_validate(model_json)
            model_config = model_crd.spec.modelConfig
            is_custom_config = model_crd.spec.isCustomConfig
            protocol = model_crd.spec.protocol

            # Get the modelRef name from bot to determine if it's a dedicated private model
            bot_crd = Bot.model_validate(bot.json)
            model_ref_name = (
                bot_crd.spec.modelRef.name if bot_crd.spec.modelRef else None
            )
            dedicated_model_name = f"{bot.name}-model"

            # Check if this is a dedicated private model for this bot
            # A dedicated private model must satisfy BOTH conditions:
            # 1. Has the naming pattern "{bot.name}-model"
            # 2. Has isCustomConfig=True in the model spec
            is_dedicated_private_model = (
                (model_ref_name == dedicated_model_name and is_custom_config)
                if model_ref_name
                else False
            )

            if isinstance(model, PublicModel):
                # This is a public model, return bind_model format with type
                agent_config = {
                    "bind_model": model.name,
                    "bind_model_type": "public",  # Identify as public model
                }
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Public model, returning bind_model format: {agent_config}"
                )
            elif not is_dedicated_private_model:
                # This is a shared/predefined model (not dedicated to this bot)
                # Return bind_model format with type so frontend can display the dropdown
                agent_config = {
                    "bind_model": model_ref_name,
                    "bind_model_type": "user",  # Identify as user-defined model
                }
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Shared model (modelRef={model_ref_name}), returning bind_model format: {agent_config}"
                )
            elif is_custom_config:
                # This is a dedicated private model with custom config
                # Return the full config with protocol included
                agent_config = dict(model_config) if model_config else {}
                if protocol:
                    agent_config["protocol"] = protocol
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Custom config model, returning full config with protocol: {agent_config}"
                )
            else:
                # This is a dedicated private model but not marked as custom config
                # Return bind_model format with type for backward compatibility
                agent_config = {
                    "bind_model": model_ref_name,
                    "bind_model_type": "user",  # Identify as user-defined model
                }
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Dedicated model without isCustomConfig, returning bind_model format: {agent_config}"
                )

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

    def _validate_skills(
        self, db: Session, skill_names: List[str], user_id: int
    ) -> None:
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
        existing_skills = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name.in_(skill_names),
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )

        existing_skill_names = {skill.name for skill in existing_skills}
        missing_skills = [
            name for name in skill_names if name not in existing_skill_names
        ]

        if missing_skills:
            raise HTTPException(
                status_code=400,
                detail=f"The following Skills do not exist: {', '.join(missing_skills)}",
            )


bot_kinds_service = BotKindsService(Kind)

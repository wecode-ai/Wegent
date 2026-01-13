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
from app.models.user import User
from app.schemas.bot import BotCreate, BotDetail, BotInDB, BotUpdate
from app.schemas.kind import Bot, Ghost, Model, Shell, Team
from app.services.adapters.shell_utils import (
    get_shell_by_name,
    get_shell_info_by_name,
    get_shell_type,
    get_shells_by_names_batch,
)
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
        - bind_model_namespace: optional, namespace for the model

        It should NOT have other keys like 'env', 'protocol' etc.
        """
        if not agent_config:
            return False
        keys = set(agent_config.keys())
        # Allow bind_model, optional bind_model_type, and optional bind_model_namespace
        allowed_keys = {"bind_model", "bind_model_type", "bind_model_namespace"}
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

    def _get_model_namespace_from_config(
        self, agent_config: Dict[str, Any]
    ) -> Optional[str]:
        """
        Get model namespace from agent_config's bind_model_namespace field.

        Returns:
            The model namespace, or None if not specified (defaults to bot's namespace)
        """
        if not agent_config:
            return None
        return agent_config.get("bind_model_namespace")

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
            A Kind object (for both user and public models),
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
            # Only look in public models (kinds table with user_id=0)
            public_model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == namespace,
                    Kind.is_active.is_(True),
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

            # Then try to find in public models (kinds table with user_id=0)
            public_model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == namespace,
                    Kind.is_active.is_(True),
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
        Get model by name from kinds table (user's private models or public models).
        Returns a Kind object for both user and public models.

        This is a backward-compatible wrapper around _get_model_by_name_and_type.
        """
        return self._get_model_by_name_and_type(
            db, model_name, namespace, user_id, model_type=None
        )

    # Note: _get_shell_info_by_name has been moved to shell_utils.py
    # Use get_shell_info_by_name from shell_utils instead

    def create_with_user(
        self, db: Session, *, obj_in: BotCreate, user_id: int
    ) -> Dict[str, Any]:
        """
        Create user Bot using kinds table.

        Bot's shellRef directly points to the user-selected Shell (custom or public),
        instead of creating a dedicated shell for each bot.
        """
        import logging

        logger = logging.getLogger(__name__)

        # Use namespace from request, default to 'default'
        namespace = obj_in.namespace or "default"

        # Check duplicate bot name under the same user and namespace (only active bots)
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == obj_in.name,
                Kind.namespace == namespace,
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
            self._validate_skills(db, obj_in.skills, user_id, namespace)

        # Encrypt sensitive data in agent_config before storing
        encrypted_agent_config = self._encrypt_agent_config(obj_in.agent_config)

        # Create Ghost
        ghost_spec = {
            "systemPrompt": obj_in.system_prompt or "",
            "mcpServers": obj_in.mcp_servers or {},
        }
        if obj_in.skills:
            ghost_spec["skills"] = obj_in.skills
        if obj_in.preload_skills:
            ghost_spec["preload_skills"] = obj_in.preload_skills

        ghost_json = {
            "kind": "Ghost",
            "spec": ghost_spec,
            "status": {"state": "Available"},
            "metadata": {"name": f"{obj_in.name}-ghost", "namespace": namespace},
            "apiVersion": "agent.wecode.io/v1",
        }

        ghost = Kind(
            user_id=user_id,
            kind="Ghost",
            name=f"{obj_in.name}-ghost",
            namespace=namespace,
            json=ghost_json,
            is_active=True,
        )
        db.add(ghost)

        # Determine model reference
        # If agent_config is predefined model format (only bind_model), reference existing model
        # Otherwise, create a private model for this bot
        model = None
        model_ref_name = f"{obj_in.name}-model"
        model_ref_namespace = namespace

        if self._is_predefined_model(obj_in.agent_config):
            # Reference existing model by bind_model name
            model_ref_name = self._get_model_name_from_config(obj_in.agent_config)
            model_type = self._get_model_type_from_config(obj_in.agent_config)
            # For public/user models, namespace should be 'default'
            # For group models, use the specified namespace or bot's namespace
            if model_type == "group":
                model_ref_namespace = (
                    self._get_model_namespace_from_config(obj_in.agent_config)
                    or namespace
                )
            else:
                # public or user models use 'default' namespace
                model_ref_namespace = (
                    self._get_model_namespace_from_config(obj_in.agent_config)
                    or "default"
                )
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
                "metadata": {"name": f"{obj_in.name}-model", "namespace": namespace},
                "apiVersion": "agent.wecode.io/v1",
            }

            model = Kind(
                user_id=user_id,
                kind="Model",
                name=f"{obj_in.name}-model",
                namespace=namespace,
                json=model_json,
                is_active=True,
            )
            db.add(model)

        # Get shell info by name (resolves actual shell_type from shell_name)
        # The shell_name is the name of the user-selected Shell (custom or public)
        try:
            shell_info = get_shell_info_by_name(db, obj_in.shell_name, user_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        logger.info(
            f"[DEBUG] create_with_user: shell_name={obj_in.shell_name}, "
            f"resolved shell_type={shell_info['shell_type']}, "
            f"execution_type={shell_info['execution_type']}, "
            f"base_image={shell_info['base_image']}, "
            f"is_custom={shell_info['is_custom']}"
        )

        # Bot's shellRef directly points to the user-selected Shell
        # No need to create a dedicated shell for each bot
        # Use the shell's actual namespace (public shells are in 'default' namespace)
        shell_ref_name = obj_in.shell_name
        shell_ref_namespace = shell_info.get("namespace", "default")

        # Create Bot with shellRef pointing to the user-selected Shell
        bot_json = {
            "kind": "Bot",
            "spec": {
                "ghostRef": {"name": f"{obj_in.name}-ghost", "namespace": namespace},
                "shellRef": {"name": shell_ref_name, "namespace": shell_ref_namespace},
                "modelRef": {"name": model_ref_name, "namespace": model_ref_namespace},
            },
            "status": {"state": "Available"},
            "metadata": {"name": obj_in.name, "namespace": namespace},
            "apiVersion": "agent.wecode.io/v1",
        }

        bot = Kind(
            user_id=user_id,
            kind="Bot",
            name=obj_in.name,
            namespace=namespace,
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

        # Get the shell for response (from user's custom shells or public shells)
        shell = get_shell_by_name(db, shell_ref_name, user_id)

        # Return bot-like structure
        return self._convert_to_bot_dict(bot, ghost, shell, model, obj_in.agent_config)

    def query_bots_by_namespaces(
        self,
        db: Session,
        *,
        user_id: int,
        namespaces: List[str],
        skip: int = 0,
        limit: int = 100,
    ) -> List[Kind]:
        """
        Query bots from specified namespaces with namespace-specific logic.
        Public method that can be called by other services.

        Query logic:
        - If namespace='default': first query user_id==user_id, if not found then query user_id==0 (public)
        - If namespace!='default': query without user_id condition (group bots)

        Args:
            db: Database session
            user_id: User ID
            namespaces: List of namespaces to query
            skip: Number of records to skip
            limit: Maximum number of records to return

        Returns:
            List of Bot Kind objects
        """
        # Separate default and non-default namespaces
        default_namespaces = [ns for ns in namespaces if ns == "default"]
        group_namespaces = [ns for ns in namespaces if ns != "default"]

        bots = []

        # Query for default namespace: first try user_id==user_id, then user_id==0
        if default_namespaces:
            # First query: user's personal bots in default namespace
            user_bots = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .offset(skip)
                .limit(limit)
                .all()
            )

            if user_bots:
                bots.extend(user_bots)
            else:
                # If no user bots found, query public bots (user_id==0)
                public_bots = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Bot",
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                    .order_by(Kind.created_at.desc())
                    .offset(skip)
                    .limit(limit)
                    .all()
                )
                bots.extend(public_bots)

        # Query for group namespaces: no user_id condition
        if group_namespaces:
            group_bots = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Bot",
                    Kind.namespace.in_(group_namespaces),
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .offset(skip)
                .limit(limit)
                .all()
            )
            bots.extend(group_bots)

        return bots

    def get_user_bots(
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
        Get user's Bot list (only active bots)
        Optimization: avoid N+1 queries by batch-fetching Ghost/Shell/Model components to significantly reduce database round trips.

        Scope behavior:
        - scope='personal' (default): personal bots only (namespace='default')
        - scope='group': group bots (requires group_name or queries all user's groups)
        - scope='all': personal + all user's groups
        """
        from app.services.group_permission import get_user_groups

        # Determine which namespaces to query based on scope
        namespaces_to_query = []

        if scope == "personal":
            # Personal bots only (default namespace)
            namespaces_to_query = ["default"]
        elif scope == "group":
            # Group bots - if group_name not provided, query all user's groups
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

        # Handle empty namespaces case
        if not namespaces_to_query:
            return []

        # Use the extracted query method
        bots = self.query_bots_by_namespaces(
            db, user_id=user_id, namespaces=namespaces_to_query, skip=skip, limit=limit
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
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

        # Get related Ghost, Shell, Model (use bot.user_id for component queries)
        ghost, shell, model = self._get_bot_components(db, bot, bot.user_id)
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
                # Build dynamic filter conditions based on namespace
                filter_conditions = [
                    Kind.kind == "Bot",
                    Kind.name == new_name,
                    Kind.namespace == obj_in.namespace,
                    Kind.is_active == True,
                    Kind.id != bot.id,
                ]

                # Only add user_id filter for default namespace
                if obj_in.namespace == "default":
                    filter_conditions.append(Kind.user_id == user_id)

                conflict = db.query(Kind).filter(*filter_conditions).first()
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
            bot_crd = Bot.model_validate(bot.json)
            bot_crd.metadata.name = new_name
            bot.json = bot_crd.model_dump()
            flag_modified(bot, "json")  # Mark JSON field as modified
        if "shell_name" in update_data:
            # Update Bot's shellRef to point directly to the user-selected Shell
            new_shell_name = update_data["shell_name"]
            try:
                shell_info = get_shell_info_by_name(db, new_shell_name, user_id)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

            logger.info(
                f"[DEBUG] update_with_user: shell_name={new_shell_name}, "
                f"resolved shell_type={shell_info['shell_type']}, "
                f"execution_type={shell_info['execution_type']}, "
                f"base_image={shell_info['base_image']}, "
                f"is_custom={shell_info['is_custom']}, "
                f"namespace={shell_info.get('namespace', 'default')}"
            )

            # Update Bot's shellRef to point to the user-selected Shell
            # Use the shell's actual namespace (public shells are in 'default' namespace)
            bot_crd = Bot.model_validate(bot.json)
            bot_crd.spec.shellRef.name = new_shell_name
            bot_crd.spec.shellRef.namespace = shell_info.get("namespace", "default")
            bot.json = bot_crd.model_dump()
            flag_modified(bot, "json")

            # Update shell reference for response
            shell = get_shell_by_name(db, new_shell_name, user_id)

        if "agent_config" in update_data:
            new_agent_config = update_data["agent_config"]
            logger.info(f"[DEBUG] Updating agent_config: {new_agent_config}")

            if self._is_predefined_model(new_agent_config):
                # For predefined model, update bot's modelRef to point to the selected model
                model_name = self._get_model_name_from_config(new_agent_config)
                model_type = self._get_model_type_from_config(new_agent_config)
                # For public/user models, namespace should be 'default'
                # For group models, use the specified namespace or bot's namespace
                if model_type == "group":
                    model_namespace = (
                        self._get_model_namespace_from_config(new_agent_config)
                        or bot.namespace
                        or "default"
                    )
                else:
                    # public or user models use 'default' namespace
                    model_namespace = (
                        self._get_model_namespace_from_config(new_agent_config)
                        or "default"
                    )
                logger.info(
                    f"[DEBUG] Predefined model detected, updating modelRef to: {model_name}, type: {model_type}, namespace: {model_namespace}"
                )

                # Update bot's modelRef
                bot_crd = Bot.model_validate(bot.json)
                from app.schemas.kind import ModelRef

                if bot_crd.spec.modelRef:
                    bot_crd.spec.modelRef.name = model_name
                    bot_crd.spec.modelRef.namespace = model_namespace
                else:
                    # Create new modelRef if it doesn't exist
                    bot_crd.spec.modelRef = ModelRef(
                        name=model_name, namespace=model_namespace
                    )
                bot.json = bot_crd.model_dump()
                flag_modified(bot, "json")

                # Only delete old model if it's a user's private custom model (not public or predefined)
                # A private custom model must satisfy:
                # 1. It's a Kind object with user_id matching the bot's owner (not public model with user_id=0)
                # 2. It has the naming pattern "{bot.name}-model" (dedicated to this bot)
                # 3. It has isCustomConfig=True in the model spec
                if model and model.name != model_name:
                    # Check if it's a user's private model (not public)
                    is_user_model = isinstance(model, Kind) and model.user_id != 0
                    if is_user_model:
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
                    db, model_name, model_namespace, user_id, model_type
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
                    # 2. model is a public model (user_id=0, can't be modified)
                    # 3. model is a Kind but not dedicated to this bot (shared model)
                    logger.info("[DEBUG] Creating new private model for custom config")

                    # Use the bot's namespace for the custom model
                    bot_namespace = bot.namespace or "default"
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
                            "namespace": bot_namespace,
                        },
                        "apiVersion": "agent.wecode.io/v1",
                    }

                    model = Kind(
                        user_id=user_id,
                        kind="Model",
                        name=dedicated_model_name,
                        namespace=bot_namespace,
                        json=model_json,
                        is_active=True,
                    )
                    db.add(model)

                    # Update bot's modelRef to point to the new dedicated model
                    bot_crd = Bot.model_validate(bot.json)
                    from app.schemas.kind import ModelRef

                    if bot_crd.spec.modelRef:
                        bot_crd.spec.modelRef.name = dedicated_model_name
                        bot_crd.spec.modelRef.namespace = bot_namespace
                    else:
                        # Create new modelRef
                        bot_crd.spec.modelRef = ModelRef(
                            name=dedicated_model_name, namespace=bot_namespace
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
                self._validate_skills(db, skills, user_id, bot.namespace or "default")
            ghost_crd = Ghost.model_validate(ghost.json)
            ghost_crd.spec.skills = skills
            ghost.json = ghost_crd.model_dump()
            flag_modified(ghost, "json")
            db.add(ghost)

        if "preload_skills" in update_data and ghost:
            # Update preload_skills in Ghost CRD
            preload_skills = update_data["preload_skills"] or []
            ghost_crd = Ghost.model_validate(ghost.json)
            ghost_crd.spec.preload_skills = preload_skills
            ghost.json = ghost_crd.model_dump()
            flag_modified(ghost, "json")
            db.add(ghost)

        # Update timestamps
        bot.updated_at = datetime.now()
        if ghost:
            ghost.updated_at = datetime.now()
        # Note: shell is now a reference to user's custom shell or public shell,
        # we don't update its timestamp as it's not owned by this bot
        if model and hasattr(model, "updated_at"):
            model.updated_at = datetime.now()

        db.commit()
        db.refresh(bot)
        if ghost:
            db.refresh(ghost)
        # Note: shell may be a public shell (user_id=0) which doesn't need refresh
        if shell and isinstance(shell, Kind):
            db.refresh(shell)
        if model and hasattr(model, "id"):
            try:
                db.refresh(model)
            except (AttributeError, TypeError) as e:
                logger.debug("Model refresh skipped: %s", e)

        return self._convert_to_bot_dict(bot, ghost, shell, model, return_agent_config)

    def _get_teams_using_bot(
        self, db: Session, bot_name: str, bot_namespace: str, user_id: int
    ) -> List[Kind]:
        """
        Get all teams that reference this bot.

        Args:
            db: Database session
            bot_name: Bot name
            bot_namespace: Bot namespace
            user_id: User ID

        Returns:
            List of teams that reference this bot
        """
        teams = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id, Kind.kind == "Team", Kind.is_active == True
            )
            .all()
        )

        teams_using_bot = []
        for team in teams:
            team_crd = Team.model_validate(team.json)
            for member in team_crd.spec.members:
                if (
                    member.botRef.name == bot_name
                    and member.botRef.namespace == bot_namespace
                ):
                    teams_using_bot.append(team)
                    break

        return teams_using_bot

    def _get_running_tasks_for_teams(
        self, db: Session, teams: List[Kind]
    ) -> List[Dict[str, Any]]:
        """
        Get all running tasks for the given teams.

        Args:
            db: Database session
            teams: List of teams to check

        Returns:
            List of running task info dictionaries
        """
        from app.models.task import TaskResource
        from app.schemas.kind import Task

        if not teams:
            return []

        # Get all active tasks
        all_tasks = (
            db.query(TaskResource)
            .filter(TaskResource.kind == "Task", TaskResource.is_active == True)
            .all()
        )

        running_tasks = []
        for team in teams:
            team_name = team.name
            team_namespace = team.namespace

            for task in all_tasks:
                task_crd = Task.model_validate(task.json)
                if (
                    task_crd.spec.teamRef.name == team_name
                    and task_crd.spec.teamRef.namespace == team_namespace
                ):
                    if task_crd.status and task_crd.status.status in [
                        "PENDING",
                        "RUNNING",
                    ]:
                        running_tasks.append(
                            {
                                "task_id": task.id,
                                "task_name": task.name,
                                "task_title": task_crd.spec.title,
                                "status": task_crd.status.status,
                                "team_name": team_name,
                            }
                        )

        return running_tasks

    def check_running_tasks(
        self, db: Session, *, bot_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Check if a bot has any running tasks (through teams that use this bot).

        Args:
            db: Database session
            bot_id: Bot ID to check
            user_id: User ID

        Returns:
            Dictionary with has_running_tasks flag and list of running tasks
        """
        bot = (
            db.query(Kind)
            .filter(
                Kind.id == bot_id,
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

        bot_name = bot.name
        bot_namespace = bot.namespace

        # Get teams that use this bot
        teams_using_bot = self._get_teams_using_bot(
            db, bot_name, bot_namespace, user_id
        )

        # Get running tasks for those teams
        running_tasks = self._get_running_tasks_for_teams(db, teams_using_bot)

        return {
            "has_running_tasks": len(running_tasks) > 0,
            "running_tasks_count": len(running_tasks),
            "running_tasks": running_tasks,
        }

    def delete_with_user(
        self, db: Session, *, bot_id: int, user_id: int, force: bool = False
    ) -> None:
        """
        Delete user Bot and related components.

        Note: Shell is not deleted because it's now a reference to user's custom shell
        or public shell, not a dedicated shell for this bot.

        Args:
            db: Database session
            bot_id: Bot ID to delete
            user_id: User ID
            force: If True, force delete even if there are running tasks
        """
        bot = (
            db.query(Kind)
            .filter(
                Kind.id == bot_id,
                Kind.kind == "Bot",
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            raise HTTPException(status_code=404, detail="Bot not found")

        bot_name = bot.name
        bot_namespace = bot.namespace

        # Get teams that use this bot
        teams_using_bot = self._get_teams_using_bot(
            db, bot_name, bot_namespace, user_id
        )

        # Check for running tasks if not force delete
        if not force:
            running_tasks = self._get_running_tasks_for_teams(db, teams_using_bot)
            if running_tasks:
                raise HTTPException(
                    status_code=400,
                    detail=f"Bot '{bot_name}' has {len(running_tasks)} running task(s). Use force=true to delete anyway.",
                )

        # Check if bot is referenced in any team (still prevent delete if used in teams)
        if teams_using_bot and not force:
            team_names = [t.name for t in teams_using_bot]
            raise HTTPException(
                status_code=400,
                detail=f"Bot '{bot_name}' is being used in team(s): {', '.join(team_names)}. Please remove it from the team(s) first.",
            )

        # Get related components (only ghost needs to be deleted)
        ghost, shell, model = self._get_bot_components(db, bot, user_id)

        # Delete bot and ghost only
        # Shell is not deleted because it's a reference to user's custom shell or public shell
        db.delete(bot)
        if ghost:
            db.delete(ghost)
        # Note: shell is not deleted - it's a shared resource

        db.commit()

    def count_user_bots(
        self,
        db: Session,
        *,
        user_id: int,
        scope: str = "personal",
        group_name: Optional[str] = None,
    ) -> int:
        """
        Count user's active bots based on scope.

        Scope behavior:
        - scope='personal' (default): personal bots only
        - scope='group': group bots (requires group_name or counts all user's groups)
        - scope='all': personal + all user's groups
        """
        from app.services.group_permission import get_user_groups

        # Determine which namespaces to count based on scope
        namespaces_to_count = []

        if scope == "personal":
            namespaces_to_count = ["default"]
        elif scope == "group":
            # Group bots - if group_name not provided, count all user's groups
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

        # Handle empty namespaces case
        if not namespaces_to_count:
            return 0

        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.namespace.in_(namespaces_to_count),
                Kind.is_active == True,
            )
            .count()
        )

    def _get_bot_components(self, db: Session, bot: Kind, user_id: int):
        """
        Get Ghost, Shell, Model components for a bot.
        Model can be from kinds table (private) or public_models table.

        For group resources (namespace != 'default'), components are queried without
        user_id filter since they may be created by different users in the same group.
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

        # Determine if this is a group resource
        is_group_resource = bot.namespace and bot.namespace != "default"

        # Get ghost - for group resources, don't filter by user_id
        ghost_query = db.query(Kind).filter(
            Kind.kind == "Ghost",
            Kind.name == bot_crd.spec.ghostRef.name,
            Kind.namespace == bot_crd.spec.ghostRef.namespace,
            Kind.is_active == True,
        )
        if not is_group_resource:
            ghost_query = ghost_query.filter(Kind.user_id == user_id)
        ghost = ghost_query.first()

        # Get shell - try user's custom shells first, then public shells
        shell_ref_name = bot_crd.spec.shellRef.name
        shell = get_shell_by_name(db, shell_ref_name, user_id)

        logger.info(
            f"[DEBUG] _get_bot_components: shellRef.name={shell_ref_name}, "
            f"shell found={shell is not None}, "
            f"shell type={type(shell).__name__ if shell else 'None'}"
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

        For group resources (namespace != 'default'), components are queried without
        user_id filter since they may be created by different users in the same group.

        Returns:
          - bot_crds: {bot.id: Bot} mapping to avoid repeated parsing
          - ghost_map: {(name, namespace): Kind}
          - shell_map: {(name, namespace): Kind}
          - model_map: {(name, namespace): Kind}
        """
        if not bots:
            return {}, {}, {}, {}

        # Separate keys for personal and group resources
        personal_ghost_keys = set()
        group_ghost_keys = set()
        personal_model_keys = set()
        group_model_keys = set()
        shell_keys = set()
        bot_crds = {}

        for bot in bots:
            # Parse bot.json once and reuse later
            bot_crd = Bot.model_validate(bot.json)
            bot_crds[bot.id] = bot_crd

            is_group_resource = bot.namespace and bot.namespace != "default"
            ghost_key = (bot_crd.spec.ghostRef.name, bot_crd.spec.ghostRef.namespace)

            if is_group_resource:
                group_ghost_keys.add(ghost_key)
            else:
                personal_ghost_keys.add(ghost_key)

            shell_keys.add(
                (bot_crd.spec.shellRef.name, bot_crd.spec.shellRef.namespace)
            )
            # modelRef is optional, only add if it exists
            if bot_crd.spec.modelRef:
                model_key = (
                    bot_crd.spec.modelRef.name,
                    bot_crd.spec.modelRef.namespace,
                )
                if is_group_resource:
                    group_model_keys.add(model_key)
                else:
                    personal_model_keys.add(model_key)

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

        ghosts = []
        models = []

        # Query personal ghosts (with user_id filter)
        if personal_ghost_keys:
            personal_ghost_filter = build_or_filters("Ghost", personal_ghost_keys)
            if personal_ghost_filter is not None:
                personal_ghosts = (
                    db.query(Kind)
                    .filter(Kind.user_id == user_id, Kind.is_active == True)
                    .filter(personal_ghost_filter)
                    .all()
                )
                ghosts.extend(personal_ghosts)

        # Query group ghosts (without user_id filter)
        if group_ghost_keys:
            group_ghost_filter = build_or_filters("Ghost", group_ghost_keys)
            if group_ghost_filter is not None:
                group_ghosts = (
                    db.query(Kind)
                    .filter(Kind.is_active == True)
                    .filter(group_ghost_filter)
                    .all()
                )
                ghosts.extend(group_ghosts)

        # Use unified shell query function that checks both user shells and public shells
        shell_map = get_shells_by_names_batch(db, shell_keys, user_id)

        # Query personal models (with user_id filter)
        if personal_model_keys:
            personal_model_filter = build_or_filters("Model", personal_model_keys)
            if personal_model_filter is not None:
                personal_models = (
                    db.query(Kind)
                    .filter(Kind.user_id == user_id, Kind.is_active == True)
                    .filter(personal_model_filter)
                    .all()
                )
                models.extend(personal_models)

        # Query group models (without user_id filter)
        if group_model_keys:
            group_model_filter = build_or_filters("Model", group_model_keys)
            if group_model_filter is not None:
                group_models = (
                    db.query(Kind)
                    .filter(Kind.is_active == True)
                    .filter(group_model_filter)
                    .all()
                )
                models.extend(group_models)

        ghost_map = {(g.name, g.namespace): g for g in ghosts}
        # shell_map is already populated by get_shells_by_names_batch
        model_map = {(m.name, m.namespace): m for m in models}

        # For models not found in kinds table (user models), try to find in public models (user_id=0)
        all_model_keys = personal_model_keys | group_model_keys
        missing_model_keys = all_model_keys - set(model_map.keys())
        if missing_model_keys:

            def build_public_model_or_filters(keys: set):
                return (
                    or_(
                        *[
                            and_(
                                Kind.user_id == 0,
                                Kind.kind == "Model",
                                Kind.name == n,
                                Kind.namespace == ns,
                            )
                            for (n, ns) in keys
                        ]
                    )
                    if keys
                    else None
                )

            public_model_filter = build_public_model_or_filters(missing_model_keys)
            if public_model_filter is not None:
                public_models = (
                    db.query(Kind)
                    .filter(Kind.is_active.is_(True))
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
            model: The Model object - always a Kind (for both private and public models)
            override_agent_config: If provided, use this instead of extracting from model.
                                   Used for predefined models where we want to return { bind_model: "xxx" }
        """
        import logging

        logger = logging.getLogger(__name__)

        # Extract data from components
        system_prompt = ""
        mcp_servers = {}
        shell_type = ""
        shell_name = ""
        agent_config = {}

        # Get shell_name from bot's shellRef - this is the name user selected
        bot_crd = Bot.model_validate(bot.json)
        shell_name = bot_crd.spec.shellRef.name if bot_crd.spec.shellRef else ""

        if ghost and ghost.json:
            ghost_crd = Ghost.model_validate(ghost.json)
            system_prompt = ghost_crd.spec.systemPrompt
            mcp_servers = ghost_crd.spec.mcpServers or {}

        if shell and shell.json:
            shell_crd = Shell.model_validate(shell.json)
            shell_type = shell_crd.spec.shellType or ""

        # Determine agent_config
        # For frontend display, we need to return { bind_model: "xxx", bind_model_type: "public"|"user" } format when:
        # 1. override_agent_config is provided (explicit override)
        # 2. The model is a public model (Kind with user_id=0)
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

            # Get the modelRef name and namespace from bot to determine if it's a dedicated private model
            bot_crd = Bot.model_validate(bot.json)
            model_ref_name = (
                bot_crd.spec.modelRef.name if bot_crd.spec.modelRef else None
            )
            model_ref_namespace = (
                bot_crd.spec.modelRef.namespace if bot_crd.spec.modelRef else "default"
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

            if model.user_id == 0:
                # This is a public model (user_id=0), return bind_model format with type
                agent_config = {
                    "bind_model": model.name,
                    "bind_model_type": "public",  # Identify as public model
                }
                # Include namespace if not default
                if model_ref_namespace and model_ref_namespace != "default":
                    agent_config["bind_model_namespace"] = model_ref_namespace
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Public model, returning bind_model format: {agent_config}"
                )
            elif not is_dedicated_private_model:
                # This is a shared/predefined model (not dedicated to this bot)
                # Return bind_model format with type so frontend can display the dropdown
                # Determine model type: 'group' for group models, 'user' for personal models
                model_type = (
                    "group"
                    if model_ref_namespace and model_ref_namespace != "default"
                    else "user"
                )
                agent_config = {
                    "bind_model": model_ref_name,
                    "bind_model_type": model_type,
                }
                # Include namespace if not default
                if model_ref_namespace and model_ref_namespace != "default":
                    agent_config["bind_model_namespace"] = model_ref_namespace
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
                # Determine model type: 'group' for group models, 'user' for personal models
                model_type = (
                    "group"
                    if model_ref_namespace and model_ref_namespace != "default"
                    else "user"
                )
                agent_config = {
                    "bind_model": model_ref_name,
                    "bind_model_type": model_type,
                }
                # Include namespace if not default
                if model_ref_namespace and model_ref_namespace != "default":
                    agent_config["bind_model_namespace"] = model_ref_namespace
                logger.info(
                    f"[DEBUG] _convert_to_bot_dict: Dedicated model without isCustomConfig, returning bind_model format: {agent_config}"
                )

        # Extract skills and preload_skills from ghost
        skills = []
        preload_skills = []
        if ghost:
            ghost_crd = Ghost.model_validate(ghost.json)
            skills = ghost_crd.spec.skills or []
            preload_skills = ghost_crd.spec.preload_skills or []

        return {
            "id": bot.id,
            "user_id": bot.user_id,
            "name": bot.name,
            "namespace": bot.namespace,  # Namespace for group bots (default: 'default')
            "shell_name": shell_name,  # The shell name user selected (e.g., 'ClaudeCode', 'my-custom-shell')
            "shell_type": shell_type,  # The actual agent type (e.g., 'ClaudeCode', 'Agno', 'Dify')
            "agent_config": agent_config,
            "system_prompt": system_prompt,
            "mcp_servers": mcp_servers,
            "skills": skills,
            "preload_skills": preload_skills,
            "is_active": bot.is_active,
            "created_at": bot.created_at,
            "updated_at": bot.updated_at,
        }

    def _validate_skills(
        self,
        db: Session,
        skill_names: List[str],
        user_id: int,
        namespace: str = "default",
    ) -> None:
        """
        Validate that all skill names exist for the user or as system skills.

        Search order (consistent with /api/v1/kinds/skills/unified):
        1. User's personal skills (user_id=user_id, namespace='default')
        2. Group skills in namespace (any user, if namespace != 'default')
        3. Public/system skills (user_id=0, namespace='default')

        Args:
            db: Database session
            skill_names: List of skill names to validate
            user_id: User ID
            namespace: Bot's namespace (for group skills lookup)

        Raises:
            HTTPException: If any skill does not exist
        """
        if not skill_names:
            return

        existing_skill_names = set()

        # 1. Query user's personal skills (user_id=user_id, namespace='default')
        personal_skills = (
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
        existing_skill_names.update(skill.name for skill in personal_skills)

        # 2. Query group skills if namespace is not 'default'
        # Group skills can be from any user in that namespace
        if namespace != "default":
            remaining_names = [
                name for name in skill_names if name not in existing_skill_names
            ]
            if remaining_names:
                group_skills = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Skill",
                        Kind.name.in_(remaining_names),
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .all()
                )
                existing_skill_names.update(skill.name for skill in group_skills)

        # 3. Query public/system skills (user_id=0)
        remaining_names = [
            name for name in skill_names if name not in existing_skill_names
        ]
        if remaining_names:
            public_skills = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Skill",
                    Kind.name.in_(remaining_names),
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .all()
            )
            existing_skill_names.update(skill.name for skill in public_skills)

        missing_skills = [
            name for name in skill_names if name not in existing_skill_names
        ]

        if missing_skills:
            raise HTTPException(
                status_code=400,
                detail=f"The following Skills do not exist: {', '.join(missing_skills)}",
            )


bot_kinds_service = BotKindsService(Kind)

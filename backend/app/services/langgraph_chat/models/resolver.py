# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model resolver for LangGraph Chat Service.

This module provides database-based model resolution functionality,
reusing the existing model_resolver from the chat service.
"""

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot

logger = logging.getLogger(__name__)


class ModelResolver:
    """Resolver for model configuration from database."""

    @staticmethod
    def get_model_config_for_bot(
        db: Session,
        bot: Kind,
        user_id: int,
        user_name: str,
        override_model_name: str | None = None,
        force_override: bool = False,
        agent_config: dict[str, Any] | None = None,
        task_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Get fully processed model configuration for a Bot.

        This method wraps the existing model_resolver functionality,
        combining model lookup and placeholder processing.

        Args:
            db: Database session
            bot: The Bot Kind object
            user_id: User ID for querying user-specific models
            user_name: Username for placeholder resolution
            override_model_name: Optional model name to override
            force_override: If True, override_model_name takes highest priority
            agent_config: Optional agent config from bot
            task_data: Optional task data for placeholder resolution

        Returns:
            Dict containing fully processed model configuration:
            {
                "api_key": "sk-xxx",
                "base_url": "https://api.openai.com/v1",
                "model_id": "gpt-4",
                "model": "openai",
                "default_headers": {...}
            }

        Raises:
            ValueError: If no model is configured or model not found
        """
        from app.services.chat.model_resolver import (
            _extract_model_config,
            _find_model,
            _process_model_config_placeholders,
        )

        bot_crd = Bot.model_validate(bot.json)
        model_name = None

        # Priority 1: Force override from task
        if force_override and override_model_name:
            model_name = override_model_name
            logger.info(f"Using task model (force override): {model_name}")
        else:
            # Priority 2: Bot's agent_config.bind_model
            bot_json = bot.json or {}
            spec = bot_json.get("spec", {})
            bot_agent_config = spec.get("agent_config", {})
            bind_model = bot_agent_config.get("bind_model")

            if bind_model and isinstance(bind_model, str) and bind_model.strip():
                model_name = bind_model.strip()
                logger.info(f"Using bot bound model: {model_name}")

            # Priority 3: Bot's modelRef (legacy)
            if not model_name and bot_crd.spec.modelRef:
                model_name = bot_crd.spec.modelRef.name
                logger.info(f"Using bot modelRef: {model_name}")

            # Priority 4: Task-level override (fallback)
            if not model_name and override_model_name:
                model_name = override_model_name
                logger.info(f"Using task model (fallback): {model_name}")

        if not model_name:
            raise ValueError(f"Bot {bot.name} has no model configured")

        # Find the model
        model_spec = _find_model(db, model_name, user_id)
        if not model_spec:
            raise ValueError(f"Model {model_name} not found")

        # Extract basic model config
        model_config = _extract_model_config(model_spec)

        # Process placeholders if agent_config or task_data provided
        if agent_config or task_data:
            model_config = _process_model_config_placeholders(
                model_config=model_config,
                user_id=user_id,
                user_name=user_name,
                agent_config=agent_config,
                task_data=task_data,
            )

        return model_config

    @staticmethod
    def get_system_prompt_for_bot(
        db: Session,
        bot: Kind,
        user_id: int,
        team_member_prompt: str | None = None,
    ) -> str:
        """
        Get the system prompt for a Bot.

        Combines Ghost's system prompt with team member's additional prompt.

        Args:
            db: Database session
            bot: The Bot Kind object
            user_id: User ID (for Ghost lookup)
            team_member_prompt: Optional additional prompt from team member config

        Returns:
            Combined system prompt string
        """
        from app.services.chat.model_resolver import get_bot_system_prompt

        return get_bot_system_prompt(db, bot, user_id, team_member_prompt)

    @staticmethod
    def find_model_by_name(
        db: Session,
        model_name: str,
        user_id: int,
    ) -> dict[str, Any] | None:
        """
        Find a model by name.

        Search order:
        1. User's private models
        2. Public models

        Args:
            db: Database session
            model_name: Model name to find
            user_id: User ID for private model lookup

        Returns:
            Model spec dictionary or None if not found
        """
        from app.services.chat.model_resolver import _find_model

        return _find_model(db, model_name, user_id)

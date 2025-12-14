# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Model resolver for Chat Shell.

Resolves model configuration from Bot's bound model or task-level override.
"""

import json
import logging
import os
import re
from typing import Any, Dict, Optional

from shared.utils.crypto import decrypt_api_key
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.schemas.kind import Bot, Model

logger = logging.getLogger(__name__)


def resolve_env_placeholder(value: str) -> str:
    """
    Resolve environment variable placeholders in a string.

    Supports format: ${ENV_VAR_NAME}

    Args:
        value: String that may contain environment variable placeholders

    Returns:
        String with placeholders replaced by environment variable values
    """
    if not value or not isinstance(value, str):
        return value

    # Pattern to match ${ENV_VAR_NAME}
    pattern = r"\$\{([^}]+)\}"

    def replace_env(match):
        env_var = match.group(1)
        env_value = os.environ.get(env_var, "")
        if env_value:
            logger.info(
                f"[model_resolver] Resolved env var ${{{env_var}}} to value (length={len(env_value)})"
            )
        else:
            logger.warning(
                f"[model_resolver] Env var ${{{env_var}}} not found or empty"
            )
        return env_value

    return re.sub(pattern, replace_env, value)


def resolve_value_from_source(
    data_sources: Dict[str, Dict[str, Any]], source_spec: str
) -> str:
    """
    Resolve value from specified data source using flexible notation.

    This is a port of the executor's config_utils.resolve_value_from_source function.

    Args:
        data_sources: Dictionary containing all available data sources
        source_spec: Source specification in format "source_name.path" or just "path"

    Returns:
        The resolved value or empty string if not found
    """
    try:
        # Parse source specification
        if "." in source_spec:
            # Format: "source_name.path"
            parts = source_spec.split(".", 1)
            source_name = parts[0]
            path = parts[1]
        else:
            # Format: just "path", use default source
            source_name = "agent_config"
            path = source_spec

        # Get the specified data source
        if source_name not in data_sources:
            return ""

        data = data_sources[source_name]

        # Navigate the path
        keys = path.split(".")
        current = data

        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif (
                isinstance(current, list) and key.isdigit() and int(key) < len(current)
            ):
                current = current[int(key)]
            else:
                return ""

        return str(current) if current is not None else ""
    except Exception:
        return ""


def replace_placeholders_with_sources(
    template: str, data_sources: Dict[str, Dict[str, Any]]
) -> str:
    """
    Replace placeholders in template with values from multiple data sources.

    This is a port of the executor's config_utils.replace_placeholders_with_sources function.

    Args:
        template: The template string with placeholders like ${agent_config.env.user} or ${env.user}
        data_sources: Dictionary containing all available data sources

    Returns:
        The template with placeholders replaced with actual values
    """
    # Find all placeholders in format ${source_spec}
    pattern = r"\$\{([^}]+)\}"

    def replace_match(match):
        source_spec = match.group(1)
        value = resolve_value_from_source(data_sources, source_spec)
        return value

    return re.sub(pattern, replace_match, template)


def get_default_headers_from_env() -> Dict[str, Any]:
    """
    Get DEFAULT_HEADERS from environment variable.

    This mirrors the executor's ConfigManager._parse_default_headers method.
    Reads from EXECUTOR_ENV or DEFAULT_HEADERS environment variable.

    Returns:
        Parsed default headers dictionary
    """
    default_headers = {}

    try:
        # First try EXECUTOR_ENV (JSON format)
        executor_env_str = os.environ.get("EXECUTOR_ENV", "")
        if executor_env_str:
            try:
                executor_env = json.loads(executor_env_str)
                if isinstance(executor_env, dict):
                    dh = executor_env.get("DEFAULT_HEADERS")
                    if dh:
                        if isinstance(dh, dict):
                            default_headers = dh
                        elif isinstance(dh, str):
                            default_headers = json.loads(dh)
                        logger.info(
                            f"[model_resolver] Loaded DEFAULT_HEADERS from EXECUTOR_ENV: keys={list(default_headers.keys())}"
                        )
            except json.JSONDecodeError as e:
                logger.warning(f"[model_resolver] Failed to parse EXECUTOR_ENV: {e}")

        # Fallback to DEFAULT_HEADERS env var
        if not default_headers:
            dh_str = os.environ.get("DEFAULT_HEADERS", "")
            if dh_str:
                try:
                    default_headers = json.loads(dh_str)
                    logger.info(
                        f"[model_resolver] Loaded DEFAULT_HEADERS from env: keys={list(default_headers.keys())}"
                    )
                except json.JSONDecodeError as e:
                    logger.warning(
                        f"[model_resolver] Failed to parse DEFAULT_HEADERS env: {e}"
                    )
    except Exception as e:
        logger.warning(f"[model_resolver] Failed to load DEFAULT_HEADERS from env: {e}")

    return default_headers


def build_default_headers_with_placeholders(
    default_headers: Dict[str, Any], data_sources: Dict[str, Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Build default headers with placeholder replacement.

    This is a port of the executor's ConfigManager.build_default_headers_with_placeholders method.

    Args:
        default_headers: Raw default headers dictionary (may contain placeholders)
        data_sources: Dictionary containing all available data sources

    Returns:
        Default headers with placeholders replaced
    """
    result_headers = {}
    try:
        # Apply placeholder replacement on individual string values inside the dict
        for k, v in default_headers.items():
            if isinstance(v, str):
                result_headers[k] = replace_placeholders_with_sources(v, data_sources)
            else:
                result_headers[k] = v
        logger.info(
            f"Built default_headers with placeholders: keys={list(result_headers.keys())}"
        )
    except Exception as e:
        logger.warning(
            f"Failed to build default headers; proceeding without. Error: {e}"
        )
        result_headers = {}

    return result_headers


def get_model_config_for_bot(
    db: Session,
    bot: Kind,
    user_id: int,
    override_model_name: Optional[str] = None,
    force_override: bool = False,
) -> Dict[str, Any]:
    """
    Get model configuration for a Bot.

    Resolution priority:
    1. override_model_name with force_override=True (task-level override)
    2. bot.spec.agent_config.bind_model (bot-level binding)
    3. bot.spec.modelRef (legacy reference)
    4. override_model_name without force_override (fallback)

    Args:
        db: Database session
        bot: The Bot Kind object
        user_id: User ID for querying user-specific models
        override_model_name: Optional model name to override
        force_override: If True, override_model_name takes highest priority

    Returns:
        Dict containing model configuration:
        {
            "api_key": "sk-xxx",
            "base_url": "https://api.openai.com/v1",
            "model_id": "gpt-4",
            "model": "openai"  # or "claude"
        }

    Raises:
        ValueError: If no model is configured or model not found
    """
    bot_crd = Bot.model_validate(bot.json)
    model_name = None

    # Priority 1: Force override from task
    if force_override and override_model_name:
        model_name = override_model_name
        logger.info(f"Using task model (force override): {model_name}")
    else:
        # Priority 2: Bot's agent_config.bind_model
        # Note: Bot CRD doesn't have agent_config directly, check if it's in the JSON
        bot_json = bot.json or {}
        spec = bot_json.get("spec", {})
        agent_config = spec.get("agent_config", {})
        bind_model = agent_config.get("bind_model")

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

    # Extract and return configuration
    return _extract_model_config(model_spec)


def _find_model(db: Session, model_name: str, user_id: int) -> Optional[Dict[str, Any]]:
    """
    Find model by name.

    Search order:
    1. User's private models (kinds table)
    2. Public models (kinds table with user_id=0)

    Args:
        db: Database session
        model_name: Model name to find
        user_id: User ID for private model lookup

    Returns:
        Model spec dictionary or None if not found
    """
    # Search user's private models first
    user_model = (
        db.query(Kind)
        .filter(
            Kind.kind == "Model",
            Kind.user_id == user_id,
            Kind.name == model_name,
            Kind.is_active == True,
        )
        .first()
    )

    if user_model and user_model.json:
        logger.info(f"Found model '{model_name}' in user's private models")
        return user_model.json.get("spec", {})

    # Search public models
    public_model = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.name == model_name,
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .first()
    )

    if public_model and public_model.json:
        logger.info(f"Found model '{model_name}' in public models")
        return public_model.json.get("spec", {})

    logger.warning(f"Model '{model_name}' not found in any source")
    return None


def _extract_model_config(model_spec: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract API configuration from model spec.

    Args:
        model_spec: Model specification dictionary

    Returns:
        Dict with api_key, base_url, model_id, model type, and default_headers
    """
    logger.info(
        f"[model_resolver] _extract_model_config: model_spec keys = {list(model_spec.keys())}"
    )

    model_config = model_spec.get("modelConfig", {})
    logger.info(
        f"[model_resolver] _extract_model_config: modelConfig keys = {list(model_config.keys()) if model_config else 'empty'}"
    )

    env = model_config.get("env", {})
    logger.info(
        f"[model_resolver] _extract_model_config: env keys = {list(env.keys()) if env else 'empty'}"
    )

    # Get raw values with defaults
    api_key = env.get("api_key", "")
    base_url = env.get("base_url", "https://api.openai.com/v1")
    model_id = env.get("model_id", "gpt-4")
    model_type = env.get("model", "openai")

    # Resolve environment variable placeholders in api_key
    # This handles cases like api_key="${WECODE_API_KEY}"
    if api_key and "${" in api_key:
        logger.info(
            f"[model_resolver] api_key contains placeholder, resolving from env..."
        )
        api_key = resolve_env_placeholder(api_key)

    # Get DEFAULT_HEADERS - first from modelConfig, then from env, then from environment variable
    default_headers = model_config.get("DEFAULT_HEADERS", {})
    if not default_headers:
        # Also check env for backward compatibility
        default_headers = env.get("DEFAULT_HEADERS", {})

    if not default_headers:
        # settings.EXECUTOR_ENV is a JSON string, need to parse it first
        try:
            executor_env = (
                json.loads(settings.EXECUTOR_ENV) if settings.EXECUTOR_ENV else {}
            )
            default_headers = executor_env.get("DEFAULT_HEADERS", {})
        except (json.JSONDecodeError, TypeError):
            logger.warning(
                f"[model_resolver] Failed to parse settings.EXECUTOR_ENV as JSON"
            )
            default_headers = {}

    # If still empty, try to get from environment variable (EXECUTOR_ENV or DEFAULT_HEADERS)
    if not default_headers:
        default_headers = get_default_headers_from_env()

    # If default_headers is a string, try to parse it as JSON
    if isinstance(default_headers, str):
        try:
            default_headers = json.loads(default_headers)
        except Exception:
            logger.warning(
                f"Failed to parse DEFAULT_HEADERS as JSON: {default_headers}"
            )
            default_headers = {}

    logger.info(
        f"[model_resolver] _extract_model_config: DEFAULT_HEADERS keys = {list(default_headers.keys()) if default_headers else 'empty'}"
    )

    # Log extracted values (mask API key)
    masked_key = (
        f"{api_key[:8]}...{api_key[-4:]}"
        if api_key and len(api_key) > 12
        else ("***" if api_key else "EMPTY")
    )
    logger.info(
        f"[model_resolver] _extract_model_config: api_key={masked_key}, base_url={base_url}, model_id={model_id}, model_type={model_type}"
    )

    # Decrypt API key if encrypted (only if it doesn't look like a placeholder)
    if api_key and "${" not in api_key:
        try:
            decrypted_key = decrypt_api_key(api_key)
            masked_decrypted = (
                f"{decrypted_key[:8]}...{decrypted_key[-4:]}"
                if decrypted_key and len(decrypted_key) > 12
                else ("***" if decrypted_key else "EMPTY")
            )
            logger.info(
                f"[model_resolver] _extract_model_config: decrypted api_key={masked_decrypted}"
            )
            api_key = decrypted_key
        except Exception as e:
            logger.warning(f"Failed to decrypt API key, using as-is: {e}")

    return {
        "api_key": api_key,
        "base_url": base_url,
        "model_id": model_id,
        "model": model_type,
        "default_headers": default_headers,
    }


def get_bot_system_prompt(
    db: Session, bot: Kind, user_id: int, team_member_prompt: Optional[str] = None
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
    from app.schemas.kind import Ghost

    bot_crd = Bot.model_validate(bot.json)
    system_prompt = ""

    # Get Ghost for system prompt
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

    if ghost and ghost.json:
        ghost_crd = Ghost.model_validate(ghost.json)
        system_prompt = ghost_crd.spec.systemPrompt or ""

    # Append team member prompt if provided
    if team_member_prompt:
        if system_prompt:
            system_prompt = f"{system_prompt}\n\n{team_member_prompt}"
        else:
            system_prompt = team_member_prompt

    return system_prompt

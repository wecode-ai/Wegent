#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import os
import re
from copy import deepcopy
from typing import Any, Dict

from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.utils.sensitive_data_masker import mask_sensitive_data
from shared.utils.task_identity import build_task_identity_context

logger = setup_logger("agno_config_utils")


def parse_source_spec(source_spec: str) -> tuple[str, str]:
    """
    Parse source specification into source name and path.

    Args:
        source_spec: Source specification in format "source_name.path" or just "path"

    Returns:
        Tuple of (source_name, path)
    """
    if "." in source_spec:
        # Format: "source_name.path"
        parts = source_spec.split(".", 1)
        return parts[0], parts[1]
    else:
        # Format: just "path", use default source
        return "agent_config", source_spec


def object_to_mapping(obj: Any) -> dict[str, Any] | None:
    """
    Try to convert object to dict using model_dump, dict, or to_dict methods.

    Args:
        obj: Object to convert

    Returns:
        Dict if conversion successful, None otherwise
    """
    if callable(getattr(obj, "model_dump", None)):
        result = obj.model_dump()
        if isinstance(result, dict):
            return result
    if callable(getattr(obj, "dict", None)):
        result = obj.dict()
        if isinstance(result, dict):
            return result
    if callable(getattr(obj, "to_dict", None)):
        result = obj.to_dict()
        if isinstance(result, dict):
            return result
    return None


def resolve_path_step(current: Any, key: str) -> Any:
    """
    Resolve one step of the path navigation.

    Handles dict lookup, list index, attribute access, or object_to_mapping fallback.

    Args:
        current: Current object being navigated
        key: The key to resolve

    Returns:
        The resolved value, or raises exception if not found

    Raises:
        KeyError: If key not found in dict after trying object conversion
        AttributeError: If attribute access fails
        IndexError: If list index out of range
    """
    # Dict lookup
    if isinstance(current, dict) and key in current:
        return current[key]

    # List index lookup
    if isinstance(current, list) and key.isdigit() and int(key) < len(current):
        return current[int(key)]

    # Object attribute access (only for non-container objects)
    if not isinstance(current, (dict, list)) and hasattr(current, key):
        attr_value = getattr(current, key)
        if callable(attr_value):
            # Don't access callable methods (e.g., dict.items, list.append)
            raise AttributeError("callable")
        return attr_value

    # Try to convert object to dict and lookup
    dict_from_object = object_to_mapping(current)
    if dict_from_object is not None and key in dict_from_object:
        return dict_from_object[key]

    # Not found
    raise KeyError("not_found")


def resolve_value_from_source(data_sources: Dict[str, Any], source_spec: str) -> str:
    """
    Resolve value from specified data source using flexible notation

    Args:
        data_sources: Dictionary containing all available data sources
        source_spec: Source specification in format "source_name.path" or just "path"

    Returns:
        The resolved value or empty string if not found
    """
    try:
        # Parse source specification
        source_name, path = parse_source_spec(source_spec)

        # Get the specified data source
        if source_name not in data_sources:
            return ""

        data = data_sources[source_name]

        # Navigate the path
        keys = path.split(".")
        current = data

        for key in keys:
            current = resolve_path_step(current, key)

        return str(current) if current is not None else ""
    except (AttributeError, TypeError, KeyError, ValueError, IndexError):
        return ""


def replace_placeholders_with_sources(
    template: str, data_sources: Dict[str, Any]
) -> str:
    """
    Replace placeholders in template with values from multiple data sources

    Args:
        template: The template string with placeholders like ${agent_config.env.user} or ${env.user}
        data_sources: Dictionary containing all available data sources

    Returns:
        The template with placeholders replaced with actual values
    """
    # Find all placeholders in format ${source_spec}
    pattern = r"\$\{([^}]+)\}"

    logger.info(f"data_sources keys:{list(data_sources.keys())}")
    logger.debug(f"template:{mask_sensitive_data(template)}")

    def replace_match(match):
        source_spec = match.group(1)
        value = resolve_value_from_source(data_sources, source_spec)
        return value

    return re.sub(pattern, replace_match, template)


class ConfigManager:
    """
    Manages configuration parsing and processing for Agno Agent
    """

    def __init__(self, executor_env=None):
        """
        Initialize the configuration manager

        Args:
            executor_env: The executor environment configuration
        """
        self.executor_env = self._parse_executor_env(executor_env)
        self.default_headers = self._parse_default_headers()

    def _parse_executor_env(self, executor_env) -> Dict[str, Any]:
        """
        Parse EXECUTOR_ENV which might be a JSON string or dict-like

        Args:
            executor_env: The executor environment configuration

        Returns:
            Parsed executor environment as dictionary
        """
        try:
            if isinstance(executor_env, str):
                env_raw = executor_env.strip()
            else:
                # Fall back to JSON-dumping if it's already a dict-like
                env_raw = json.dumps(executor_env)
            return json.loads(env_raw) if env_raw else {}
        except Exception as e:
            logger.warning(
                f"Failed to parse EXECUTOR_ENV; using empty dict. Error: {e}"
            )
            return {}

    def _parse_default_headers(self) -> Dict[str, Any]:
        """
        Parse DEFAULT_HEADERS from executor environment or OS environment

        Returns:
            Parsed default headers as dictionary
        """
        default_headers = {}
        self._default_headers_raw_str = (
            None  # keep raw string for placeholder replacement later
        )

        try:
            dh = None
            logger.info(f"EXECUTOR_ENV: {self.executor_env}")

            if isinstance(self.executor_env, dict):
                dh = self.executor_env.get("DEFAULT_HEADERS")

            if not dh:
                dh = os.environ.get("DEFAULT_HEADERS")

            if isinstance(dh, dict):
                default_headers = dh
            elif isinstance(dh, str):
                raw = dh.strip()
                self._default_headers_raw_str = raw or None
                if raw:
                    try:
                        # try parsing as JSON string first
                        default_headers = json.loads(raw)
                    except Exception:
                        # if it isn't JSON, we'll keep raw for later placeholder expansion
                        default_headers = {}
        except Exception as e:
            logger.warning(
                f"Failed to load DEFAULT_HEADERS; using empty headers. Error: {e}"
            )
            default_headers = {}

        return default_headers

    def build_default_headers_with_placeholders(
        self, data_sources: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Build default headers with placeholder replacement

        Args:
            data_sources: Dictionary containing all available data sources

        Returns:
            Default headers with placeholders replaced
        """
        default_headers = {}
        try:
            # Apply placeholder replacement on individual string values inside the dict
            replaced = {}
            for k, v in self.default_headers.items():
                if isinstance(v, str):
                    replaced[k] = replace_placeholders_with_sources(v, data_sources)
                else:
                    replaced[k] = v
            default_headers = replaced
            logger.info(f"default_headers:{default_headers}")
        except Exception as e:
            logger.warning(
                f"Failed to build default headers; proceeding without. Error: {e}"
            )
            default_headers = {}

        return default_headers

    def extract_agno_options(self, task_data: ExecutionRequest) -> Dict[str, Any]:
        """
        Extract Agno options from task data
        Collects all non-None configuration parameters from task_data

        Args:
            task_data: The task data ExecutionRequest

        Returns:
            Dict containing valid Agno options
        """
        # List of valid options for Agno
        valid_options = [
            "model",
            "model_id",
            "api_key",
            "system_prompt",
            "tools",
            "mcp_servers",
            "mcpServers",
            "team_members",
            "team_description",
            "stream",
        ]

        # Collect all non-None configuration parameters
        options = {}
        bot_config = task_data.bot

        # Handle both single bot object and bot array
        if bot_config and isinstance(bot_config, dict):
            # Handle single bot object
            logger.info("Found single bot configuration")
            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]
        elif bot_config and isinstance(bot_config, list):
            # Handle bot array - use the first bot configuration
            team_members = deepcopy(bot_config)
            options["team_members"] = team_members

            logger.info(f"Found bot array with {len(bot_config)} bots")

            # Also extract options from first bot if it's a dict
            if isinstance(bot_config[0], dict):
                first_bot = bot_config[0]
                for key in valid_options:
                    # Skip team_members to avoid overwriting the aggregated list
                    if key == "team_members":
                        continue
                    if key in first_bot and first_bot[key] is not None:
                        options[key] = first_bot[key]

        # Inject task-scoped skill identity env for this execution only.
        task_identity_env = build_task_identity_context(task_data)
        if task_identity_env:
            for member in options.get("team_members", []):
                if not isinstance(member, dict):
                    continue
                agent_config = member.setdefault("agent_config", {})
                raw_env = agent_config.get("env", {})
                env = dict(raw_env) if isinstance(raw_env, dict) else {}
                env.update(task_identity_env)
                agent_config["env"] = {k: str(v) for k, v in env.items()}

        logger.info(f"Extracted Agno options: {mask_sensitive_data(options)}")
        return options

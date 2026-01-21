#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import json
import os
import re
from typing import Any, Dict, Optional

from shared.logger import setup_logger
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = setup_logger("agno_config_utils")


def resolve_value_from_source(
    data_sources: Dict[str, Dict[str, Any]], source_spec: str
) -> str:
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
    Replace placeholders in template with values from multiple data sources

    Args:
        template: The template string with placeholders like ${agent_config.env.user} or ${env.user}
        data_sources: Dictionary containing all available data sources

    Returns:
        The template with placeholders replaced with actual values
    """
    # Find all placeholders in format ${source_spec}
    pattern = r"\$\{([^}]+)\}"

    logger.info(f"data_sources:{data_sources}, template:{template}")

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
        self, data_sources: Dict[str, Dict[str, Any]]
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

    def extract_agno_options(self, task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract Agno options from task data
        Collects all non-None configuration parameters from task_data

        Args:
            task_data: The task data dictionary

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
        bot_config = task_data.get("bot", {})

        # Extract all non-None parameters from bot_config
        if bot_config:
            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]

        # Handle both single bot object and bot array
        if bot_config:
            if isinstance(bot_config, list):
                # Handle bot array - use the first bot configuration
                team_members = []
                for tmp_bot in bot_config:
                    tmp_bot_options = {}
                    logger.info(
                        f"Found bot array with {len(bot_config)} bots, using bot: {tmp_bot.get('name', 'unnamed')}"
                    )
                    # Extract all non-None parameters from the first bot
                    for key in valid_options:
                        if key in tmp_bot and tmp_bot[key] is not None:
                            tmp_bot_options[key] = tmp_bot[key]
                    team_members.append(tmp_bot)

                options["team_members"] = team_members
            else:
                # Handle single bot object (original logic)
                logger.info("Found single bot configuration")
                for key in valid_options:
                    if key in bot_config and bot_config[key] is not None:
                        options[key] = bot_config[key]

        logger.info(f"Extracted Agno options: {mask_sensitive_data(options)}")
        return options

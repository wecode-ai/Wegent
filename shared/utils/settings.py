# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared configuration utilities for pydantic-settings.

This module provides reusable settings sources that can be used across
all services (backend, chat_shell, executor, executor_manager, etc.) to
ensure consistent configuration behavior.
"""

from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values
from pydantic_settings.sources import DotEnvSettingsSource
from pydantic_settings.sources.utils import parse_env_vars


class NoInterpolationDotEnvSettingsSource(DotEnvSettingsSource):
    """Custom DotEnvSettingsSource that disables variable interpolation.

    This fixes an issue where dotenv's default interpolation behavior
    incorrectly parses template variables like ${{user.name}} in JSON strings,
    turning them into "}".

    Problem:
        When using default dotenv behavior, template variables in .env files like:
        CHAT_MCP_SERVERS='{"mcpServers": {"tool": {"headers": {"X-User": "${{user.name}}"}}}}'

        Would be incorrectly parsed, with ${{user.name}} being treated as a shell
        variable interpolation, resulting in broken JSON.

    Solution:
        This class disables interpolation by passing `interpolate=False` to
        dotenv_values(), ensuring that template variables are preserved exactly
        as written in the .env file.

    Usage:
        In your pydantic-settings BaseSettings class, override settings_customise_sources:

        ```python
        from shared.utils.settings import NoInterpolationDotEnvSettingsSource

        class Settings(BaseSettings):
            # ... your settings fields ...

            @classmethod
            def settings_customise_sources(
                cls,
                settings_cls: Type[BaseSettings],
                init_settings: PydanticBaseSettingsSource,
                env_settings: PydanticBaseSettingsSource,
                dotenv_settings: PydanticBaseSettingsSource,
                file_secret_settings: PydanticBaseSettingsSource,
            ) -> Tuple[PydanticBaseSettingsSource, ...]:
                return (
                    init_settings,
                    env_settings,
                    NoInterpolationDotEnvSettingsSource(settings_cls),
                    file_secret_settings,
                )
        ```

    Note:
        - This only affects .env file parsing, not environment variables
        - Environment variables are still read normally by env_settings
        - This preserves template variables like ${{variable}} for runtime substitution
    """

    @staticmethod
    def _static_read_env_file(
        file_path: Path,
        *,
        encoding: str | None = None,
        case_sensitive: bool = False,
        ignore_empty: bool = False,
        parse_none_str: str | None = None,
    ) -> Mapping[str, str | None]:
        """Read .env file without interpolation to preserve template variables.

        Args:
            file_path: Path to the .env file
            encoding: File encoding (default: utf8)
            case_sensitive: Whether to treat keys as case-sensitive
            ignore_empty: Whether to ignore empty values
            parse_none_str: String to parse as None value

        Returns:
            Dictionary of environment variable key-value pairs
        """
        # Disable interpolation to preserve template variables like ${{user.name}}
        file_vars: dict[str, str | None] = dotenv_values(
            file_path, encoding=encoding or "utf8", interpolate=False
        )
        return parse_env_vars(file_vars, case_sensitive, ignore_empty, parse_none_str)

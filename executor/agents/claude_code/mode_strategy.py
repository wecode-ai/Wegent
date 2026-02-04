#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Execution Mode Strategy Pattern for ClaudeCodeAgent.

This module provides an abstract base class and factory for creating mode-specific
strategies that handle differences between Local and Docker execution modes.

The Strategy Pattern allows ClaudeCodeAgent to delegate mode-specific behavior
to specialized strategy implementations, improving code organization and testability.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Tuple

from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("mode_strategy")


class ExecutionModeStrategy(ABC):
    """Abstract base class for execution mode strategies.

    Each strategy encapsulates the mode-specific behavior for:
    - Config file management (claude.json, settings.json)
    - Client option configuration
    - Skills deployment options
    """

    @abstractmethod
    def get_config_directory(self, task_id: int) -> str:
        """Get the configuration directory path for this mode.

        Args:
            task_id: The task ID for task-specific directories

        Returns:
            Path to the configuration directory
        """
        pass

    @abstractmethod
    def save_config_files(
        self,
        task_id: int,
        agent_config: Dict[str, Any],
        claude_json_config: Dict[str, Any],
    ) -> Tuple[str, Dict[str, Any]]:
        """Save Claude configuration files to appropriate locations.

        Args:
            task_id: The task ID for task-specific directories
            agent_config: Agent configuration containing env settings
            claude_json_config: Non-sensitive user preferences for claude.json

        Returns:
            Tuple of (config_dir_path, env_config_dict)
            - config_dir_path: Path where config files were saved
            - env_config_dict: Environment config to pass to SDK (may be empty)
        """
        pass

    @abstractmethod
    def configure_client_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, Any],
        task_data: Dict[str, Any] = None,
    ) -> Dict[str, Any]:
        """Configure SDK client options based on mode-specific requirements.

        Args:
            options: Existing client options dictionary
            config_dir: Path to configuration directory
            env_config: Environment configuration (sensitive data)
            task_data: Task data containing user info and other metadata

        Returns:
            Updated options dictionary with mode-specific configurations
        """
        pass

    @abstractmethod
    def get_skills_directory(self, config_dir: str = None) -> str:
        """Get the skills directory path for this mode.

        Args:
            config_dir: Optional config directory for task-specific skills

        Returns:
            Path to the skills directory
        """
        pass

    @abstractmethod
    def get_skills_deployment_options(self) -> Dict[str, bool]:
        """Get mode-specific options for skills deployment.

        Returns:
            Dictionary with deployment options:
            - clear_cache: Whether to clear the skills cache before deployment
            - skip_existing: Whether to skip skills that already exist
        """
        pass


class ModeStrategyFactory:
    """Factory for creating execution mode strategies.

    This factory creates the appropriate strategy based on the configured
    execution mode (local vs docker).
    """

    @classmethod
    def create(cls, mode: str = None) -> ExecutionModeStrategy:
        """Create an execution mode strategy.

        Args:
            mode: Execution mode ("local" or None/other for docker).
                  If not specified, uses config.EXECUTOR_MODE.

        Returns:
            ExecutionModeStrategy instance for the specified mode
        """
        if mode is None:
            mode = config.EXECUTOR_MODE

        if mode == "local":
            from executor.agents.claude_code.local_mode_strategy import (
                LocalModeStrategy,
            )

            logger.debug("Creating LocalModeStrategy for local execution mode")
            return LocalModeStrategy()
        else:
            from executor.agents.claude_code.docker_mode_strategy import (
                DockerModeStrategy,
            )

            logger.debug("Creating DockerModeStrategy for docker execution mode")
            return DockerModeStrategy()

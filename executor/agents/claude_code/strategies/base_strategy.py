#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Abstract base strategy for mode-specific Claude Code behavior.

This module defines the interface for strategies that handle mode-specific
behavior in ClaudeCodeAgent (Local vs Docker execution modes).
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Tuple


class ClaudeCodeModeStrategy(ABC):
    """Abstract strategy for mode-specific Claude Code behavior.

    This strategy pattern separates Local and Docker mode-specific logic
    from the main ClaudeCodeAgent class, improving code clarity and testability.

    Implementations:
        - LocalClaudeCodeStrategy: For local executor running on user's machine
        - DockerClaudeCodeStrategy: For container-based execution
    """

    @abstractmethod
    def save_config_files(
        self,
        agent_config: Dict[str, Any],
        task_id: int,
        workspace_root: str,
    ) -> Tuple[str, Dict[str, str]]:
        """Save Claude config files and return configuration.

        Args:
            agent_config: Claude model configuration dict containing env settings
            task_id: Task ID for creating task-specific directories
            workspace_root: Root workspace directory path

        Returns:
            Tuple of (config_dir_path, env_config_dict):
                - config_dir_path: Directory where config files are stored
                - env_config_dict: Environment variables to pass to SDK
        """
        pass

    @abstractmethod
    def configure_sdk_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, str],
    ) -> Dict[str, Any]:
        """Configure SDK options with mode-specific settings.

        Args:
            options: Base SDK options dict
            config_dir: Claude config directory path
            env_config: Environment configuration dict from save_config_files

        Returns:
            Modified options dict with mode-specific settings applied
        """
        pass

    @abstractmethod
    def get_skills_deployment_config(
        self,
        config_dir: str,
    ) -> Tuple[str, bool, bool]:
        """Get skills deployment configuration.

        Args:
            config_dir: Claude config directory path

        Returns:
            Tuple of (skills_dir, skip_existing, clear_cache):
                - skills_dir: Directory to deploy skills to
                - skip_existing: Whether to skip already deployed skills
                - clear_cache: Whether to clear skill cache before deployment
        """
        pass

    @abstractmethod
    def cleanup_session(
        self,
        task_id: int,
        workspace_root: str,
        delete_session_file: bool,
    ) -> None:
        """Cleanup session resources.

        Args:
            task_id: Task ID to cleanup
            workspace_root: Root workspace directory path
            delete_session_file: Whether to delete the session file
                - True: Full cleanup (manual close) - deletes session file
                - False: Partial cleanup (pause) - keeps session file for resume
        """
        pass

    @abstractmethod
    def get_session_file_path(
        self,
        task_id: int,
        workspace_root: str,
    ) -> Optional[str]:
        """Get session file path for persistence.

        Args:
            task_id: Task ID
            workspace_root: Root workspace directory path

        Returns:
            Path to session file, or None if session persistence is not supported
        """
        pass

    @abstractmethod
    def supports_session_persistence(self) -> bool:
        """Check if this strategy supports session persistence.

        Returns:
            True if session can be persisted and resumed, False otherwise
        """
        pass

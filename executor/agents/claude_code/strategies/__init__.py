#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Strategy module for Claude Code mode-specific behavior.

This module provides the strategy pattern implementation for separating
Local and Docker mode-specific logic in ClaudeCodeAgent.

Usage:
    from executor.agents.claude_code.strategies import get_mode_strategy

    strategy = get_mode_strategy()
    config_dir, env_config = strategy.save_config_files(agent_config, task_id, workspace_root)
"""

from executor.config import config

from .base_strategy import ClaudeCodeModeStrategy
from .docker_strategy import DockerClaudeCodeStrategy
from .local_strategy import LocalClaudeCodeStrategy


def get_mode_strategy() -> ClaudeCodeModeStrategy:
    """Factory function to get the appropriate strategy based on executor mode.

    Returns:
        ClaudeCodeModeStrategy: LocalClaudeCodeStrategy for local mode,
                               DockerClaudeCodeStrategy for docker/sandbox mode
    """
    if config.EXECUTOR_MODE == "local":
        return LocalClaudeCodeStrategy()
    else:
        return DockerClaudeCodeStrategy()


__all__ = [
    "ClaudeCodeModeStrategy",
    "LocalClaudeCodeStrategy",
    "DockerClaudeCodeStrategy",
    "get_mode_strategy",
]

#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, Optional

from shared.logger import setup_logger
from executor.agents.base import Agent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.dify.dify_agent import DifyAgent

logger = setup_logger("agent_factory")


class AgentFactory:
    """
    Factory class for creating agent instances based on agent_type

    Agents are classified into two types:
    - local_engine: Agents that execute code locally (ClaudeCode, Agno)
    - external_api: Agents that delegate execution to external services (Dify)
    """

    _agents = {"claudecode": ClaudeCodeAgent, "agno": AgnoAgent, "dify": DifyAgent}

    @classmethod
    def get_agent(cls, agent_type: str, task_data: Dict[str, Any]) -> Optional[Agent]:
        """
        Get an agent instance based on agent_type

        Args:
            agent_type: The type of agent to create
            task_data: The task data to pass to the agent

        Returns:
            An instance of the requested agent, or None if the agent_type is not supported
        """
        agent_class = cls._agents.get(agent_type.lower())
        if agent_class:
            return agent_class(task_data)
        else:
            logger.error(f"Unsupported agent type: {agent_type}")
            return None

    @classmethod
    def is_external_api_agent(cls, agent_type: str) -> bool:
        """
        Check if an agent type is an external API type

        Args:
            agent_type: The type of agent to check

        Returns:
            True if the agent is an external API type, False otherwise
        """
        agent_class = cls._agents.get(agent_type.lower())
        if agent_class and hasattr(agent_class, 'AGENT_TYPE'):
            return agent_class.AGENT_TYPE == "external_api"
        return False

    @classmethod
    def get_agent_type(cls, agent_type: str) -> Optional[str]:
        """
        Get the agent type classification (local_engine or external_api)

        Args:
            agent_type: The type of agent to check

        Returns:
            "local_engine", "external_api", or None if agent type not found
        """
        agent_class = cls._agents.get(agent_type.lower())
        if agent_class:
            if hasattr(agent_class, 'AGENT_TYPE'):
                return agent_class.AGENT_TYPE
            return "local_engine"  # Default for older agents without AGENT_TYPE
        return None

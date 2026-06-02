#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Optional

from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.base import Agent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.agents.codex import CodeXAgent, is_codex_compatible_model
from executor.agents.dify.dify_agent import DifyAgent
from executor.agents.image_validator.image_validator_agent import ImageValidatorAgent
from shared.logger import setup_logger
from shared.models import ResponsesAPIEmitter
from shared.models.execution import ExecutionRequest

logger = setup_logger("agent_factory")


class AgentFactory:
    """
    Factory class for creating agent instances based on agent_type

    Agents are classified into types:
    - local_engine: Agents that execute code locally (ClaudeCode, Agno)
    - external_api: Agents that delegate execution to external services (Dify)
    - validator: Agents that perform validation tasks (ImageValidator)
    """

    _agents = {
        "claudecode": ClaudeCodeAgent,
        "codex": CodeXAgent,
        "agno": AgnoAgent,
        "dify": DifyAgent,
        "imagevalidator": ImageValidatorAgent,
    }

    @classmethod
    def get_agent(
        cls,
        agent_type: str,
        task_data: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ) -> Optional[Agent]:
        """
        Get an agent instance based on agent_type

        Args:
            agent_type: The type of agent to create
            task_data: The task data ExecutionRequest to pass to the agent
            emitter: Emitter instance for sending events

        Returns:
            An instance of the requested agent, or None if the agent_type is not supported
        """
        agent_class = cls._agents.get(agent_type.lower())
        if agent_class:
            return agent_class(task_data, emitter=emitter)
        else:
            logger.error(f"Unsupported agent type: {agent_type}")
            return None

    @classmethod
    def get_code_agent(
        cls,
        task_data: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ) -> Agent:
        """Create the local code agent for a task based on resolved model config."""
        if is_codex_compatible_model(task_data.model_config):
            logger.info(
                "Routing task %s to CodeXAgent for model %s",
                task_data.task_id,
                task_data.model_config.get("model_id"),
            )
            return CodeXAgent(task_data, emitter=emitter)
        return ClaudeCodeAgent(task_data, emitter=emitter)

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        """Return active task IDs across agents that expose active sessions."""
        active_ids: set[int] = set()
        for agent_class in cls._agents.values():
            getter = getattr(agent_class, "get_active_task_ids", None)
            if not getter:
                continue
            try:
                active_ids.update(int(task_id) for task_id in getter())
            except Exception as exc:
                logger.warning(
                    "Failed to read active task IDs from %s: %s",
                    agent_class.__name__,
                    exc,
                )
        return sorted(active_ids)

    @classmethod
    async def cleanup_task_clients(cls, task_id: int) -> int:
        """Cleanup lingering clients for a task across code agents."""
        cleaned = 0
        for agent_class in (ClaudeCodeAgent, CodeXAgent):
            cleanup = getattr(agent_class, "cleanup_task_clients", None)
            if not cleanup:
                continue
            try:
                cleaned += await cleanup(task_id)
            except Exception as exc:
                logger.warning(
                    "Failed to cleanup %s clients for task %s: %s",
                    agent_class.__name__,
                    task_id,
                    exc,
                )
        return cleaned

    @classmethod
    async def close_all_clients(cls) -> None:
        """Close active clients across local code agents."""
        for agent_class in (ClaudeCodeAgent, CodeXAgent):
            closer = getattr(agent_class, "close_all_clients", None)
            if not closer:
                continue
            await closer()

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
        if agent_class and hasattr(agent_class, "AGENT_TYPE"):
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
            if hasattr(agent_class, "AGENT_TYPE"):
                return agent_class.AGENT_TYPE
            return "local_engine"  # Default for older agents without AGENT_TYPE
        return None

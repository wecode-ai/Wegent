#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Optional, Tuple, Union

from executor.agents import Agent, AgentFactory
from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.config import config
from shared.logger import setup_logger
from shared.models import EmitterBuilder, TransportFactory
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus

logger = setup_logger("agent_service")

# Constant for missing subtask ID
MISSING_SUBTASK_ID = -1


def _format_task_log(task_id: Union[int, str], subtask_id: Union[int, str]) -> str:
    return f"task_id: {task_id}.{subtask_id}"


@dataclass
class AgentSession:
    agent: Agent
    created_at: float


class AgentService:
    _instance: ClassVar[Optional["AgentService"]] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    def __new__(cls):
        if not cls._instance:
            with cls._lock:
                if not cls._instance:
                    cls._instance = super().__new__(cls)
                    cls._instance._agent_sessions = {}
        return cls._instance

    def get_agent(self, agent_session_id: int) -> Optional[Agent]:
        session = self._agent_sessions.get(agent_session_id)
        return session.agent if session else None

    def create_agent(self, task_data: ExecutionRequest) -> Optional[Agent]:
        task_id = task_data.task_id
        subtask_id = task_data.subtask_id

        logger.info(f"task_id: [{task_id}] Creating agent")

        if existing_agent := self.get_agent(task_id):
            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Reusing existing agent"
            )
            return existing_agent

        try:
            # Determine agent type based on task type
            task_type = task_data.type

            if task_type == "validation":
                # For validation tasks, use ImageValidatorAgent
                shell_type = "imagevalidator"
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Validation task detected, using ImageValidatorAgent"
                )
            else:
                # For regular tasks, get shell_type from bot config
                bot_config = task_data.bot
                if isinstance(bot_config, dict):
                    # Handle single bot object
                    raw_shell_type = bot_config.get("shell_type", "")
                    shell_type = str(raw_shell_type or "").strip().lower()
                elif isinstance(bot_config, list) and bot_config:
                    # Handle bot array - use the first bot's shell_type
                    first_bot = bot_config[0]
                    if isinstance(first_bot, dict):
                        raw_shell_type = first_bot.get("shell_type", "")
                        shell_type = str(raw_shell_type or "").strip().lower()
                    else:
                        raw_shell_type = getattr(first_bot, "shell_type", "")
                        shell_type = str(raw_shell_type or "").strip().lower()
                else:
                    shell_type = ""

            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Creating new agent '{shell_type}'"
            )

            # Create emitter with throttled CallbackTransport for Docker mode
            emitter = (
                EmitterBuilder()
                .with_task(task_id, subtask_id)
                .with_transport(
                    TransportFactory.create_callback_throttled(
                        callback_url=config.CALLBACK_URL
                    )
                )
                .with_executor_info(
                    name=os.getenv("EXECUTOR_NAME"),
                    namespace=os.getenv("EXECUTOR_NAMESPACE"),
                )
                .build()
            )

            agent = AgentFactory.get_agent(shell_type, task_data, emitter)

            if not agent:
                logger.error(
                    f"[{_format_task_log(task_id, subtask_id)}] Failed to create agent"
                )
                return None

            init_status = agent.initialize()
            if init_status != TaskStatus.SUCCESS:
                logger.error(
                    f"[{_format_task_log(task_id, subtask_id)}] Failed to initialize agent: {init_status}"
                )
                return None

            self._agent_sessions[task_id] = AgentSession(
                agent=agent, created_at=time.time()
            )
            logger.info(f"task_id: [{task_id}] Agent created")
            return agent

        except Exception as e:
            logger.exception(
                f"[{_format_task_log(task_id, subtask_id)}] Exception during agent creation: {e}"
            )
            return None

    async def create_agent_async(self, task_data: ExecutionRequest) -> Optional[Agent]:
        """Async version of create_agent that runs blocking operations in executor.
        
        This method offloads the synchronous agent creation (including Git clone
        and skill deployment) to a thread pool executor to avoid blocking the
        event loop.
        
        Args:
            task_data: Execution request data
            
        Returns:
            Created agent or None if creation failed
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self.create_agent, task_data)

    async def execute_agent_task(
        self, agent: Agent, pre_executed: Optional[TaskStatus] = None
    ) -> Tuple[TaskStatus, Optional[str]]:
        try:
            logger.info(
                f"[{agent.get_name()}][{_format_task_log(agent.task_id, agent.subtask_id)}] Executing with pre_executed={pre_executed}"
            )
            return await agent.handle(pre_executed)
        except Exception as e:
            logger.exception(
                f"[{agent.get_name()}][{_format_task_log(agent.task_id, agent.subtask_id)}] Execution error: {e}"
            )
            return TaskStatus.FAILED, str(e)

    async def execute_task(
        self, task_data: ExecutionRequest
    ) -> Tuple[TaskStatus, Optional[str]]:
        task_id = task_data.task_id
        subtask_id = task_data.subtask_id
        try:
            agent = self.get_agent(task_id)

            # If agent exists, update prompt and emitter subtask_id
            if agent and hasattr(agent, "update_prompt") and task_data.prompt:
                new_prompt = task_data.prompt
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Updating prompt for existing agent"
                )
                agent.update_prompt(new_prompt)
                # Update emitter if subtask_id changed (e.g., append chat creates new subtask)
                if subtask_id and subtask_id != agent.subtask_id:
                    logger.info(
                        f"[{_format_task_log(task_id, subtask_id)}] Updating emitter subtask_id: "
                        f"{agent.subtask_id} -> {subtask_id}"
                    )
                    agent.update_emitter(subtask_id)
            # If agent doesn't exist, create new agent asynchronously
            elif not agent:
                agent = await self.create_agent_async(task_data)

            if not agent:
                msg = f"[{_format_task_log(task_id, subtask_id)}] Unable to get or create agent"
                logger.error(msg)
                return TaskStatus.FAILED, msg
            return await self.execute_agent_task(agent)
        except Exception as e:
            logger.exception(
                f"[{_format_task_log(task_id, subtask_id)}] Task execution error: {e}"
            )
            return TaskStatus.FAILED, str(e)

    async def _close_agent_session(
        self, task_id: int, agent: Agent
    ) -> Tuple[TaskStatus, Optional[str]]:
        try:
            agent_name = agent.get_name()
            if agent_name == "ClaudeCode":
                await ClaudeCodeAgent.close_client(str(task_id))
                logger.info(
                    f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Closed Claude client"
                )
            elif agent_name == "Agno":
                await AgnoAgent.close_client(str(task_id))
                logger.info(
                    f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Closed Agno client"
                )
        except Exception as e:
            logger.exception(
                f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Error closing agent"
            )
            return TaskStatus.FAILED, str(e)
        else:
            return TaskStatus.SUCCESS, None

    async def delete_session_async(
        self, task_id: int
    ) -> Tuple[TaskStatus, Optional[str]]:
        session = self._agent_sessions.get(task_id)
        if not session:
            return (
                TaskStatus.FAILED,
                f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] No session found",
            )

        try:
            status, error_msg = await self._close_agent_session(task_id, session.agent)
            if status != TaskStatus.SUCCESS:
                return status, error_msg
            del self._agent_sessions[task_id]
            return (
                TaskStatus.SUCCESS,
                f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Session deleted",
            )
        except Exception as e:
            logger.exception(f"[{task_id}] Error deleting session")
            return TaskStatus.FAILED, str(e)

    def delete_session(self, task_id: int) -> Tuple[TaskStatus, Optional[str]]:
        try:
            return asyncio.run(self.delete_session_async(task_id))
        except RuntimeError as e:
            if "already running" in str(e):
                logger.exception(
                    f"[{task_id}] delete_session() cannot run inside an active event loop; "
                    f"use delete_session_async()"
                )
                return (
                    TaskStatus.FAILED,
                    "delete_session() cannot run inside an active event loop; use delete_session_async()",
                )
            logger.exception(f"[{task_id}] Runtime error deleting session")
            return TaskStatus.FAILED, str(e)
        except Exception as e:
            logger.exception(f"[{task_id}] Unexpected error deleting session")
            return TaskStatus.FAILED, str(e)

    def cancel_task(self, task_id: int) -> Tuple[TaskStatus, Optional[str]]:
        """
        Cancel the currently running task for a given task_id

        Args:
            task_id: The task ID to cancel

        Returns:
            Tuple of (TaskStatus, error message or None)
        """
        logger.info(f"task_id: [{task_id}] Cancelling task")
        session = self._agent_sessions.get(task_id)
        if not session:
            return (
                TaskStatus.FAILED,
                f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] No session found",
            )

        try:
            agent = session.agent
            agent_name = agent.get_name()

            if hasattr(agent, "cancel_run"):
                success = agent.cancel_run()
                if success:
                    logger.info(
                        f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Successfully cancelled {agent_name} task"
                    )
                    return (
                        TaskStatus.SUCCESS,
                        f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Task cancelled",
                    )
                else:
                    logger.warning(
                        f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Failed to cancel {agent_name} task"
                    )
                    return (
                        TaskStatus.FAILED,
                        f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] Cancel failed",
                    )
            else:
                return (
                    TaskStatus.FAILED,
                    f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] {agent_name} agent does not support cancellation",
                )

        except Exception as e:
            logger.exception(f"[{task_id}] Error cancelling task: {e}")
            return TaskStatus.FAILED, str(e)

    async def send_cancel_callback_async(self, task_id: int) -> None:
        """
        Asynchronously send cancel task callback using unified ExecutionEvent format.
        This method is called in a background task and will not block the cancel API response.

        Args:
            task_id: Task ID
        """
        try:
            session = self._agent_sessions.get(task_id)
            if not session:
                logger.warning(
                    f"[{_format_task_log(task_id, MISSING_SUBTASK_ID)}] No session found for sending cancel callback"
                )
                return

            agent = session.agent
            task_data = getattr(agent, "task_data", None)

            # Get task information from ExecutionRequest
            subtask_id = MISSING_SUBTASK_ID
            if task_data is not None:
                subtask_id = task_data.subtask_id
            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Sending cancel event asynchronously"
            )

            # Create emitter and send CANCELLED event
            emitter = (
                EmitterBuilder()
                .with_task(task_id, subtask_id)
                .with_transport(
                    TransportFactory.create_callback(callback_url=config.CALLBACK_URL)
                )
                .with_executor_info(
                    name=os.getenv("EXECUTOR_NAME"),
                    namespace=os.getenv("EXECUTOR_NAMESPACE"),
                )
                .build()
            )
            result = await emitter.incomplete(reason="cancelled")

            if result and result.get("status") == TaskStatus.SUCCESS.value:
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Cancel event sent successfully"
                )
            else:
                logger.error(
                    f"[{_format_task_log(task_id, subtask_id)}] Failed to send cancel event: {result}"
                )

            # DO NOT cleanup task state here - SDK interrupt messages still need to be processed
            # State will be cleaned up in response_processor after all messages are processed

        except Exception as e:
            logger.exception(f"[{task_id}] Error sending cancel callback: {e}")
            # DO NOT cleanup task state on error - let response_processor handle it

    def list_sessions(self) -> List[Dict[str, Any]]:
        return [
            {
                "task_id": task_id,
                "agent_type": session.agent.get_name(),
                "pre_executed": session.agent.pre_executed,
                "created_at": session.created_at,
            }
            for task_id, session in self._agent_sessions.items()
        ]

    async def _close_claude_sessions(self) -> Tuple[TaskStatus, Optional[str]]:
        try:
            await ClaudeCodeAgent.close_all_clients()
            logger.info("Closed all Claude client connections")
            return TaskStatus.SUCCESS, None
        except Exception as e:
            logger.exception("Error closing Claude client connections")
            return TaskStatus.FAILED, str(e)

    async def _close_agno_sessions(self) -> Tuple[TaskStatus, Optional[str]]:
        try:
            await AgnoAgent.close_all_clients()
            logger.info("Closed all Agno client connections")
            return TaskStatus.SUCCESS, None
        except Exception as e:
            logger.exception("Error closing Agno client connections")
            return TaskStatus.FAILED, str(e)

    async def close_all_agent_sessions(self) -> Tuple[TaskStatus, str, Dict[str, str]]:
        results: List[str] = []
        errors: List[str] = []
        error_detail: Dict[str, str] = {}
        agent_types = {s.agent.get_name() for s in self._agent_sessions.values()}

        if "ClaudeCode" in agent_types:
            status, msg = await self._close_claude_sessions()
            if status == TaskStatus.SUCCESS:
                results.append("Claude")
            else:
                errors.append("Claude")
                error_detail["ClaudeCode"] = msg or "Unknown error"

        if "Agno" in agent_types:
            status, msg = await self._close_agno_sessions()
            if status == TaskStatus.SUCCESS:
                results.append("Agno")
            else:
                errors.append("Agno")
                error_detail["Agno"] = msg or "Unknown error"

        self._agent_sessions.clear()

        if not errors:
            return TaskStatus.SUCCESS, "All agent sessions closed successfully", {}
        else:
            message = f"Some agents failed to close: {', '.join(errors)}; Successful: {', '.join(results) or 'None'}"
            return TaskStatus.FAILED, message, error_detail

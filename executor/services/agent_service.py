#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any, ClassVar, Dict, List, Optional, Tuple

from shared.logger import setup_logger
from shared.status import TaskStatus

from executor.agents import Agent, AgentFactory
from executor.agents.agno.agno_agent import AgnoAgent
from executor.agents.claude_code.claude_code_agent import ClaudeCodeAgent
from executor.callback.callback_handler import send_status_callback
from executor.tasks.task_state_manager import TaskStateManager

logger = setup_logger("agent_service")


def _format_task_log(task_id, subtask_id):
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

    def get_agent(self, agent_session_id: str) -> Optional[Agent]:
        session = self._agent_sessions.get(agent_session_id)
        return session.agent if session else None

    def _generate_agent_session_id(self, task_id: Any, subtask_id: Any) -> str:
        """Generate a unique session ID for an agent based on task and subtask IDs."""
        return f"agent_session_{task_id}"

    def create_agent(self, task_data: Dict[str, Any]) -> Optional[Agent]:
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)

        logger.info(f"task_id: [{task_id}] Creating agent")

        if existing_agent := self.get_agent(f"{task_id}"):
            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Reusing existing agent"
            )
            return existing_agent

        try:
            # Determine agent type based on task type
            task_type = task_data.get("type", "")

            if task_type == "validation":
                # For validation tasks, use ImageValidatorAgent
                shell_type = "imagevalidator"
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Validation task detected, using ImageValidatorAgent"
                )
            else:
                # For regular tasks, get shell_type from bot config
                bot_config = task_data.get("bot")
                if isinstance(bot_config, list):
                    shell_type = (
                        bot_config[0].get("shell_type", "").strip().lower()
                        if bot_config
                        else ""
                    )
                elif isinstance(bot_config, dict):
                    shell_type = bot_config.get("shell_type", "").strip().lower()
                else:
                    shell_type = ""

            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Creating new agent '{shell_type}'"
            )
            agent = AgentFactory.get_agent(shell_type, task_data)

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

    def execute_agent_task(
        self, agent: Agent, pre_executed: Optional[TaskStatus] = None
    ) -> Tuple[TaskStatus, Optional[str]]:
        try:
            logger.info(
                f"[{agent.get_name()}][{_format_task_log(agent.task_id, agent.subtask_id)}] Executing with pre_executed={pre_executed}"
            )
            return agent.handle(pre_executed)
        except Exception as e:
            logger.exception(
                f"[{agent.get_name()}][{_format_task_log(agent.task_id, agent.subtask_id)}] Execution error: {e}"
            )
            return TaskStatus.FAILED, str(e)

    def execute_task(
        self, task_data: Dict[str, Any]
    ) -> Tuple[TaskStatus, Optional[str]]:
        task_id = task_data.get("task_id", -1)
        subtask_id = task_data.get("subtask_id", -1)
        try:
            agent = self.get_agent(f"{task_id}")

            # If agent exists, update prompt
            if agent and hasattr(agent, "update_prompt") and "prompt" in task_data:
                new_prompt = task_data.get("prompt", "")
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Updating prompt for existing agent"
                )
                agent.update_prompt(new_prompt)
            # If agent doesn't exist, create new agent
            elif not agent:
                agent = self.create_agent(task_data)

            if not agent:
                msg = f"[{_format_task_log(task_id, subtask_id)}] Unable to get or create agent"
                logger.error(msg)
                return TaskStatus.FAILED, msg
            return self.execute_agent_task(agent)
        except Exception as e:
            logger.exception(
                f"[{_format_task_log(task_id, subtask_id)}] Task execution error: {e}"
            )
            return TaskStatus.FAILED, str(e)

    async def _close_agent_session(
        self, task_id: str, agent: Agent
    ) -> Tuple[TaskStatus, Optional[str]]:
        try:
            agent_name = agent.get_name()
            if agent_name == "ClaudeCodeAgent":
                await ClaudeCodeAgent.close_client(task_id)
                logger.info(f"[{_format_task_log(task_id, -1)}] Closed Claude client")
            elif agent_name == "Agno":
                await AgnoAgent.close_client(task_id)
                logger.info(f"[{_format_task_log(task_id, -1)}] Closed Agno client")
            return TaskStatus.SUCCESS, None
        except Exception as e:
            logger.exception(
                f"[{_format_task_log(task_id, -1)}] Error closing agent: {e}"
            )
            return TaskStatus.FAILED, str(e)

    async def delete_session_async(
        self, task_id: str
    ) -> Tuple[TaskStatus, Optional[str]]:
        session = self._agent_sessions.get(task_id)
        if not session:
            return (
                TaskStatus.FAILED,
                f"[{_format_task_log(task_id, -1)}] No session found",
            )

        try:
            status, error_msg = await self._close_agent_session(task_id, session.agent)
            if status != TaskStatus.SUCCESS:
                return status, error_msg
            del self._agent_sessions[task_id]
            return (
                TaskStatus.SUCCESS,
                f"[{_format_task_log(task_id, -1)}] Session deleted",
            )
        except Exception as e:
            logger.exception(f"[{task_id}] Error deleting session: {e}")
            return TaskStatus.FAILED, str(e)

    def delete_session(self, task_id: str) -> Tuple[TaskStatus, Optional[str]]:
        try:
            return asyncio.run(self.delete_session_async(task_id))
        except RuntimeError as e:
            if "already running" in str(e):
                loop = asyncio.get_event_loop()
                return loop.run_until_complete(self.delete_session_async(task_id))
            logger.exception(f"[{task_id}] Runtime error deleting session: {e}")
            return TaskStatus.FAILED, str(e)
        except Exception as e:
            logger.exception(f"[{task_id}] Unexpected error deleting session: {e}")
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
                f"[{_format_task_log(task_id, -1)}] No session found",
            )

        try:
            agent = session.agent
            agent_name = agent.get_name()

            if hasattr(agent, "cancel_run"):
                success = agent.cancel_run()
                if success:
                    logger.info(
                        f"[{_format_task_log(task_id, -1)}] Successfully cancelled {agent_name} task"
                    )
                    return (
                        TaskStatus.SUCCESS,
                        f"[{_format_task_log(task_id, -1)}] Task cancelled",
                    )
                else:
                    logger.warning(
                        f"[{_format_task_log(task_id, -1)}] Failed to cancel {agent_name} task"
                    )
                    return (
                        TaskStatus.FAILED,
                        f"[{_format_task_log(task_id, -1)}] Cancel failed",
                    )
            else:
                return (
                    TaskStatus.FAILED,
                    f"[{_format_task_log(task_id, -1)}] {agent_name} agent does not support cancellation",
                )

        except Exception as e:
            logger.exception(f"[{task_id}] Error cancelling task: {e}")
            return TaskStatus.FAILED, str(e)

    async def send_cancel_callback_async(self, task_id: int) -> None:
        """
        Asynchronously send cancel task callback
        This method is called in a background task and will not block the cancel API response

        Args:
            task_id: Task ID
        """
        try:
            session = self._agent_sessions.get(task_id)
            if not session:
                logger.warning(
                    f"[{_format_task_log(task_id, -1)}] No session found for sending cancel callback"
                )
                return

            agent = session.agent
            task_data = getattr(agent, "task_data", {})

            # Get task information
            subtask_id = task_data.get("subtask_id", -1)
            task_title = task_data.get("task_title", "")
            subtask_title = task_data.get("subtask_title", "")

            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Sending cancel callback asynchronously"
            )

            # Send CANCELLED status callback (not COMPLETED)
            result = send_status_callback(
                task_id=task_id,
                subtask_id=subtask_id,
                task_title=task_title,
                subtask_title=subtask_title,
                status=TaskStatus.CANCELLED.value,
                message="${{tasks.cancel_task}}",
                progress=100,
            )

            if result and result.get("status") == TaskStatus.SUCCESS.value:
                logger.info(
                    f"[{_format_task_log(task_id, subtask_id)}] Cancel callback sent successfully"
                )
            else:
                logger.error(
                    f"[{_format_task_log(task_id, subtask_id)}] Failed to send cancel callback: {result}"
                )

            # Clean up task state after cancel callback is sent
            # This allows next message to be processed without "Request interrupted" error
            task_state_manager = TaskStateManager()
            task_state_manager.cleanup(task_id)
            logger.info(
                f"[{_format_task_log(task_id, subtask_id)}] Cleaned up task state after cancel"
            )

        except Exception as e:
            logger.exception(f"[{task_id}] Error sending cancel callback: {e}")
            # Still attempt to cleanup task state on error
            try:
                task_state_manager = TaskStateManager()
                task_state_manager.cleanup(task_id)
                logger.info(
                    f"[{_format_task_log(task_id, -1)}] Cleaned up task state after cancel error"
                )
            except Exception as cleanup_error:
                logger.warning(
                    f"[{task_id}] Failed to cleanup task state: {cleanup_error}"
                )

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

        if "ClaudeCodeAgent" in agent_types:
            status, msg = await self._close_claude_sessions()
            if status == TaskStatus.SUCCESS:
                results.append("Claude")
            else:
                errors.append("Claude")
                error_detail["ClaudeCodeAgent"] = msg or "Unknown error"

        if "Agno" in agent_types:
            status, msg = await self._close_agno_sessions()
            if status == TaskStatus.SUCCESS:
                results.append("Agno")
            else:
                errors.append("Agno")
                error_detail["AgnoAgent"] = msg or "Unknown error"

        self._agent_sessions.clear()

        if not errors:
            return TaskStatus.SUCCESS, "All agent sessions closed successfully", {}
        else:
            message = f"Some agents failed to close: {', '.join(errors)}; Successful: {', '.join(results) or 'None'}"
            return TaskStatus.FAILED, message, error_detail

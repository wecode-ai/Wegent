#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task processing module, handles tasks fetched from API.

Uses unified ExecutionRequest from shared.models.execution.
"""

from typing import Any, Dict, List, Union

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.config import config
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.github.github_app import get_github_app
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.telemetry.decorators import set_span_attribute, trace_sync

logger = setup_logger(__name__)


def _extract_task_attributes(self, task: Union[Dict[str, Any], ExecutionRequest]):
    """Extract trace attributes from task data.

    Args:
        task: Task data as dict or ExecutionRequest
    """
    # Handle both dict and ExecutionRequest
    if isinstance(task, ExecutionRequest):
        task_dict = task.to_dict()
    else:
        task_dict = task

    attrs = {
        "task.id": str(task_dict.get("task_id", -1)),
        "task.subtask_id": str(task_dict.get("subtask_id", -1)),
        "task.title": task_dict.get("task_title", ""),
        "task.type": task_dict.get("type", "online"),
    }
    # Extract user info if available
    user_data = task_dict.get("user", {})
    if user_data:
        if user_data.get("id"):
            attrs["user.id"] = str(user_data.get("id"))
        if user_data.get("name"):
            attrs["user.name"] = user_data.get("name")
    return attrs


class TaskProcessor:
    """Task processor class, handles different types of tasks.

    Uses unified ExecutionRequest from shared.models.execution.
    """

    def __init__(self):
        """Initialize TaskProcessor with API client"""
        self.api_client = TaskApiClient()
        self.github_app = None
        if config.GITHUB_APP_ID and config.GITHUB_PRIVATE_KEY_PATH:
            self.github_app = get_github_app()

    def update_task_status_callback(self, task_id, subtask_id, progress=0, **kwargs):
        """
        Callback function for updating task execution status

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Kubernetes pod name
            progress: Processing progress percentage
        """
        success, result = self.api_client.update_task_status_by_fields(
            task_id, subtask_id, progress, **kwargs
        )
        if not success:
            logger.warning(f"Failed to update status for task {task_id}: {result}")

    def process_tasks(
        self, tasks: List[Union[Dict[str, Any], ExecutionRequest]]
    ) -> Dict[int, Any]:
        """
        Process fetched tasks with distributed tracing support.

        Uses unified ExecutionRequest from shared.models.execution.

        Args:
            tasks: List of tasks as dicts or ExecutionRequest objects

        Returns:
            dict: Task processing results keyed by task_id
        """
        if not tasks:
            logger.info("No tasks to process")
            return {}

        task_result = {}
        total_count = len(tasks)
        success_count = 0

        for task in tasks:
            # Convert to dict if ExecutionRequest
            if isinstance(task, ExecutionRequest):
                task_dict = task.to_dict()
            else:
                task_dict = task

            task_id = task_dict.get("task_id", -1)
            result, success = self._process_single_task(task_dict)
            task_result[task_id] = result
            if success:
                success_count += 1

        logger.info(
            f"Task processing completed: {success_count}/{total_count} succeeded"
        )
        return task_result

    @trace_sync(
        span_name="process_task",
        tracer_name="executor_manager.tasks",
        extract_attributes=_extract_task_attributes,
    )
    def _process_single_task(
        self, task: Union[Dict[str, Any], ExecutionRequest]
    ) -> tuple:
        """
        Process a single task with tracing support.

        Uses unified ExecutionRequest from shared.models.execution.

        Args:
            task: Task data as dict or ExecutionRequest

        Returns:
            tuple: (result dict, success bool)
        """
        # Convert to dict if ExecutionRequest
        if isinstance(task, ExecutionRequest):
            task_dict = task.to_dict()
        else:
            task_dict = task

        task_id = task_dict.get("task_id", -1)
        subtask_id = task_dict.get("subtask_id", -1)
        bot_config = task_dict.get("bot") or []

        # Set request context for log correlation
        from shared.telemetry.context import init_request_context

        init_request_context()

        try:
            executor_type = task_dict.get(
                "executor_type", config.EXECUTOR_DISPATCHER_MODE
            )
            logger.info(f"Processing task: ID={task_id}, executor_type={executor_type}")

            set_span_attribute("executor.type", executor_type)

            executor = ExecutorDispatcher.get_executor(executor_type)

            # Handle GitHub App token injection for MCP servers
            if (
                self.github_app is not None
                and bot_config
                and isinstance(bot_config, dict)
                and "mcp_servers" in bot_config
                and bot_config.get("mcp_servers") is not None
            ):
                mcp_servers = bot_config.get("mcp_servers", {})

                if "github" in mcp_servers:
                    if "env" not in mcp_servers["github"]:
                        mcp_servers["github"]["env"] = {}

                    github_app_access_token = self.github_app.get_repository_token(
                        task_dict.get("git_repo")
                    )
                    if github_app_access_token.get("token"):
                        mcp_servers["github"]["env"]["GITHUB_PERSONAL_ACCESS_TOKEN"] = (
                            github_app_access_token.get("token")
                        )
                        logger.info("Set GITHUB_PERSONAL_ACCESS_TOKEN in github mcp")

            # Submit task to executor (pass dict for executor compatibility)
            result = executor.submit_executor(
                task_dict,
                callback=self.update_task_status_callback,
            )

            if result and result.get("executor_name"):
                logger.info(
                    f"Task processed successfully: ID={task_id}, executor_type={executor_type}"
                )
                set_span_attribute("executor.name", result.get("executor_name"))
                set_span_attribute("task.submit_success", True)
                return result, True
            else:
                error_msg = (
                    result.get("error_msg", "Unknown error")
                    if result
                    else "No result returned"
                )
                logger.error(
                    f"Failed to process task: ID={task_id}, executor_type={executor_type}, error={error_msg}"
                )
                set_span_attribute("error", True)
                set_span_attribute("error.message", error_msg)
                set_span_attribute("task.submit_success", False)
                return result, False

        except Exception as e:
            error_msg = str(e)
            logger.error(f"Error processing task {task_id}: {error_msg}")
            set_span_attribute("error", True)
            set_span_attribute("error.message", error_msg)
            return {"status": "failed", "error_msg": error_msg}, False

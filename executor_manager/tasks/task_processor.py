#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task processing module, handles tasks fetched from API
"""

from shared.logger import setup_logger
from shared.telemetry.decorators import set_span_attribute, trace_sync

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.config import config
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.github.github_app import get_github_app

logger = setup_logger(__name__)


def _extract_task_attributes(self, task):
    """Extract trace attributes from task data."""
    return {
        "task.id": str(task.get("task_id", -1)),
        "task.subtask_id": str(task.get("subtask_id", -1)),
        "task.title": task.get("task_title", ""),
        "task.type": task.get("type", "online"),
    }


class TaskProcessor:
    """Task processor class, handles different types of tasks"""

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

    def process_tasks(self, tasks):
        """
        Process fetched tasks with distributed tracing support.

        Args:
            tasks: List of tasks fetched from API

        Returns:
            dict: Task processing results
        """
        if not tasks:
            logger.info("No tasks to process")
            return True

        task_result = {}
        total_count = len(tasks)
        success_count = 0

        for task in tasks:
            task_id = task.get("task_id", -1)
            result, success = self._process_single_task(task)
            task_result[task_id] = result
            if success:
                success_count += 1

        logger.info(f"Task processing completed: {success_count}/{total_count} succeeded")
        return task_result

    @trace_sync(
        span_name="process_task",
        tracer_name="executor_manager.tasks",
        extract_attributes=_extract_task_attributes,
    )
    def _process_single_task(self, task):
        """
        Process a single task with tracing support.

        Args:
            task: Task data dictionary

        Returns:
            tuple: (result dict, success bool)
        """
        task_id = task.get("task_id", -1)
        bot_config = task.get("bot") or []

        try:
            executor_type = task.get("executor_type", config.EXECUTOR_DISPATCHER_MODE)
            logger.info(f"Processing task: ID={task_id}, executor_type={executor_type}")

            set_span_attribute("executor.type", executor_type)

            executor = ExecutorDispatcher.get_executor(executor_type)

            # Handle GitHub App token injection for MCP servers
            if (
                self.github_app is not None
                and bot_config
                and "mcp_servers" in bot_config
                and bot_config.get("mcp_servers") is not None
            ):
                mcp_servers = bot_config.get("mcp_servers", {})

                if "github" in mcp_servers:
                    if "env" not in mcp_servers["github"]:
                        mcp_servers["github"]["env"] = {}

                    github_app_access_token = self.github_app.get_repository_token(task.get("git_repo"))
                    if github_app_access_token.get("token"):
                        mcp_servers["github"]["env"]["GITHUB_PERSONAL_ACCESS_TOKEN"] = github_app_access_token.get(
                            "token"
                        )
                        logger.info("Set GITHUB_PERSONAL_ACCESS_TOKEN in github mcp")

            # Submit task to executor
            result = executor.submit_executor(
                task,
                callback=self.update_task_status_callback,
            )

            if result and result.get("executor_name"):
                logger.info(f"Task processed successfully: ID={task_id}, executor_type={executor_type}")
                set_span_attribute("executor.name", result.get("executor_name"))
                set_span_attribute("task.submit_success", True)
                return result, True
            else:
                error_msg = result.get("error_msg", "Unknown error") if result else "No result returned"
                logger.error(f"Failed to process task: ID={task_id}, executor_type={executor_type}, error={error_msg}")
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

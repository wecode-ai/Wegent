#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Task processing module, handles tasks fetched from API
"""

from executor_manager.config import config
from executor_manager.github.github_app import get_github_app
from shared.logger import setup_logger
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.clients.task_api_client import TaskApiClient

logger = setup_logger(__name__)


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
        Process fetched tasks

        Args:
            tasks: List of tasks fetched from API

        Returns:
            bool: Whether processing was successful
        """
        if not tasks:
            logger.info("No tasks to process")
            return True

        task_result = {}
        total_count = len(tasks)
        success_count = 0
        for task in tasks:
            try:
                task_id = task.get("task_id", -1)
                subtask_id = task.get("subtask_id", -1)
                bot_config = task.get("bot") or []
                
                # Get executor type, default is docker
                executor_type = task.get("executor_type", config.EXECUTOR_DISPATCHER_MODE)
                logger.info(
                    f"Processing task: ID={task_id}, executor_type={executor_type}"
                )
                executor = ExecutorDispatcher.get_executor(executor_type)
                
                if self.github_app is not None and bot_config and "mcp_servers" in bot_config and bot_config.get("mcp_servers") is not None:
                    mcp_servers = bot_config.get("mcp_servers", {})

                    if "github" in mcp_servers:
                        
                        if "env" not in mcp_servers["github"]:
                            mcp_servers["github"]["env"] = {}
                        
                        github_app_access_token = self.github_app.get_repository_token(task.get("git_repo"))
                        if github_app_access_token.get("token"):
                            mcp_servers["github"]["env"]["GITHUB_PERSONAL_ACCESS_TOKEN"] = github_app_access_token.get("token")
                            logger.info("Set empty GITHUB_PERSONAL_ACCESS_TOKEN in github mcp")
                
                result = executor.submit_executor(
                    task,
                    callback=self.update_task_status_callback,
                )
                task_result[task_id] = result
                if result and result.get("executor_name"):
                    logger.info(
                        f"Task processed successfully: ID={task_id}, executor_type={executor_type}"
                    )
                    success_count += 1
                else:
                    logger.error(
                        f"Failed to process task: ID={task_id}, executor_type={executor_type}"
                    )
            except Exception as e:
                logger.error(f"Error processing task: {e}")

        logger.info(
            f"Task processing completed: {success_count}/{total_count} succeeded"
        )
        return task_result

#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import os
from typing import Dict, Any, Optional, Tuple


from shared.utils import git_util
from executor.config import config
from shared.status import TaskStatus
from shared.logger import setup_logger
from executor.callback.callback_client import CallbackClient

logger = setup_logger("agent_base")


class Agent:
    """
    Base Agent class that all specific agents should inherit from
    """
    
    def get_name(self) -> str:
        """
        Get the name of the agent. By default, returns the class name.
        Subclasses can override this method to provide a custom name.
        
        Returns:
            str: The name of the agent
        """
        return self.__class__.__name__

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the base agent

        Args:
            task_data: The task data dictionary
        """
        self.task_data = task_data
        self.callback_client = CallbackClient()
        self.task_id = task_data.get("task_id", -1)
        self.subtask_id = task_data.get("subtask_id", -1)
        self.task_title = task_data.get("task_title", "")
        self.subtask_title = task_data.get("subtask_title", "")
        self.execution_status = TaskStatus.INITIALIZED
        self.project_path = None

    def handle(self, pre_executed: Optional[TaskStatus] = None) -> Tuple[TaskStatus, Optional[str]]:
        """
        Unified entry point for agent execution.
        Executes pre_execute first, then execute if pre_execute succeeds.
        
        Args:
            pre_executed: Optional parameter to override the internal execution status
            
        Returns:
            tuple: (status: TaskStatus, error_message: str or None)
            - status: TaskStatus indicating the result of execution
            - error_message: Error message if execution failed, None otherwise.
        """
        try:
            # If pre_executed parameter is provided, update internal state
            if pre_executed is not None:
                self.execution_status = pre_executed
                
            if self.execution_status == TaskStatus.INITIALIZED:
                logger.info(f"Agent[{self.get_name()}][{self.task_id}] handle: Starting pre_execute.")
                pre_execute_status = self.pre_execute()
                if pre_execute_status != TaskStatus.SUCCESS:
                    error_msg = f"Agent[{self.get_name()}][{self.task_id}] handle: pre_execute failed."
                    logger.error(error_msg)
                    return TaskStatus.FAILED, error_msg
                logger.info(
                    f"Agent[{self.get_name()}][{self.task_id}] handle: pre_execute succeeded, starting execute."
                )
                self.execution_status = TaskStatus.PRE_EXECUTED
            else:
                logger.info(f"Agent[{self.get_name()}][{self.task_id}] handle: Skipping pre_execute (already done).")
  
            self.execution_status = TaskStatus.RUNNING
            result = self.execute()
            logger.info(
                f"Agent{self.get_name()}]{self.task_id}] handle: execute finished with result: {result}"
            )
            return result, None
        except Exception as e:
            error_msg = f"Agent[{self.get_name()}][{self.task_id}] handle: Exception during execute: {str(e)}"
            logger.exception(error_msg)
            return TaskStatus.FAILED, error_msg

    def report_progress(
        self, progress: int, status: Optional[str] = None, message: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None
    ) -> None:
        """
        Report progress to the executor_manager

        Args:
            progress: The progress percentage (0-100)
            status: Optional status string
            message: Optional message string
            result: Optional result data dictionary
        """
        logger.info(f"Reporting progress: {progress}%, status: {status}, message: {message}, result: {result}")
        self.callback_client.send_callback(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            task_title=self.task_title,
            subtask_title=self.subtask_title,
            progress=progress,
            status=status,
            message=message,
            result=result,
        )

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution hook for tasks such as code download, environment setup, etc.
        Subclasses can override this method to implement custom pre-execution logic.

        Returns:
            TaskStatus: Execution status (COMPLETED, FAILED, etc.)
        """
        logger.info(f"Agent[{self.get_name()}][{self.task_id}] pre_execute: No pre-execution steps by default, passing through.")
        return TaskStatus.SUCCESS
        
    def execute(self) -> TaskStatus:
        """
        Execute the agent's task

        Returns:
            TaskStatus: Execution status (SUCCESS, FAILED, COMPLETED, etc.)
        """
        raise NotImplementedError("Subclasses must implement execute()")

    def download_code(self):
        git_url = self.task_data.get("git_url","")
        if git_url == "":
            logger.info("git url is empty, skip download code")
            return
        
        user_config = self.task_data.get("user")
        git_token = user_config.get("git_token")
        username = user_config.get("user_name")
        branch_name = self.task_data.get("branch_name")
        repo_name = git_util.get_repo_name_from_url(git_url)
        logger.info(f"Agent[{self.get_name()}][{self.task_id}] start download code for git url: {git_url}, branch name: {branch_name}")

        project_path = os.path.join(config.WORKSPACE_ROOT, str(self.task_id),repo_name)
        if self.project_path is None:
            self.project_path = project_path

        if not os.path.exists(project_path):
            success, error_msg = git_util.clone_repo(git_url, branch_name, project_path, username, git_token)

            if success:
                # Setup git config with user information
                self.setup_git_config(user_config, project_path)
                logger.info(f"Agent[{self.get_name()}][{self.task_id}] Project cloned to {project_path}")
            else:
                error_detail = f": {error_msg}" if error_msg else ""
                error_msg = f"Agent[{self.get_name()}][{self.task_id}] Failed to clone project to {project_path}{error_detail}"
                logger.error(error_msg)
                raise Exception(error_msg)
        else:
            logger.info(f"Agent[{self.get_name()}][{self.task_id}] Project already exists at {project_path}, skip cloning")

    def initialize(self) -> TaskStatus:
        """
        Initialize the agent with configuration from task_data.
        This method is called after agent creation to perform any necessary initialization.
        Subclasses can override this method to implement custom initialization logic.

        Returns:
            TaskStatus: Initialization status (COMPLETED, FAILED, etc.)
        """
        logger.info(f"Agent[{self.get_name()}][{self.task_id}] initialize: No initialization steps by default.")
        return TaskStatus.SUCCESS
        
    def setup_git_config(self, user_config, project_path):
        """
        Setup git config with user information
        
        Args:
            user_config: User configuration dictionary
            project_path: Path to the git repository
        """
        git_id = user_config.get("git_id")
        git_login = user_config.get("git_login")
        git_email = user_config.get("git_email")

        if not git_email and git_id and git_login:
            git_email = f"{git_id}+{git_login}@users.noreply.github.com"

        if git_login and git_email:
            logger.info(
                f"Agent[{self.get_name()}][{self.task_id}] "
                f"Setting git config user.name='{git_login}', user.email='{git_email}'"
            )
            success, error_msg = git_util.set_git_config(project_path, git_login, git_email)
            if not success:
                logger.error(f"Agent[{self.get_name()}][{self.task_id}] Failed to set git config: {error_msg}")
        else:
            logger.warning(f"Agent[{self.get_name()}][{self.task_id}] Missing git_login or git_email, skip git config")


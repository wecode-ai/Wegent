#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import os
from collections import OrderedDict
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from executor.callback.callback_client import CallbackClient
from executor.config import config
from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.utils import git_util
from shared.utils.crypto import decrypt_git_token, is_token_encrypted

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
        self.task_type = task_data.get(
            "type"
        )  # Task type (e.g., "validation" for validation tasks)
        self.execution_status = TaskStatus.INITIALIZED
        self.project_path = None

    def handle(
        self, pre_executed: Optional[TaskStatus] = None
    ) -> Tuple[TaskStatus, Optional[str]]:
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
                logger.info(
                    f"Agent[{self.get_name()}][{self.task_id}] handle: Starting pre_execute."
                )
                pre_execute_status = self.pre_execute()
                if pre_execute_status != TaskStatus.SUCCESS:
                    error_msg = f"Agent[{self.get_name()}][{self.task_id}] handle: pre_execute failed."
                    logger.error(error_msg)
                    # Try to record error thinking
                    # self._record_error_thinking("Pre-execution failed", error_msg)
                    return TaskStatus.FAILED, error_msg
                logger.info(
                    f"Agent[{self.get_name()}][{self.task_id}] handle: pre_execute succeeded, starting execute."
                )
                self.execution_status = TaskStatus.PRE_EXECUTED
            else:
                logger.info(
                    f"Agent[{self.get_name()}][{self.task_id}] handle: Skipping pre_execute (already done)."
                )

            self.execution_status = TaskStatus.RUNNING
            result = self.execute()
            logger.info(
                f"Agent{self.get_name()}]{self.task_id}] handle: execute finished with result: {result}"
            )
            return result, None
        except Exception as e:
            error_msg = f"Agent[{self.get_name()}][{self.task_id}] handle: Exception during execute: {str(e)}"
            logger.exception(error_msg)
            # Record error thinking
            # self._record_error_thinking("Execution Exception", error_msg)
            return TaskStatus.FAILED, error_msg

    def report_progress(
        self,
        progress: int,
        status: Optional[str] = None,
        message: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Report progress to the executor_manager

        Args:
            progress: The progress percentage (0-100)
            status: Optional status string
            message: Optional message string
            result: Optional result data dictionary
        """
        logger.info(
            f"Reporting progress: {progress}%, status: {status}, message: {message}, result: {result}, task_type: {self.task_type}"
        )
        try:
            self.callback_client.send_callback(
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                task_title=self.task_title,
                subtask_title=self.subtask_title,
                progress=progress,
                status=status,
                message=message,
                result=result,
                task_type=self.task_type,
            )
        except Exception as e:
            logger.critical(
                f"[CALLBACK_FAIL] task_id={self.task_id}, progress={progress}, "
                f"status={status}, error={type(e).__name__}: {str(e)}"
            )

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution hook for tasks such as code download, environment setup, etc.
        Subclasses can override this method to implement custom pre-execution logic.

        Returns:
            TaskStatus: Execution status (COMPLETED, FAILED, etc.)
        """
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] pre_execute: No pre-execution steps by default, passing through."
        )
        return TaskStatus.SUCCESS

    def execute(self) -> TaskStatus:
        """
        Execute the agent's task

        Returns:
            TaskStatus: Execution status (SUCCESS, FAILED, COMPLETED, etc.)
        """
        raise NotImplementedError("Subclasses must implement execute()")

    def download_code(self):
        git_url = self.task_data.get("git_url", "")
        if git_url == "":
            logger.info("git url is empty, skip download code")
            return

        user_config = self.task_data.get("user")
        git_token = user_config.get("git_token")
        # Handle encrypted tokens
        if git_token and is_token_encrypted(git_token):
            logger.debug(
                f"Agent[{self.get_name()}][{self.task_id}] Decrypting git token"
            )
            git_token = decrypt_git_token(git_token)

        username = user_config.get("user_name")
        branch_name = self.task_data.get("branch_name")
        repo_name = git_util.get_repo_name_from_url(git_url)
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] start download code for git url: {git_url}, branch name: {branch_name}"
        )
        logger.info("username: {username} git token: {git_token}")
        logger.info(user_config)

        project_path = os.path.join(config.WORKSPACE_ROOT, str(self.task_id), repo_name)
        if self.project_path is None:
            self.project_path = project_path

        if not os.path.exists(project_path):
            success, error_msg = git_util.clone_repo(
                git_url, branch_name, project_path, username, git_token
            )

            if success:
                # Setup git config with user information
                self.setup_git_config(user_config, project_path)
                logger.info(
                    f"Agent[{self.get_name()}][{self.task_id}] Project cloned to {project_path}"
                )
            else:
                error_detail = f": {error_msg}" if error_msg else ""
                error_msg = f"Agent[{self.get_name()}][{self.task_id}] Failed to clone project to {project_path}{error_detail}"
                logger.error(error_msg)
                raise Exception(error_msg)
        else:
            logger.info(
                f"Agent[{self.get_name()}][{self.task_id}] Project already exists at {project_path}, skip cloning"
            )

    def initialize(self) -> TaskStatus:
        """
        Initialize the agent with configuration from task_data.
        This method is called after agent creation to perform any necessary initialization.
        Subclasses can override this method to implement custom initialization logic.

        Returns:
            TaskStatus: Initialization status (COMPLETED, FAILED, etc.)
        """
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] initialize: No initialization steps by default."
        )
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
            success, error_msg = git_util.set_git_config(
                project_path, git_login, git_email
            )
            if not success:
                logger.error(
                    f"Agent[{self.get_name()}][{self.task_id}] Failed to set git config: {error_msg}"
                )
        else:
            logger.warning(
                f"Agent[{self.get_name()}][{self.task_id}] Missing git_login or git_email, skip git config"
            )

    def _record_error_thinking(self, title: str, error_message: str) -> None:
        """
        Record error thinking for logging system errors

        Args:
            title: Error title
            error_message: Error message
        """
        try:
            # Check if thinking recording capability is available
            if hasattr(self, "add_thinking_step"):
                self.add_thinking_step(
                    title=title,
                    report_immediately=True,
                    use_i18n_keys=False,
                    details={"error_message": error_message},
                )
                logger.info(f"Recorded error thinking for {title}: {error_message}")
        except Exception as e:
            logger.error(f"Failed to record error thinking: {str(e)}")

    def _validate_file_path(self, file_path: str) -> bool:
        """
        Validate file path security

        Args:
            file_path: File path to validate

        Returns:
            bool - Whether the path is safe
        """
        # Reject absolute paths
        if os.path.isabs(file_path):
            logger.warning(f"Absolute path not allowed: {file_path}")
            return False

        # Reject paths containing '..'
        if ".." in file_path.split(os.sep):
            logger.warning(f"Path traversal detected: {file_path}")
            return False

        # Normalize path and check if it points outside the project
        normalized = os.path.normpath(file_path)
        if normalized.startswith(".."):
            logger.warning(f"Path points outside project: {file_path}")
            return False

        return True

    def _load_custom_instructions(self, project_path: str) -> Dict[str, str]:
        """
        Load custom instruction files from project root directory

        Args:
            project_path: Project root directory path

        Returns:
            Dict[file_relative_path, file_content] - Ordered dictionary of successfully loaded files
        """
        custom_rules = OrderedDict()

        # Get file list from config
        file_list = config.CUSTOM_INSTRUCTION_FILES
        logger.info(f"Loading custom instruction files from config: {file_list}")

        for file_path in file_list:
            # Strip whitespace
            file_path = file_path.strip()
            if not file_path:
                continue

            # Validate path security
            if not self._validate_file_path(file_path):
                continue

            # Construct full file path
            full_path = os.path.join(project_path, file_path)
            logger.debug(f"Checking custom instruction file: {file_path}")

            # Check if file exists
            if not os.path.exists(full_path):
                logger.debug(f"File not found, skipping: {file_path}")
                continue

            # Try to read file
            try:
                with open(full_path, "r", encoding="utf-8") as f:
                    content = f.read()
                    file_size = len(content.encode("utf-8"))
                    custom_rules[file_path] = content
                    logger.info(
                        f"Successfully loaded custom instruction file: {file_path} ({file_size} bytes)"
                    )
            except Exception as e:
                logger.warning(
                    f"Failed to read custom instruction file {file_path}: {e}"
                )
                continue

        return custom_rules

    def _update_git_exclude(
        self, project_path: str, exclude_claude_md: bool = True
    ) -> None:
        """
        Update .git/info/exclude file to exclude .claudecode directory

        Args:
            project_path: Project root directory
            exclude_claude_md: Whether to also exclude Claude.md (default True for ClaudeCode, False for Agno)
        """
        try:
            exclude_file = os.path.join(project_path, ".git", "info", "exclude")

            # Check if .git directory exists
            git_dir = os.path.join(project_path, ".git")
            if not os.path.exists(git_dir):
                logger.debug(
                    ".git directory does not exist, skipping git exclude update"
                )
                return

            # Ensure .git/info directory exists
            info_dir = os.path.join(git_dir, "info")
            os.makedirs(info_dir, exist_ok=True)

            exclude_patterns = [".claudecode/"]
            if exclude_claude_md:
                exclude_patterns.append("Claude.md")

            # Check if file exists and read content
            content = ""
            if os.path.exists(exclude_file):
                with open(exclude_file, "r", encoding="utf-8") as f:
                    content = f.read()

            # Check which patterns need to be added
            patterns_to_add = []
            for pattern in exclude_patterns:
                if pattern not in content:
                    patterns_to_add.append(pattern)

            if patterns_to_add:
                # Append patterns
                with open(exclude_file, "a", encoding="utf-8") as f:
                    if content and not content.endswith("\n"):
                        f.write("\n")
                    for pattern in patterns_to_add:
                        f.write(f"{pattern}\n")
                logger.info(
                    f"Updated .git/info/exclude to ignore: {', '.join(patterns_to_add)}"
                )
            else:
                logger.debug(f"All patterns already in {exclude_file}")

        except Exception as e:
            logger.warning(f"Failed to update .git/info/exclude: {e}")

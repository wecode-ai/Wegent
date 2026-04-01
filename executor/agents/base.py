#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import threading
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from executor.config import config
from shared.logger import setup_logger
from shared.models import EmitterBuilder, ResponsesAPIEmitter, TransportFactory
from shared.models.execution import ExecutionRequest
from shared.status import TaskStatus
from shared.utils import git_util
from shared.utils.callback_client import CallbackClient
from shared.utils.crypto import decrypt_git_token, is_token_encrypted

logger = setup_logger("agent_base")


class Agent:
    """
    Base Agent class that all specific agents should inherit from
    """

    PROGRESS_CALLBACK_TIMEOUT_SECONDS = 10.0

    def get_name(self) -> str:
        """
        Get the name of the agent. By default, returns the class name.
        Subclasses can override this method to provide a custom name.

        Returns:
            str: The name of the agent
        """
        return self.__class__.__name__

    def __init__(
        self,
        task_data: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ):
        """
        Initialize the base agent

        Args:
            task_data: The task data ExecutionRequest
            emitter: Emitter instance for sending events. Required parameter.
                     - Local mode: Use WebSocketTransport emitter
                     - Docker mode: Use CallbackTransport emitter
        """
        self.task_data = task_data
        self.callback_client = CallbackClient(callback_url=config.CALLBACK_URL)
        self.task_id = task_data.task_id
        self.subtask_id = task_data.subtask_id
        self.task_title = task_data.task_title or ""
        self.subtask_title = task_data.subtask_title or ""
        self.task_type = (
            task_data.type
        )  # Task type (e.g., "validation" for validation tasks)
        self.execution_status = TaskStatus.INITIALIZED
        self.project_path = None

        # Emitter is required and must be provided by caller
        self.emitter: ResponsesAPIEmitter = emitter
        self._progress_task_lock = threading.Lock()
        self._inflight_progress_task: Optional[asyncio.Task] = None

    def get_emitter(self) -> ResponsesAPIEmitter:
        """
        Get the emitter instance for this agent.

        Returns:
            ResponsesAPIEmitter: The emitter instance
        """
        return self.emitter

    def update_emitter(self, new_subtask_id: int) -> None:
        """
        Update the agent's emitter to use a new subtask_id.

        Called when an existing agent is reused for a new subtask (e.g., append chat).
        Rebuilds the emitter with the new subtask_id so that all subsequent
        callback events carry the correct subtask_id.

        Args:
            new_subtask_id: The new subtask ID to use for emitter events
        """
        old_subtask_id = self.subtask_id
        self.subtask_id = new_subtask_id
        self.task_data.subtask_id = new_subtask_id
        self.emitter = (
            EmitterBuilder()
            .with_task(self.task_id, new_subtask_id)
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
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] updated emitter subtask_id: "
            f"{old_subtask_id} -> {new_subtask_id}"
        )

    async def handle(
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
                pre_execute_status, pre_execute_error = await self.pre_execute()
                if pre_execute_status != TaskStatus.SUCCESS:
                    error_msg = f"Agent[{self.get_name()}][{self.task_id}] handle: pre_execute failed."
                    if pre_execute_error:
                        error_msg = f"{error_msg}\n{pre_execute_error}"
                    logger.error(error_msg)
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
            return TaskStatus.FAILED, error_msg

    def report_progress(
        self,
        progress: int,
        status: Optional[str] = None,
        message: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Report progress to the executor_manager using OpenAI Responses API format.

        Uses the emitter created during agent initialization.

        For FAILED status, sends an error event instead of in_progress event
        to ensure the frontend receives the error notification.

        Args:
            progress: The progress percentage (0-100)
            status: Optional status string (e.g., "FAILED", "RUNNING", "COMPLETED")
            message: Optional message string (used as error message for FAILED status)
            result: Optional result data dictionary
        """
        import asyncio

        logger.info(
            f"Reporting progress: {progress}%, status: {status}, message: {message}, result: {result}, task_type: {self.task_type}"
        )
        try:
            # Determine if this is a failure status
            is_failed = status == TaskStatus.FAILED.value if status else False

            async def _send_progress():
                if is_failed:
                    # Send error event for FAILED status so frontend receives the error
                    error_message = message or "Task execution failed"
                    await self.get_emitter().error(
                        error_message, code="execution_error"
                    )
                else:
                    await self.get_emitter().in_progress()

            async def _send_progress_with_timeout():
                await asyncio.wait_for(
                    _send_progress(),
                    timeout=self.PROGRESS_CALLBACK_TIMEOUT_SECONDS,
                )

            # In async context, schedule callback without blocking the event loop.
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                asyncio.run(_send_progress_with_timeout())
                return

            with self._progress_task_lock:
                inflight_task = self._inflight_progress_task
                if (
                    not is_failed
                    and inflight_task is not None
                    and not inflight_task.done()
                ):
                    logger.info(
                        f"Cancelling previous in-progress callback before sending newer progress: "
                        f"task_id={self.task_id}, progress={progress}, status={status}"
                    )
                    inflight_task.cancel()

            task = loop.create_task(_send_progress_with_timeout())
            with self._progress_task_lock:
                self._inflight_progress_task = task

            def _log_task_error(done_task: asyncio.Task) -> None:
                with self._progress_task_lock:
                    if self._inflight_progress_task is done_task:
                        self._inflight_progress_task = None

                try:
                    done_task.result()
                except asyncio.CancelledError:
                    logger.warning(
                        f"[CALLBACK_CANCELLED] task_id={self.task_id}, progress={progress}, "
                        f"status={status}"
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"[CALLBACK_TIMEOUT] task_id={self.task_id}, progress={progress}, "
                        f"status={status}, timeout={self.PROGRESS_CALLBACK_TIMEOUT_SECONDS}s"
                    )
                except Exception as task_error:
                    logger.critical(
                        f"[CALLBACK_FAIL] task_id={self.task_id}, progress={progress}, "
                        f"status={status}, error={type(task_error).__name__}: {str(task_error)}"
                    )

            task.add_done_callback(_log_task_error)
        except asyncio.TimeoutError:
            logger.warning(
                f"[CALLBACK_TIMEOUT] task_id={self.task_id}, progress={progress}, "
                f"status={status}, timeout={self.PROGRESS_CALLBACK_TIMEOUT_SECONDS}s"
            )
        except Exception as e:
            logger.critical(
                f"[CALLBACK_FAIL] task_id={self.task_id}, progress={progress}, "
                f"status={status}, error={type(e).__name__}: {str(e)}"
            )

    async def pre_execute(self) -> Tuple[TaskStatus, Optional[str]]:
        """
        Pre-execution hook for tasks such as code download, environment setup, etc.
        Subclasses can override this method to implement custom pre-execution logic.

        Returns:
            Tuple[TaskStatus, Optional[str]]: A tuple containing:
                - TaskStatus: Execution status (SUCCESS, FAILED, etc.)
                - Optional[str]: Error message if failed, None if successful
        """
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] pre_execute: No pre-execution steps by default, passing through."
        )
        return TaskStatus.SUCCESS, None

    def execute(self) -> TaskStatus:
        """
        Execute the agent's task

        Returns:
            TaskStatus: Execution status (SUCCESS, FAILED, COMPLETED, etc.)
        """
        raise NotImplementedError("Subclasses must implement execute()")

    async def download_code(self):
        # Check if git clone should be skipped (e.g., for workspace recovery from archive)
        skip_git_clone = getattr(self.task_data, "skip_git_clone", False)
        if skip_git_clone:
            logger.info(
                f"Agent[{self.get_name()}][{self.task_id}] skip_git_clone=True, "
                "workspace will be restored from archive"
            )
            # Still set project_path for later use
            git_url = self.task_data.git_url or ""
            if git_url:
                repo_name = git_util.get_repo_name_from_url(git_url)
                project_path = os.path.join(
                    config.get_workspace_root(), str(self.task_id), repo_name
                )
                if self.project_path is None:
                    self.project_path = project_path
            return

        git_url = self.task_data.git_url or ""
        if git_url == "":
            logger.info("git url is empty, skip download code")
            return

        user_config = self.task_data.user if self.task_data.user else {}
        git_token = user_config.get("git_token")
        # Handle encrypted tokens
        if git_token and is_token_encrypted(git_token):
            logger.info(
                f"Agent[{self.get_name()}][{self.task_id}] Decrypting git token"
            )
            git_token = decrypt_git_token(git_token)

        username = user_config.get("git_login") if user_config else None
        branch_name = self.task_data.branch_name
        repo_name = git_util.get_repo_name_from_url(git_url)
        logger.info(
            f"Agent[{self.get_name()}][{self.task_id}] start download code for git url: {git_url}, branch name: {branch_name}"
        )

        logger.info(user_config)

        project_path = os.path.join(
            config.get_workspace_root(), str(self.task_id), repo_name
        )
        if self.project_path is None:
            self.project_path = project_path

        if not os.path.exists(project_path):
            # Offload blocking git clone to a thread so the event loop is not blocked
            success, error_msg = await asyncio.to_thread(
                git_util.clone_repo,
                git_url,
                branch_name,
                project_path,
                username,
                git_token,
            )

            if success:
                # Setup git config with user information
                await self.setup_git_config(user_config, project_path)
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

    async def setup_git_config(self, user_config, project_path):
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
            # Offload subprocess to thread
            success, error_msg = await asyncio.to_thread(
                git_util.set_git_config, project_path, git_login, git_email
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

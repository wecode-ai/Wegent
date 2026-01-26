# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import abc
import logging
from typing import Any, Dict, Optional, Union

logger = logging.getLogger(__name__)


class Executor(abc.ABC):

    @abc.abstractmethod
    def submit_executor(
        self, task: Dict[str, Any], callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        pass

    @abc.abstractmethod
    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get the IDs of all tasks currently being executed.

        Args:
            label_selector: Optional selector to filter tasks

        Returns:
            Dict containing a list of current task IDs and related information
        """
        pass

    @abc.abstractmethod
    def delete_executor(self, pod_name: str) -> Dict[str, Any]:
        pass

    @abc.abstractmethod
    def get_executor_count(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        pass

    @abc.abstractmethod
    def get_container_status(self, executor_name: str) -> Dict[str, Any]:
        """
        Get detailed status information for a specific executor (container/pod).

        This function retrieves executor state including:
        - Whether executor exists
        - Running/Exited/etc status
        - OOMKilled flag (indicates Out Of Memory kill)
        - Exit code

        Args:
            executor_name: Name of the executor (container name or pod name)

        Returns:
            Dict with the following fields:
                - exists (bool): Whether executor exists
                - status (str): Executor status (running/exited/succeeded/failed/etc)
                - oom_killed (bool): Whether executor was killed due to OOM
                - exit_code (int): Exit code (0 = success, 137 = SIGKILL, etc)
                - error_msg (str): Error message if any
        """
        pass

    def get_executor_task_id(self, executor_name: str) -> Optional[str]:
        """
        Get task_id from executor (container/pod) label.

        Args:
            executor_name: Name of the executor (container name or pod name)

        Returns:
            task_id string if found, None otherwise
        """
        return None

    def delete_executor_by_task_id(self, task_id: str) -> Dict[str, Any]:
        """Delete executor by task_id label (fallback method).

        This is used when the executor name is not known or the executor
        was not found by name. It searches for executors with the matching
        task_id label and deletes them.

        Default implementation returns not_found. Subclasses should override.

        Args:
            task_id: Task ID to search for

        Returns:
            Dict with status and error_msg if failed
        """
        return {
            "status": "not_found",
            "error_msg": "delete_executor_by_task_id not implemented",
        }

    def register_task_for_heartbeat(
        self,
        task_id: Union[int, str],
        subtask_id: Union[int, str],
        executor_name: str,
        task_type: str = "online",
        context: str = "",
    ) -> bool:
        """Register task to RunningTaskTracker for heartbeat monitoring.

        This enables OOM detection for non-validation/sandbox tasks.
        Skips registration for validation and sandbox tasks.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            executor_name: Container/Pod name
            task_type: Task type (online, offline, validation, sandbox, etc.)
            context: Optional context for logging (e.g., "existing container")

        Returns:
            True if registered successfully, False otherwise
        """
        # Skip validation and sandbox tasks
        if task_type in ("validation", "sandbox"):
            return False

        try:
            from executor_manager.services.task_heartbeat_manager import (
                get_running_task_tracker,
            )

            tracker = get_running_task_tracker()
            tracker.add_running_task(
                task_id=task_id,
                subtask_id=subtask_id,
                executor_name=executor_name,
                task_type=task_type,
            )
            context_str = f" ({context})" if context else ""
            logger.info(
                f"Registered task {task_id} to RunningTaskTracker for heartbeat monitoring{context_str}"
            )
            return True
        except Exception as e:
            logger.warning(f"Failed to register task to RunningTaskTracker: {e}")
            return False

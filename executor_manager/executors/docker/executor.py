#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Docker executor for running tasks in Docker containers
"""

import json
import os
import subprocess
from typing import Any, Dict, Optional

from shared.logger import setup_logger
from shared.status import TaskStatus
from executor_manager.executors.base import Executor
from executor_manager.executors.docker.utils import (
    build_callback_url,
    find_available_port,
    check_container_ownership,
    delete_container,
    get_running_task_details,
)

logger = setup_logger(__name__)


class DockerExecutor(Executor):
    """Docker executor for running tasks in Docker containers"""

    def __init__(self):
        """Initialize Docker executor"""
        # Check if Docker is available
        try:
            subprocess.run(["docker", "--version"], check=True, capture_output=True)
            logger.info("Docker is available")
        except (subprocess.SubprocessError, FileNotFoundError) as e:
            logger.error(f"Docker is not available: {e}")
            raise RuntimeError("Docker is not available")

    def submit_executor(
        self, task: Dict[str, Any], callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        """
        Submit a Docker container for the given task.

        Args:
            task (Dict[str, Any]): Task information.
            callback (Optional[callable]): Optional callback function.

        Returns:
            Dict[str, Any]: Submission result.
        """
        task_id = task.get("task_id", -1)
        subtask_id = task.get("subtask_id", -1)
        user_config = task.get("user") or {}
        user_name = user_config.get("name", "unknown")

        # Generate a unique container name
        executor_name = f"task-{user_name}-{task_id}-{subtask_id}"

        # Get executor image from task or use default
        executor_image = task.get("executor_image", os.getenv("EXECUTOR_IMAGE", ""))

        if executor_image == "":
            raise ValueError("Executor image not provided")

        # Convert task to JSON string for container environment
        task_str = json.dumps(task)

        status = "success"
        progress = 30
        error_msg = ""
        callback_status = TaskStatus.RUNNING.value
        try:
            # Prepare Docker run command
            cmd = [
                "docker",
                "run",
                "-d",  # Run in detached mode
                "--name",
                executor_name,
                # Add labels for container management
                "--label",
                "owner=executor_manager",
                "--label",
                f"task_id={task_id}",
                "--label",
                f"subtask_id={subtask_id}",
                "--label",
                f"user={user_name}",
                "--label",
                f"subtask_next_id={task.get('subtask_next_id', '')}",
                "-e",
                f"TASK_INFO={task_str}",
                "-e",
                f"EXECUTOR_NAME={executor_name}",
                "-e",
                "TZ=Asia/Shanghai",
                "-e",
                "LANG=en_US.UTF-8",
                "-v",
                "/var/run/docker.sock:/var/run/docker.sock"
            ]
            executor_workspace = os.getenv("EXECUTOR_WORKSPCE", "")
            if executor_workspace:
                cmd.extend(["-v", f"{executor_workspace}:/workspace"])
            network = os.getenv("NETWORK", "")
            if network:
                cmd.extend(["--network", network])
            port = find_available_port()
            logger.info(f"Assigned port {port} for container {executor_name}")
            cmd.extend(["-p", f"{port}:{port}"])
            cmd.extend(["-e", f"PORT={port}"])

            # Add callback URL if provided
            callback_url = build_callback_url(task)
            if callback_url:
                cmd.extend(["-e", f"CALLBACK_URL={callback_url}"])

            # Add executor image at the end
            cmd.append(executor_image)

            # Execute Docker run command
            logger.info(
                f"Starting Docker container for task {task_id}: {executor_name}"
            )
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)

            # Get container ID from output
            container_id = result.stdout.strip()
            logger.info(
                f"Started Docker container {executor_name} with ID {container_id}"
            )

        except subprocess.CalledProcessError as e:
            logger.error(f"Docker run error for task {task_id}: {e.stderr}")
            status = "failed"
            progress = 100
            error_msg = f"Docker run error: {e.stderr}"
            callback_status = TaskStatus.FAILED.value
        except Exception as e:
            logger.error(f"Error creating Docker container for task {task_id}: {e}")
            status = "failed"
            progress = 100
            error_msg = f"Error: {e}"
            callback_status = TaskStatus.FAILED.value

        # Call callback if provided
        subtask_id = task.get("subtask_id", -1)
        self._call_callback(
            callback, task_id, subtask_id, executor_name, progress, callback_status
        )

        if status == "success":
            return {"status": "success", "executor_name": executor_name}
        else:
            return {
                "status": "failed",
                "error_msg": error_msg,
                "executor_name": executor_name,
            }

    def delete_executor(self, executor_name: str) -> Dict[str, Any]:
        """
        Delete a Docker container.

        Args:
            executor_name (str): Name of the container to delete.

        Returns:
            Dict[str, Any]: Deletion result.
        """
        # Check if container exists and is owned by executor_manager
        if not check_container_ownership(executor_name):
            return {
                "status": "unauthorized",
                "error_msg": f"Container '{executor_name}' is not owned by executor_manager",
            }

        # Delete the container
        return delete_container(executor_name)

    def get_executor_count(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get count of running Docker containers.

        Args:
            label_selector (Optional[str]): Label selector for filtering containers.
                                           If provided, will be used as additional filter.

        Returns:
            Dict[str, Any]: Count result.
        """
        result = get_running_task_details(label_selector)

        # Maintain backward compatibility with the API
        if result["status"] == "success":
            result["running"] = len(result.get("task_ids", []))

        return result

    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:

        return get_running_task_details(label_selector)

    def _call_callback(
        self, callback, task_id, subtask_id, executor_name, progress, status
    ):
        """
        Call the provided callback function with task information.

        Args:
            callback (callable): Callback function to call
            task_id: Task identifier
            subtask_id: Subtask identifier
            executor_name (str): Name of the executor
            progress (int): Current progress value
            status (str): Current task status
        """
        if callback:
            try:
                callback(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    executor_name=executor_name,
                    progress=progress,
                    status=status,
                )
            except Exception as e:
                logger.error(f"Error in callback for task {task_id}: {e}")

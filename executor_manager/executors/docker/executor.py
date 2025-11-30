#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Docker executor for running tasks in Docker containers
"""

from email import utils
import json
import os
import subprocess
from typing import Any, Dict, List, Optional, Tuple
import requests
import httpx

from executor_manager.config.config import EXECUTOR_ENV
from executor_manager.utils.executor_name import generate_executor_name
from shared.logger import setup_logger
from shared.status import TaskStatus
from executor_manager.executors.base import Executor
from executor_manager.executors.docker.utils import (
    build_callback_url,
    find_available_port,
    check_container_ownership,
    delete_container,
    get_container_ports,
    get_running_task_details,
)
from executor_manager.executors.docker.constants import (
    CONTAINER_OWNER,
    DEFAULT_DOCKER_HOST,
    DEFAULT_API_ENDPOINT,
    DEFAULT_TIMEZONE,
    DEFAULT_LOCALE,
    DOCKER_SOCKET_PATH,
    WORKSPACE_MOUNT_PATH,
    DEFAULT_PROGRESS_RUNNING,
    DEFAULT_PROGRESS_COMPLETE,
    DEFAULT_TASK_ID,
)

logger = setup_logger(__name__)


class DockerExecutor(Executor):
    """Docker executor for running tasks in Docker containers"""

    def __init__(self, subprocess_module=subprocess, requests_module=requests):
        """
        Initialize Docker executor with dependency injection for better testability
        
        Args:
            subprocess_module: Module for subprocess operations (default: subprocess)
            requests_module: Module for HTTP requests (default: requests)
        """
        self.subprocess = subprocess_module
        self.requests = requests_module
        
        # Check if Docker is available
        self._check_docker_availability()
    
    def _check_docker_availability(self) -> None:
        """Check if Docker is available on the system"""
        try:
            self.subprocess.run(["docker", "--version"], check=True, capture_output=True)
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
            Dict[str, Any]: Submission result with unified structure.
        """
        # Extract basic task information to avoid repeated retrieval
        task_info = self._extract_task_info(task)
        task_id = task_info["task_id"]
        subtask_id = task_info["subtask_id"]
        user_name = task_info["user_name"]
        executor_name = task_info["executor_name"]
        
        # Initialize execution status
        execution_status = {
            "status": "success",
            "progress": DEFAULT_PROGRESS_RUNNING,
            "error_msg": "",
            "callback_status": TaskStatus.RUNNING.value,
            "executor_name": executor_name
        }
        
        try:
            # Determine execution path based on whether container name exists
            if executor_name:
                self._execute_in_existing_container(task, execution_status)
            else:
                # Generate new container name
                execution_status["executor_name"] = generate_executor_name(task_id, subtask_id, user_name)

                self._create_new_container(task, task_info, execution_status)
        except Exception as e:
            # Unified exception handling
            self._handle_execution_exception(e, task_id, execution_status)
        
        # Call callback function
        self._call_callback(
            callback,
            task_id,
            subtask_id,
            execution_status["executor_name"],
            execution_status["progress"],
            execution_status["callback_status"]
        )
        
        # Return unified result structure
        return self._create_result_response(execution_status)
    
    def _extract_task_info(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """Extract basic task information"""
        task_id = task.get("task_id", DEFAULT_TASK_ID)
        subtask_id = task.get("subtask_id", DEFAULT_TASK_ID)
        user_config = task.get("user") or {}
        user_name = user_config.get("name", "unknown")
        executor_name = task.get("executor_name")
        
        return {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "user_name": user_name,
            "executor_name": executor_name
        }
    
    def _execute_in_existing_container(self, task: Dict[str, Any], status: Dict[str, Any]) -> None:
        """Execute task in existing container"""
        executor_name = status["executor_name"]
        port_info = self._get_container_port(executor_name)
        
        # Send HTTP request to container
        response = self._send_task_to_container(task, DEFAULT_DOCKER_HOST, port_info)
        
        # Process response
        if response.json()["status"] == "success":
            status["progress"] = DEFAULT_PROGRESS_COMPLETE
            status["error_msg"] = response.json().get("error_msg", "")
    
    def _get_container_port(self, executor_name: str) -> int:
        """Get container port information"""
        port_result = get_container_ports(executor_name)
        logger.info(f"Container port info: {executor_name}, {port_result}")
        
        ports = port_result.get("ports", [])
        if not ports:
            raise ValueError(f"Executor name {executor_name} not found or has no ports")
        
        return ports[0].get("host_port")
    
    def _send_task_to_container(self, task: Dict[str, Any], host: str, port: int) -> requests.Response:
        """Send task to container API endpoint"""
        endpoint = f"http://{host}:{port}{DEFAULT_API_ENDPOINT}"
        logger.info(f"Sending task to {endpoint}")
        return self.requests.post(endpoint, json=task)
    
    def _create_new_container(self, task: Dict[str, Any], task_info: Dict[str, Any], status: Dict[str, Any]) -> None:
        """Create new Docker container"""
        executor_name = status["executor_name"]
        task_id = task_info["task_id"]

        # Check for custom base_image from bot configuration
        base_image = self._get_base_image_from_task(task)

        # Get executor image
        executor_image = self._get_executor_image(task)

        # Prepare Docker command with optional base_image support
        cmd = self._prepare_docker_command(task, task_info, executor_name, executor_image, base_image)

        # Execute Docker command
        logger.info(f"Starting Docker container for task {task_id}: {executor_name} (base_image={base_image or 'default'})")

        try:
            result = self.subprocess.run(cmd, check=True, capture_output=True, text=True)

            # Record container ID
            container_id = result.stdout.strip()
            logger.info(f"Started Docker container {executor_name} with ID {container_id}")

            # For validation tasks, report starting_container stage
            if task.get("type") == "validation":
                self._report_validation_stage(
                    task,
                    stage="starting_container",
                    status="running",
                    progress=50,
                    message="Container started, running validation checks",
                )

        except subprocess.CalledProcessError as e:
            # For validation tasks, report image pull or container start failure
            if task.get("type") == "validation":
                error_msg = e.stderr or str(e)
                stage = "pulling_image" if "pull" in error_msg.lower() or "not found" in error_msg.lower() else "starting_container"
                self._report_validation_stage(
                    task,
                    stage=stage,
                    status="failed",
                    progress=100,
                    message=f"Container start failed: {error_msg}",
                    error_message=error_msg,
                    valid=False,
                )
            raise

    def _get_base_image_from_task(self, task: Dict[str, Any]) -> Optional[str]:
        """Extract custom base_image from task's bot configuration"""
        bots = task.get("bot", [])
        if bots and isinstance(bots, list) and len(bots) > 0:
            # Use the first bot's base_image if available
            first_bot = bots[0]
            if isinstance(first_bot, dict):
                return first_bot.get("base_image")
        return None
    
    def _get_executor_image(self, task: Dict[str, Any]) -> str:
        """Get executor image name"""
        executor_image = task.get("executor_image", os.getenv("EXECUTOR_IMAGE", ""))
        if not executor_image:
            raise ValueError("Executor image not provided")
        return executor_image
    
    def _prepare_docker_command(
        self,
        task: Dict[str, Any],
        task_info: Dict[str, Any],
        executor_name: str,
        executor_image: str,
        base_image: Optional[str] = None
    ) -> List[str]:
        """
        Prepare Docker run command.

        If base_image is provided, uses the Init Container pattern:
        - Uses the custom base_image as container image
        - Mounts executor binary from Named Volume
        - Overrides entrypoint to /app/executor

        Args:
            task: Task information
            task_info: Extracted task info
            executor_name: Container name
            executor_image: Default executor image
            base_image: Optional custom base image
        """
        from executors.docker.binary_extractor import EXECUTOR_BINARY_VOLUME

        task_id = task_info["task_id"]
        subtask_id = task_info["subtask_id"]
        user_name = task_info["user_name"]

        # Convert task to JSON string
        task_str = json.dumps(task)

        # Basic command
        cmd = [
            "docker",
            "run",
            "-d",  # Run in background mode
            "--name", executor_name,
            # Add labels for container management
            "--label", f"owner={CONTAINER_OWNER}",
            "--label", f"task_id={task_id}",
            "--label", f"subtask_id={subtask_id}",
            "--label", f"user={user_name}",
            "--label", f"aigc.weibo.com/team-mode={task.get('mode','default')}",
            "--label", f"aigc.weibo.com/task-type={task.get('type', 'online')}",
            "--label", f"subtask_next_id={task.get('subtask_next_id', '')}",
            # Environment variables
            "-e", f"TASK_INFO={task_str}",
            "-e", f"EXECUTOR_NAME={executor_name}",
            "-e", f"TZ={DEFAULT_TIMEZONE}",
            "-e", f"LANG={DEFAULT_LOCALE}",
            "-e", f"EXECUTOR_ENV={EXECUTOR_ENV}",
            # Mount
            "-v", f"{DOCKER_SOCKET_PATH}:{DOCKER_SOCKET_PATH}"
        ]

        # If using custom base_image, mount executor binary from Named Volume
        if base_image:
            cmd.extend([
                "-v", f"{EXECUTOR_BINARY_VOLUME}:/app:ro",  # Mount executor binary as read-only
                "--entrypoint", "/app/executor"  # Override entrypoint
            ])
            logger.info(f"Using custom base image mode: {base_image} with executor from {EXECUTOR_BINARY_VOLUME}")

        # Add TASK_API_DOMAIN environment variable for executor to access backend API
        self._add_task_api_domain(cmd)

        # Add workspace mount
        self._add_workspace_mount(cmd)

        # Add network configuration
        self._add_network_config(cmd)

        # Add port mapping
        port = find_available_port()
        logger.info(f"Assigned port {port} for container {executor_name}")
        cmd.extend(["-p", f"{port}:{port}", "-e", f"PORT={port}"])

        # Add callback URL
        self._add_callback_url(cmd, task)

        # Add executor image (use base_image if provided, otherwise use default executor_image)
        final_image = base_image if base_image else executor_image
        cmd.append(final_image)

        return cmd
    
    def _add_task_api_domain(self, cmd: List[str]) -> None:
        """Add TASK_API_DOMAIN environment variable for executor to access backend API"""
        task_api_domain = os.getenv("TASK_API_DOMAIN", "")
        if task_api_domain:
            cmd.extend(["-e", f"TASK_API_DOMAIN={task_api_domain}"])
            logger.debug(f"Added TASK_API_DOMAIN environment variable: {task_api_domain}")
    
    def _add_workspace_mount(self, cmd: List[str]) -> None:
        """Add workspace mount configuration"""
        executor_workspace = os.getenv("EXECUTOR_WORKSPACE", "")  # Fix spelling error
        if executor_workspace:
            cmd.extend(["-v", f"{executor_workspace}:{WORKSPACE_MOUNT_PATH}"])
    
    def _add_network_config(self, cmd: List[str]) -> None:
        """Add network configuration"""
        network = os.getenv("NETWORK", "")
        if network:
            cmd.extend(["--network", network])
    
    def _add_callback_url(self, cmd: List[str], task: Dict[str, Any]) -> None:
        """Add callback URL configuration"""
        callback_url = build_callback_url(task)
        if callback_url:
            cmd.extend(["-e", f"CALLBACK_URL={callback_url}"])
    
    def _handle_execution_exception(self, exception: Exception, task_id: int, status: Dict[str, Any]) -> None:
        """Handle exceptions during execution uniformly"""
        if isinstance(exception, subprocess.CalledProcessError):
            logger.error(f"Docker run error for task {task_id}: {exception.stderr}")
            error_msg = f"Docker run error: {exception.stderr}"
        else:
            logger.error(f"Error for task {task_id}: {str(exception)}")
            error_msg = f"Error: {str(exception)}"
        
        status["status"] = "failed"
        status["progress"] = DEFAULT_PROGRESS_COMPLETE
        status["error_msg"] = error_msg
        status["callback_status"] = TaskStatus.FAILED.value
    
    def _create_result_response(self, status: Dict[str, Any]) -> Dict[str, Any]:
        """Create unified return result structure"""
        result = {
            "status": status["status"],
            "executor_name": status["executor_name"]
        }
        
        if status["status"] != "success":
            result["error_msg"] = status["error_msg"]
            
        return result

    def delete_executor(self, executor_name: str) -> Dict[str, Any]:
        """
        Delete a Docker container.

        Args:
            executor_name (str): Name of the container to delete.

        Returns:
            Dict[str, Any]: Deletion result with unified structure.
        """
        try:
            # Check if container exists and is owned by executor_manager
            if not check_container_ownership(executor_name):
                return {
                    "status": "unauthorized",
                    "error_msg": f"Container '{executor_name}' is not owned by {CONTAINER_OWNER}",
                }

            # Delete container
            return delete_container(executor_name)
        except Exception as e:
            logger.error(f"Error deleting container {executor_name}: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error deleting container: {str(e)}"
            }

    def cancel_task(self, task_id: int) -> Dict[str, Any]:
        """
        Cancel a running task by calling the executor's cancel API.

        Args:
            task_id (int): Task ID to cancel.

        Returns:
            Dict[str, Any]: Cancellation result with unified structure.
        """
        try:
            # Find the container running this task
            result = get_running_task_details()

            logger.info(f"Running task details for cancellation: {result}")

            if result.get("status") != "success":
                logger.warning(f"Failed to find container for task {task_id}: {result.get('error_msg', 'Unknown error')}")
                return {
                    "status": "failed",
                    "error_msg": f"Failed to find running container for task {task_id}"
                }

            task_ids = result.get("task_ids", [])
            if str(task_id) not in task_ids:
                logger.warning(f"Task {task_id} is not currently running")
                return {
                    "status": "failed",
                    "error_msg": f"Task {task_id} is not currently running"
                }

            # Get container details
            containers = result.get("containers", [])
            container_detail = next((d for d in containers if str(d.get("task_id")) == str(task_id)), None)

            if not container_detail:
                logger.error(f"Could not find container details for task {task_id}")
                return {
                    "status": "failed",
                    "error_msg": f"Could not find container details for task {task_id}"
                }

            container_name = container_detail.get("container_name")
            if not container_name:
                logger.error(f"Could not find executor name for task {task_id}")
                return {
                    "status": "failed",
                    "error_msg": f"Could not find executor name for task {task_id}"
                }

            # Get container port
            port = self._get_container_port(container_name)
            if not port:
                logger.error(f"Could not find port for container {container_name}")
                return {
                    "status": "failed",
                    "error_msg": f"Could not find port for container {container_name}"
                }

            
            # Call the executor's cancel API
            cancel_url = f"http://{DEFAULT_DOCKER_HOST}:{port}/api/tasks/cancel?task_id={task_id}"

            # Call the executor's cancel API
            logger.info(f"Calling cancel API for task {task_id} at {cancel_url}")

            try:
                response = self.requests.post(cancel_url, timeout=10)
                response.raise_for_status()

                logger.info(f"Successfully cancelled task {task_id}")
                return {
                    "status": "success",
                    "task_ids": task_ids,
                    "containers": containers,
                    "message": f"Task {task_id} cancellation requested successfully"
                }
            except self.requests.exceptions.RequestException as e:
                logger.info(f"Failed to call cancel API for task {task_id}: {e}")
                return {
                    "status": "failed",
                    "error_msg": f"Failed to communicate with executor: {str(e)}"
                }

        except Exception as e:
            logger.info(f"Error cancelling task {task_id}: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error cancelling task: {str(e)}"
            }

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
        try:
            result = get_running_task_details(label_selector)

            # Maintain API backward compatibility
            if result["status"] == "success":
                result["running"] = len(result.get("task_ids", []))

            return result
        except Exception as e:
            logger.error(f"Error getting executor count: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error getting executor count: {str(e)}"
            }

    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get details of currently running tasks.
        
        Args:
            label_selector (Optional[str]): Label selector for filtering containers.
            
        Returns:
            Dict[str, Any]: Task details result.
        """
        try:
            return get_running_task_details(label_selector)
        except Exception as e:
            logger.error(f"Error getting current task IDs: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error getting current task IDs: {str(e)}"
            }

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
        if not callback:
            return

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

    def _report_validation_stage(
        self,
        task: Dict[str, Any],
        stage: str,
        status: str,
        progress: int,
        message: str,
        error_message: Optional[str] = None,
        valid: Optional[bool] = None,
    ) -> None:
        """
        Report validation stage progress to Backend via HTTP call.

        Args:
            task: Task data containing validation_params
            stage: Current validation stage (pulling_image, starting_container, etc.)
            status: Status (running, failed, completed)
            progress: Progress percentage (0-100)
            message: Human-readable message
            error_message: Optional error message
            valid: Optional validation result (True/False/None)
        """
        validation_params = task.get("validation_params", {})
        validation_id = validation_params.get("validation_id")

        if not validation_id:
            logger.debug("No validation_id in task, skipping stage report")
            return

        task_api_domain = os.getenv("TASK_API_DOMAIN", "http://localhost:8000")
        update_url = f"{task_api_domain}/api/shells/validation-status/{validation_id}"

        update_payload = {
            "status": "completed" if status == "failed" else stage,
            "stage": message,
            "progress": progress,
            "valid": valid,
            "errorMessage": error_message,
        }

        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(update_url, json=update_payload)
                if response.status_code == 200:
                    logger.info(f"Reported validation stage: {validation_id} -> {stage} ({progress}%)")
                else:
                    logger.warning(f"Failed to report validation stage: {response.status_code} {response.text}")
        except Exception as e:
            logger.error(f"Error reporting validation stage: {e}")

#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Preview Manager for handling preview service lifecycle in executor containers.

This module manages:
- Reading .wegent.yaml configuration from containers
- Starting/stopping dev server processes inside containers
- Monitoring service readiness
- Port proxy management
"""

import asyncio
import re
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Optional, Tuple

import yaml
from shared.logger import setup_logger

from executor_manager.executors.docker.utils import (
    check_container_ownership,
    get_host_port_for_container,
)

logger = setup_logger(__name__)


class PreviewStatus(str, Enum):
    """Preview service status enum"""

    DISABLED = "disabled"
    STARTING = "starting"
    READY = "ready"
    ERROR = "error"
    STOPPED = "stopped"


@dataclass
class PreviewConfig:
    """Preview configuration from .wegent.yaml"""

    enabled: bool = True
    start_command: str = ""
    port: int = 3000
    ready_pattern: str = "Ready"
    working_dir: str = "."
    env: Dict[str, str] = field(default_factory=dict)


@dataclass
class PreviewState:
    """Current state of a preview service"""

    task_id: int
    status: PreviewStatus = PreviewStatus.STOPPED
    config: Optional[PreviewConfig] = None
    process_pid: Optional[int] = None
    host_port: Optional[int] = None
    error: Optional[str] = None
    output_buffer: str = ""


class PreviewManager:
    """
    Manager for preview services in executor containers.

    Handles the lifecycle of dev server processes running inside Docker containers.
    """

    def __init__(self):
        self._states: Dict[int, PreviewState] = {}
        self._lock = asyncio.Lock()

    def _get_container_name(self, task_id: int) -> str:
        """Generate container name for a task"""
        return f"executor-task-{task_id}"

    def _get_preview_host_port(self, container_name: str, container_port: int) -> Optional[int]:
        """
        Get the host port mapped to the container's preview port.

        First tries to get from container label (preview_port),
        then falls back to docker port inspection.

        Args:
            container_name: Name of the Docker container
            container_port: Port number inside the container

        Returns:
            Host port number if found, None otherwise
        """
        try:
            # First try to get preview_port label
            cmd = [
                "docker",
                "inspect",
                "-f",
                "{{index .Config.Labels \"preview_port\"}}",
                container_name,
            ]
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            label_port = result.stdout.strip()
            if label_port and label_port.isdigit():
                return int(label_port)

            # Fallback: use docker port command
            return get_host_port_for_container(container_name, container_port)

        except Exception as e:
            logger.exception(f"Error getting preview host port: {e}")
            return None

    def _find_container_for_task(self, task_id: int) -> Optional[str]:
        """
        Find the running container for a task.

        Searches for containers with the task_id label.
        """
        try:
            cmd = [
                "docker",
                "ps",
                "--filter",
                f"label=task_id={task_id}",
                "--filter",
                "label=owner=executor_manager",
                "--format",
                "{{.Names}}",
            ]
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)

            containers = [c.strip() for c in result.stdout.strip().split("\n") if c.strip()]
            if containers:
                return containers[0]
            return None

        except subprocess.CalledProcessError as e:
            logger.exception(f"Error finding container for task {task_id}: {e}")
            return None

    async def get_preview_config(self, task_id: int) -> Tuple[Optional[Dict], Optional[str]]:
        """
        Read .wegent.yaml from a task's container.

        Returns: (config_dict, error_message)
        """
        container_name = self._find_container_for_task(task_id)
        if not container_name:
            return None, "Container not running for this task"

        # Try to read .wegent.yaml or .wegent.yml from container
        for filename in [".wegent.yaml", ".wegent.yml"]:
            try:
                cmd = [
                    "docker",
                    "exec",
                    container_name,
                    "cat",
                    f"/workspace/{filename}",
                ]
                result = subprocess.run(
                    cmd, check=True, capture_output=True, text=True, timeout=10
                )

                if result.stdout.strip():
                    return {"config": result.stdout}, None

            except subprocess.CalledProcessError:
                # File not found, try next
                continue
            except subprocess.TimeoutExpired:
                return None, "Timeout reading config file"
            except Exception as e:
                logger.exception(f"Error reading {filename}: {e}")
                continue

        return None, "No .wegent.yaml or .wegent.yml found in project"

    def _parse_config(self, config_content: str) -> Optional[PreviewConfig]:
        """Parse YAML config content into PreviewConfig"""
        try:
            data = yaml.safe_load(config_content)
            if not data:
                return None

            spec = data.get("spec", {})
            preview_data = spec.get("preview", {})

            if not preview_data:
                return None

            return PreviewConfig(
                enabled=preview_data.get("enabled", True),
                start_command=preview_data.get("startCommand", ""),
                port=preview_data.get("port", 3000),
                ready_pattern=preview_data.get("readyPattern", "Ready"),
                working_dir=preview_data.get("workingDir", "."),
                env=preview_data.get("env", {}),
            )

        except yaml.YAMLError as e:
            logger.exception(f"Error parsing YAML config: {e}")
            return None

    async def get_preview_status(self, task_id: int) -> Dict:
        """
        Get current preview service status for a task.

        Returns status info including whether service is running.
        """
        state = self._states.get(task_id)
        if not state:
            # Check if container exists and has preview config
            container_name = self._find_container_for_task(task_id)
            if not container_name:
                return {
                    "status": PreviewStatus.STOPPED.value,
                    "error": "Container not running",
                }

            return {
                "status": PreviewStatus.STOPPED.value,
            }

        return {
            "status": state.status.value,
            "port": state.host_port,
            "url": f"http://localhost:{state.host_port}" if state.host_port else None,
            "error": state.error,
        }

    async def start_preview(
        self, task_id: int, force: bool = False
    ) -> Dict:
        """
        Start the preview service for a task.

        This reads the .wegent.yaml config and starts the dev server
        inside the container.
        """
        async with self._lock:
            state = self._states.get(task_id)

            # If already running and not forcing restart, return current status
            if state and state.status == PreviewStatus.READY and not force:
                return {
                    "success": True,
                    "message": "Preview service already running",
                    "status": PreviewStatus.READY.value,
                    "url": f"http://localhost:{state.host_port}" if state.host_port else None,
                }

            # Find container
            container_name = self._find_container_for_task(task_id)
            if not container_name:
                return {
                    "success": False,
                    "message": "Container not running for this task",
                    "status": PreviewStatus.ERROR.value,
                }

            # Read config
            config_result, error = await self.get_preview_config(task_id)
            if error:
                return {
                    "success": False,
                    "message": error,
                    "status": PreviewStatus.ERROR.value,
                }

            config_content = config_result.get("config", "")
            preview_config = self._parse_config(config_content)

            if not preview_config or not preview_config.enabled:
                return {
                    "success": False,
                    "message": "Preview not enabled in configuration",
                    "status": PreviewStatus.DISABLED.value,
                }

            if not preview_config.start_command:
                return {
                    "success": False,
                    "message": "No start command configured",
                    "status": PreviewStatus.ERROR.value,
                }

            # Create/update state
            state = PreviewState(
                task_id=task_id,
                status=PreviewStatus.STARTING,
                config=preview_config,
            )
            self._states[task_id] = state

            # Start the dev server in background
            try:
                # Build environment variables string
                env_str = ""
                for key, value in preview_config.env.items():
                    env_str += f"export {key}='{value}' && "

                # Build the start command
                working_dir = preview_config.working_dir
                if working_dir == ".":
                    working_dir = "/workspace"
                elif not working_dir.startswith("/"):
                    working_dir = f"/workspace/{working_dir}"

                # Run command in background with nohup
                full_cmd = f"{env_str}cd {working_dir} && nohup {preview_config.start_command} > /tmp/preview.log 2>&1 &"

                cmd = [
                    "docker",
                    "exec",
                    "-d",
                    container_name,
                    "sh",
                    "-c",
                    full_cmd,
                ]

                subprocess.run(cmd, check=True, capture_output=True, timeout=30)

                # Get the host port mapped to the container's preview port
                # The port is set when container is created via -p flag and stored as label
                host_port = self._get_preview_host_port(container_name, preview_config.port)
                if not host_port:
                    logger.warning(f"Could not find host port mapping for preview port {preview_config.port}")
                    # Fallback: try to get from docker port command
                    host_port = get_host_port_for_container(container_name, preview_config.port)

                state.host_port = host_port
                state.status = PreviewStatus.STARTING

                # Schedule readiness check
                asyncio.create_task(
                    self._check_readiness(task_id, container_name, preview_config)
                )

                return {
                    "success": True,
                    "message": "Preview service starting",
                    "status": PreviewStatus.STARTING.value,
                    "url": f"http://localhost:{state.host_port}" if state.host_port else None,
                }

            except subprocess.CalledProcessError as e:
                state.status = PreviewStatus.ERROR
                state.error = str(e)
                return {
                    "success": False,
                    "message": f"Failed to start preview: {e}",
                    "status": PreviewStatus.ERROR.value,
                }
            except Exception as e:
                state.status = PreviewStatus.ERROR
                state.error = str(e)
                logger.exception(f"Error starting preview for task {task_id}: {e}")
                return {
                    "success": False,
                    "message": str(e),
                    "status": PreviewStatus.ERROR.value,
                }

    async def _check_readiness(
        self, task_id: int, container_name: str, config: PreviewConfig
    ):
        """
        Check if the dev server is ready by monitoring its output.

        Polls the log file for the ready pattern.
        """
        max_attempts = 60  # 60 seconds max wait
        attempt = 0

        while attempt < max_attempts:
            await asyncio.sleep(1)
            attempt += 1

            state = self._states.get(task_id)
            if not state or state.status not in [PreviewStatus.STARTING, PreviewStatus.READY]:
                return

            try:
                # Read log file
                cmd = [
                    "docker",
                    "exec",
                    container_name,
                    "cat",
                    "/tmp/preview.log",
                ]
                result = subprocess.run(
                    cmd, check=True, capture_output=True, text=True, timeout=5
                )

                output = result.stdout
                state.output_buffer = output[-2000:] if len(output) > 2000 else output

                # Check for ready pattern
                if re.search(config.ready_pattern, output):
                    state.status = PreviewStatus.READY
                    logger.info(f"Preview service ready for task {task_id}")
                    return

            except subprocess.CalledProcessError:
                # Log file might not exist yet
                pass
            except Exception as e:
                logger.exception(f"Error checking readiness for task {task_id}: {e}")

        # Timeout
        state = self._states.get(task_id)
        if state and state.status == PreviewStatus.STARTING:
            state.status = PreviewStatus.ERROR
            state.error = "Timeout waiting for server to be ready"
            logger.warning(f"Preview service timeout for task {task_id}")

    async def stop_preview(self, task_id: int) -> Dict:
        """
        Stop the preview service for a task.

        Kills the dev server process inside the container.
        """
        async with self._lock:
            state = self._states.get(task_id)

            container_name = self._find_container_for_task(task_id)
            if not container_name:
                if state:
                    del self._states[task_id]
                return {
                    "success": True,
                    "message": "Container not running",
                }

            try:
                # Get the config to know what process to kill
                if state and state.config:
                    port = state.config.port
                else:
                    port = 3000  # Default port

                # Kill process on the port
                cmd = [
                    "docker",
                    "exec",
                    container_name,
                    "sh",
                    "-c",
                    f"pkill -f '{port}' || true",
                ]
                subprocess.run(cmd, capture_output=True, timeout=10)

                if state:
                    state.status = PreviewStatus.STOPPED
                    state.process_pid = None

                return {
                    "success": True,
                    "message": "Preview service stopped",
                }

            except Exception as e:
                logger.exception(f"Error stopping preview for task {task_id}: {e}")
                return {
                    "success": False,
                    "message": str(e),
                }

    def cleanup_task(self, task_id: int):
        """Remove state for a task when container is stopped"""
        if task_id in self._states:
            del self._states[task_id]


# Singleton instance
preview_manager = PreviewManager()

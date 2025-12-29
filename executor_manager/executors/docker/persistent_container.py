#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Persistent container manager for long-running development environments.

This module manages persistent containers that maintain state between tasks,
allowing for faster execution and consistent development environments.
"""

import asyncio
import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional

import httpx

from shared.logger import setup_logger

from executor_manager.config.config import PORT_RANGE_MAX, PORT_RANGE_MIN
from executor_manager.executors.docker.utils import (
    find_available_port,
    get_docker_used_ports,
)

logger = setup_logger(__name__)

# Container lifecycle constants
CONTAINER_STARTUP_TIMEOUT = 300  # 5 minutes
CONTAINER_HEALTH_CHECK_INTERVAL = 10  # seconds
CONTAINER_LABEL_PREFIX = "persistent"

# Backend callback URL
BACKEND_CALLBACK_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


@dataclass
class ContainerConfig:
    """Configuration for a persistent container"""

    instance_id: int
    user_id: int
    user_name: str
    shell_name: str
    shell_type: str
    base_image: str
    repo_url: Optional[str] = None
    resources: Optional[Dict] = None
    port: int = 0
    container_id: Optional[str] = None
    container_name: Optional[str] = None


@dataclass
class ContainerState:
    """State of a persistent container"""

    instance_id: int
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    status: str = "pending"  # pending, creating, running, stopped, error
    port: int = 0
    access_url: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)
    last_used_at: Optional[datetime] = None


class PersistentContainerManager:
    """Manager for persistent development containers"""

    def __init__(self):
        self._containers: Dict[int, ContainerState] = {}
        self._lock = asyncio.Lock()

    async def create_container(self, config: ContainerConfig) -> ContainerState:
        """
        Create a new persistent container.

        Args:
            config: Container configuration

        Returns:
            ContainerState with the container status
        """
        async with self._lock:
            # Check if container already exists
            if config.instance_id in self._containers:
                existing = self._containers[config.instance_id]
                if existing.status in ("running", "creating"):
                    logger.warning(
                        f"Container for instance {config.instance_id} already exists"
                    )
                    return existing

            # Initialize state
            state = ContainerState(
                instance_id=config.instance_id,
                status="creating",
            )
            self._containers[config.instance_id] = state

        # Create container in background
        asyncio.create_task(self._create_container_async(config, state))

        return state

    async def _create_container_async(
        self, config: ContainerConfig, state: ContainerState
    ):
        """
        Asynchronously create and start a container.
        """
        try:
            # Find available port
            port = find_available_port()
            state.port = port

            # Generate container name
            container_name = f"persistent-{config.user_name}-{config.shell_name}-{config.instance_id}"
            container_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", container_name)
            state.container_name = container_name

            # Build docker run command
            cmd = self._build_docker_command(config, container_name, port)
            logger.info(f"Creating persistent container: {container_name}")
            logger.debug(f"Docker command: {' '.join(cmd)}")

            # Run docker command
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True, timeout=60
            )
            container_id = result.stdout.strip()
            state.container_id = container_id

            logger.info(f"Container created: {container_id[:12]}")

            # Wait for container to be ready
            await self._wait_for_container_ready(container_name, port)

            # Update state
            state.status = "running"
            state.access_url = f"http://localhost:{port}"
            state.last_used_at = datetime.now()

            # Callback to backend
            await self._update_backend_status(
                config.instance_id,
                status="running",
                container_id=container_id,
                access_url=state.access_url,
            )

            logger.info(
                f"Persistent container ready: {container_name} (port {port})"
            )

        except subprocess.TimeoutExpired:
            error_msg = "Container creation timed out"
            logger.error(f"Container creation failed: {error_msg}")
            state.status = "error"
            state.error_message = error_msg
            await self._update_backend_status(
                config.instance_id, status="error", error_message=error_msg
            )

        except subprocess.CalledProcessError as e:
            error_msg = f"Docker error: {e.stderr}"
            logger.error(f"Container creation failed: {error_msg}")
            state.status = "error"
            state.error_message = error_msg
            await self._update_backend_status(
                config.instance_id, status="error", error_message=error_msg
            )

        except Exception as e:
            error_msg = str(e)
            logger.exception(f"Container creation failed: {error_msg}")
            state.status = "error"
            state.error_message = error_msg
            await self._update_backend_status(
                config.instance_id, status="error", error_message=error_msg
            )

    def _build_docker_command(
        self, config: ContainerConfig, container_name: str, port: int
    ) -> list:
        """Build the docker run command"""
        # Parse resource limits
        cpu_limit = "2"
        memory_limit = "4g"
        if config.resources:
            cpu_limit = config.resources.get("cpu", "2")
            memory = config.resources.get("memory", "4Gi")
            # Convert Gi/Mi to docker format
            if memory.endswith("Gi"):
                memory_limit = f"{memory[:-2]}g"
            elif memory.endswith("Mi"):
                memory_limit = f"{memory[:-2]}m"
            else:
                memory_limit = memory

        cmd = [
            "docker",
            "run",
            "-d",
            "--name",
            container_name,
            "--label",
            "owner=executor_manager",
            "--label",
            f"{CONTAINER_LABEL_PREFIX}=true",
            "--label",
            f"instance_id={config.instance_id}",
            "--label",
            f"user_id={config.user_id}",
            "--label",
            f"user_name={config.user_name}",
            "--label",
            f"shell_name={config.shell_name}",
            "--cpus",
            cpu_limit,
            "--memory",
            memory_limit,
            "-p",
            f"{port}:8080",  # Internal API port
        ]

        # Add environment variables
        env_vars = {
            "PERSISTENT_MODE": "true",
            "INSTANCE_ID": str(config.instance_id),
            "USER_ID": str(config.user_id),
            "USER_NAME": config.user_name,
            "SHELL_TYPE": config.shell_type,
        }

        if config.repo_url:
            env_vars["REPO_URL"] = config.repo_url

        for key, value in env_vars.items():
            cmd.extend(["-e", f"{key}={value}"])

        # Add image
        cmd.append(config.base_image)

        return cmd

    async def _wait_for_container_ready(
        self, container_name: str, port: int, timeout: int = CONTAINER_STARTUP_TIMEOUT
    ):
        """Wait for container to be ready"""
        start_time = datetime.now()

        while (datetime.now() - start_time).seconds < timeout:
            # Check if container is running
            check_cmd = [
                "docker",
                "inspect",
                "-f",
                "{{.State.Running}}",
                container_name,
            ]
            try:
                result = subprocess.run(
                    check_cmd, check=True, capture_output=True, text=True
                )
                if result.stdout.strip() == "true":
                    # Container is running, check if API is ready
                    try:
                        async with httpx.AsyncClient(timeout=5.0) as client:
                            response = await client.get(
                                f"http://localhost:{port}/health"
                            )
                            if response.status_code == 200:
                                return
                    except Exception:
                        pass  # API not ready yet

            except subprocess.CalledProcessError:
                pass  # Container not ready

            await asyncio.sleep(CONTAINER_HEALTH_CHECK_INTERVAL)

        raise TimeoutError(f"Container {container_name} did not become ready in time")

    async def stop_container(self, container_id: str) -> bool:
        """Stop a persistent container"""
        try:
            cmd = ["docker", "stop", container_id]
            subprocess.run(cmd, check=True, capture_output=True, timeout=30)
            logger.info(f"Container stopped: {container_id[:12]}")
            return True
        except Exception as e:
            logger.error(f"Failed to stop container {container_id}: {e}")
            return False

    async def start_container(self, container_id: str) -> bool:
        """Start a stopped persistent container"""
        try:
            cmd = ["docker", "start", container_id]
            subprocess.run(cmd, check=True, capture_output=True, timeout=30)
            logger.info(f"Container started: {container_id[:12]}")
            return True
        except Exception as e:
            logger.error(f"Failed to start container {container_id}: {e}")
            return False

    async def delete_container(self, container_id: str) -> bool:
        """Delete a persistent container"""
        try:
            # Stop first if running
            stop_cmd = ["docker", "stop", container_id]
            subprocess.run(stop_cmd, capture_output=True, timeout=30)

            # Remove container
            rm_cmd = ["docker", "rm", container_id]
            subprocess.run(rm_cmd, check=True, capture_output=True, timeout=30)

            logger.info(f"Container deleted: {container_id[:12]}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete container {container_id}: {e}")
            return False

    async def get_container_status(self, container_id: str) -> Optional[str]:
        """Get the status of a container"""
        try:
            cmd = [
                "docker",
                "inspect",
                "-f",
                "{{.State.Status}}",
                container_id,
            ]
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True, timeout=10
            )
            return result.stdout.strip()
        except Exception as e:
            logger.error(f"Failed to get container status: {e}")
            return None

    async def list_persistent_containers(self) -> list:
        """List all persistent containers managed by this service"""
        try:
            cmd = [
                "docker",
                "ps",
                "-a",
                "--filter",
                "label=owner=executor_manager",
                "--filter",
                f"label={CONTAINER_LABEL_PREFIX}=true",
                "--format",
                "{{json .}}",
            ]
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True, timeout=30
            )

            containers = []
            for line in result.stdout.strip().split("\n"):
                if line:
                    containers.append(json.loads(line))

            return containers
        except Exception as e:
            logger.error(f"Failed to list persistent containers: {e}")
            return []

    async def _update_backend_status(
        self,
        instance_id: int,
        status: str,
        container_id: Optional[str] = None,
        access_url: Optional[str] = None,
        error_message: Optional[str] = None,
    ):
        """Update container status in backend"""
        try:
            params = {
                "instance_id": instance_id,
                "status": status,
            }
            if container_id:
                params["container_id"] = container_id
            if access_url:
                params["access_url"] = access_url
            if error_message:
                params["error_message"] = error_message

            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{BACKEND_CALLBACK_URL}/api/containers/callback",
                    params=params,
                )
                if response.status_code != 200:
                    logger.warning(
                        f"Failed to update backend status: {response.status_code}"
                    )
        except Exception as e:
            logger.warning(f"Failed to update backend status: {e}")


# Global instance
persistent_container_manager = PersistentContainerManager()
